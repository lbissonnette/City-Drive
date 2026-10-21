"""City Drive GPU worker.

Runs on the RTX PRO 6000 spot VM next to a local ComfyUI. Polls the video
bucket for queued jobs (written by server.js /api/video), and for each one:

  1. downloads the job's ordered frames from gs://<bucket>/runs/<run>/
  2. for every consecutive pair, queues a first+last-frame-to-video workflow
     in ComfyUI and waits for the ~5 s clip
  3. concatenates the clips with ffmpeg
  4. uploads gs://<bucket>/jobs/<id>/drive.mp4 and marks the job done

v1 has no failure tolerance: jobs run one at a time, and if the VM is
preempted the job in progress is lost (its queue marker is deleted on claim).

Settings (environment variables):
  VIDEO_BUCKET    required. The bucket the app writes jobs to.
  COMFY_URL       default http://127.0.0.1:8188
  WORKFLOW_DIR    default ./workflows next to this file
  WORK_DIR        default /var/lib/city-drive-worker
  POLL_SECONDS    default 15
"""

import json
import os
import shutil
import subprocess
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

import requests
from google.cloud import storage

BUCKET = os.environ.get("VIDEO_BUCKET") or sys.exit("VIDEO_BUCKET is not set")
COMFY_URL = os.environ.get("COMFY_URL", "http://127.0.0.1:8188").rstrip("/")
WORKFLOW_DIR = Path(os.environ.get("WORKFLOW_DIR", Path(__file__).parent / "workflows"))
WORK_DIR = Path(os.environ.get("WORK_DIR", "/var/lib/city-drive-worker"))
POLL_SECONDS = int(os.environ.get("POLL_SECONDS", "15"))

CLIENT_ID = str(uuid.uuid4())
bucket = storage.Client().bucket(BUCKET)


def log(msg):
    print(f"{datetime.now(timezone.utc):%Y-%m-%d %H:%M:%S} {msg}", flush=True)


def now():
    return datetime.now(timezone.utc).isoformat()


# ---------- Job queue (GCS) ----------

def claim_next_job():
    """Returns the oldest queued job doc, deleting its queue marker, or None."""
    markers = sorted(bucket.list_blobs(prefix="queue/"), key=lambda b: b.name)
    for marker in markers:
        if not marker.name.endswith(".json"):
            continue
        job_id = Path(marker.name).stem
        marker.delete()
        return json.loads(bucket.blob(f"jobs/{job_id}/job.json").download_as_text())
    return None


def set_status(job, state, **fields):
    status = {"state": state, "clipsTotal": len(job["segments"]), "updatedAt": now(), **fields}
    bucket.blob(f"jobs/{job['id']}/status.json").upload_from_string(
        json.dumps(status, indent=2), content_type="application/json")


# ---------- ComfyUI ----------

def wait_for_comfy():
    while True:
        try:
            requests.get(f"{COMFY_URL}/system_stats", timeout=5).raise_for_status()
            return
        except requests.RequestException:
            log("Waiting for ComfyUI...")
            time.sleep(10)


def upload_image(path, name):
    with open(path, "rb") as f:
        resp = requests.post(f"{COMFY_URL}/upload/image",
                             files={"image": (name, f, "image/jpeg")},
                             data={"overwrite": "true"}, timeout=60)
    resp.raise_for_status()
    info = resp.json()
    return f"{info['subfolder']}/{info['name']}" if info.get("subfolder") else info["name"]


def fill_template(node, values):
    """Replaces "{{KEY}}" strings anywhere in the workflow with typed values."""
    if isinstance(node, dict):
        return {k: fill_template(v, values) for k, v in node.items()}
    if isinstance(node, list):
        return [fill_template(v, values) for v in node]
    if isinstance(node, str) and node.startswith("{{") and node.endswith("}}"):
        key = node[2:-2]
        if key not in values:
            raise KeyError(f"Workflow placeholder {node} has no value")
        return values[key]
    return node


def run_workflow(workflow, out_path):
    resp = requests.post(f"{COMFY_URL}/prompt",
                         json={"prompt": workflow, "client_id": CLIENT_ID}, timeout=60)
    if resp.status_code != 200:
        raise RuntimeError(f"ComfyUI rejected the workflow: {resp.text[:2000]}")
    prompt_id = resp.json()["prompt_id"]

    while True:
        time.sleep(3)
        history = requests.get(f"{COMFY_URL}/history/{prompt_id}", timeout=30).json()
        entry = history.get(prompt_id)
        if not entry:
            continue
        status = entry.get("status", {})
        if status.get("status_str") == "error":
            raise RuntimeError(f"ComfyUI workflow failed: {json.dumps(status.get('messages'))[:2000]}")
        if status.get("completed") or entry.get("outputs"):
            break

    # SaveVideo reports its file under an "images" (or "videos") list.
    for output in entry["outputs"].values():
        for items in output.values():
            for item in items if isinstance(items, list) else []:
                if isinstance(item, dict) and str(item.get("filename", "")).endswith((".mp4", ".webm", ".mov")):
                    params = {k: item.get(k, "") for k in ("filename", "subfolder", "type")}
                    with requests.get(f"{COMFY_URL}/view", params=params, stream=True, timeout=300) as r:
                        r.raise_for_status()
                        with open(out_path, "wb") as f:
                            shutil.copyfileobj(r.raw, f)
                    return
    raise RuntimeError(f"No video in ComfyUI outputs: {json.dumps(entry['outputs'])[:2000]}")


# ---------- Stitching ----------

def concat_clips(clips, fps, out_path):
    """Joins the clips. Each clip after the first starts on the frame the
    previous one ended on, so that duplicate first frame is trimmed off."""
    inputs, filters = [], []
    for i, clip in enumerate(clips):
        inputs += ["-i", str(clip)]
        filters.append(f"[{i}:v]trim=start_frame={0 if i == 0 else 1},setpts=PTS-STARTPTS[v{i}]")
    graph = ";".join(filters) + ";" + "".join(f"[v{i}]" for i in range(len(clips))) \
        + f"concat=n={len(clips)}:v=1:a=0[out]"
    script = out_path.with_suffix(".filter")
    script.write_text(graph)  # a file, since hundreds of clips overflow the command line
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", *inputs, "-filter_complex_script", str(script),
         "-map", "[out]", "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
         "-r", str(fps), "-movflags", "+faststart", str(out_path)],
        check=True)


# ---------- Main ----------

def process(job):
    job_id = job["id"]
    params = job["params"]
    work = WORK_DIR / job_id
    (work / "frames").mkdir(parents=True, exist_ok=True)
    (work / "clips").mkdir(exist_ok=True)
    workflow_template = json.loads((WORKFLOW_DIR / f"{job['workflow']}.json").read_text())
    total = len(job["segments"])
    log(f"Job {job_id}: {total} clips from run {job['run']} with {job['workflow']}")

    set_status(job, "running", step="downloading frames", clipsDone=0, startedAt=now())
    comfy_names = {}
    for i, name in enumerate(job["images"]):
        local = work / "frames" / f"{i:04d}.jpg"
        bucket.blob(name).download_to_filename(str(local))
        comfy_names[name] = upload_image(local, f"{job_id}_{i:04d}.jpg")

    clips = []
    for seg in job["segments"]:
        set_status(job, "running", step="generating clips", clipsDone=seg["index"])
        started = time.time()
        workflow = fill_template(workflow_template, {
            "PROMPT": job["prompt"],
            "NEGATIVE_PROMPT": job.get("negativePrompt", ""),
            "FIRST_IMAGE": comfy_names[seg["first"]],
            "LAST_IMAGE": comfy_names[seg["last"]],
            "WIDTH": params["width"],
            "HEIGHT": params["height"],
            "FRAMES": params["frames"],
            "FPS": params["fps"],
            "SEED": params["seed"] + seg["index"],
            "OUTPUT_PREFIX": f"city-drive/{job_id}/clip_{seg['index']:04d}",
        })
        clip = work / "clips" / f"clip_{seg['index']:04d}.mp4"
        run_workflow(workflow, clip)
        clips.append(clip)
        log(f"Job {job_id}: clip {seg['index'] + 1}/{total} in {time.time() - started:.0f}s")

    set_status(job, "running", step="stitching", clipsDone=total)
    final = work / "drive.mp4"
    concat_clips(clips, params["fps"], final)
    bucket.blob(job["output"]).upload_from_filename(str(final), content_type="video/mp4")
    set_status(job, "done", clipsDone=total, video=job["output"], finishedAt=now())
    log(f"Job {job_id}: done, gs://{BUCKET}/{job['output']}")
    shutil.rmtree(work, ignore_errors=True)


def main():
    WORK_DIR.mkdir(parents=True, exist_ok=True)
    wait_for_comfy()
    log(f"Polling gs://{BUCKET}/queue/ every {POLL_SECONDS}s")
    while True:
        job = claim_next_job()
        if not job:
            time.sleep(POLL_SECONDS)
            continue
        try:
            process(job)
        except Exception as err:  # v1: report and move on to the next job
            log(f"Job {job['id']} failed: {err}")
            set_status(job, "failed", error=str(err)[:1000], finishedAt=now())


if __name__ == "__main__":
    main()
