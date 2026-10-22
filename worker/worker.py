"""City Drive GPU worker.

Runs on the RTX PRO 6000 spot VM next to a local ComfyUI. Polls the video
bucket for queued jobs (written by server.js /api/video), and for each one:

  1. downloads the job's ordered frames from gs://<bucket>/runs/<run>/
  2. for every consecutive pair, queues a first+last-frame-to-video workflow
     in ComfyUI and waits for the ~5 s clip
  3. concatenates the clips with ffmpeg
  4. uploads gs://<bucket>/jobs/<id>/drive.mp4 and marks the job done

Jobs run one at a time. One cut off by a worker restart or reboot resumes when
the worker starts again, reusing the clips it already made.

Settings (environment variables):
  VIDEO_BUCKET    required. The bucket the app writes jobs to.
  COMFY_URL       default http://127.0.0.1:8188
  WORKFLOW_DIR    default ./workflows next to this file
  WORK_DIR        default /var/lib/city-drive-worker
  COMFY_OUTPUT_DIR  default /opt/ComfyUI/output (where finished clips are looked up on resume)
  POLL_SECONDS    default 15
  IDLE_SHUTDOWN_MINUTES  default 10. Powers the VM off after this many minutes
                  with no job running or queued, which stops GPU billing (the
                  VM ends up stopped, like `gpu-vm.sh stop`). 0 disables it.
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
COMFY_OUTPUT_DIR = Path(os.environ.get("COMFY_OUTPUT_DIR", "/opt/ComfyUI/output"))
POLL_SECONDS = int(os.environ.get("POLL_SECONDS", "15"))
IDLE_SHUTDOWN_MINUTES = float(os.environ.get("IDLE_SHUTDOWN_MINUTES", "10"))
# On tmpfs, so it survives worker restarts (a crash loop can't keep the VM up
# forever) but not a reboot (a fresh boot gets a full idle window).
ACTIVITY_FILE = Path("/run/city-drive-worker/last-activity")

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
        job = json.loads(bucket.blob(f"jobs/{job_id}/job.json").download_as_text())
        if cancel_requested(job, force=True):
            set_status(job, "cancelled", finishedAt=now())
            continue
        return job
    return None


class JobCancelled(Exception):
    pass


_cancel_checked = {}


def cancel_requested(job, force=False):
    """True once the app has written jobs/<id>/cancel.json (checked at most every 10 s)."""
    if not force and time.time() - _cancel_checked.get(job["id"], 0) < 10:
        return False
    _cancel_checked[job["id"]] = time.time()
    return bucket.blob(f"jobs/{job['id']}/cancel.json").exists()


def set_status(job, state, **fields):
    status = {"state": state, "clipsTotal": len(job["segments"]), "updatedAt": now(), **fields}
    bucket.blob(f"jobs/{job['id']}/status.json").upload_from_string(
        json.dumps(status, indent=2), content_type="application/json")


# ---------- Idle shutdown ----------

def mark_active():
    ACTIVITY_FILE.parent.mkdir(parents=True, exist_ok=True)
    ACTIVITY_FILE.touch()


def idle_seconds():
    if not ACTIVITY_FILE.exists():
        mark_active()
    return time.time() - ACTIVITY_FILE.stat().st_mtime


def shutdown_if_idle():
    """Powers the VM off once it has been idle for IDLE_SHUTDOWN_MINUTES."""
    if IDLE_SHUTDOWN_MINUTES <= 0 or idle_seconds() < IDLE_SHUTDOWN_MINUTES * 60:
        return
    log(f"Idle for {IDLE_SHUTDOWN_MINUTES:g} minutes, shutting the VM down")
    # A guest shutdown leaves the GCE instance TERMINATED (stopped): no GPU or
    # vCPU billing, disk kept. `gpu-vm.sh up` starts it again.
    subprocess.run(["shutdown", "-h", "now"], check=False)
    time.sleep(300)  # wait for systemd to stop us


# ---------- ComfyUI ----------

def wait_for_comfy():
    while True:
        try:
            requests.get(f"{COMFY_URL}/system_stats", timeout=5).raise_for_status()
            return
        except requests.RequestException:
            log("Waiting for ComfyUI...")
            shutdown_if_idle()  # don't keep a GPU running if ComfyUI never comes up
            time.sleep(10)


def comfy_busy():
    """True while ComfyUI has prompts running or queued, e.g. from its web UI."""
    try:
        q = requests.get(f"{COMFY_URL}/queue", timeout=5).json()
        return bool(q.get("queue_running") or q.get("queue_pending"))
    except (requests.RequestException, ValueError):
        return False


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


def run_workflow(workflow, out_path, ui_workflow=None, job=None):
    body = {"prompt": workflow, "client_id": CLIENT_ID}
    if ui_workflow:
        # The editable graph: lets ComfyUI's queue/history open the run as a workflow tab.
        body["extra_data"] = {"extra_pnginfo": {"workflow": ui_workflow}}
    resp = requests.post(f"{COMFY_URL}/prompt", json=body, timeout=60)
    if resp.status_code != 200:
        raise RuntimeError(f"ComfyUI rejected the workflow: {resp.text[:2000]}")
    prompt_id = resp.json()["prompt_id"]

    while True:
        time.sleep(3)
        if job and cancel_requested(job):
            # Drop it if it's still waiting in ComfyUI's queue, stop it if it's running.
            requests.post(f"{COMFY_URL}/queue", json={"delete": [prompt_id]}, timeout=10)
            requests.post(f"{COMFY_URL}/interrupt", json={"prompt_id": prompt_id}, timeout=10)
            raise JobCancelled()
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
    result = subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", *inputs, "-filter_complex_script", str(script),
         "-map", "[out]", "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
         "-r", str(fps), "-movflags", "+faststart", str(out_path)],
        capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"Stitching with ffmpeg failed: {result.stderr.strip()[-800:]}")


def existing_clip(job_id, index, dest):
    """Reuses a clip made before a worker restart: our copy, or ComfyUI's own output."""
    if dest.exists() and dest.stat().st_size > 0:
        return True
    made = sorted((COMFY_OUTPUT_DIR / "city-drive" / job_id).glob(f"clip_{index:04d}_*.mp4"),
                  key=lambda p: p.stat().st_mtime)
    if made and made[-1].stat().st_size > 0:
        shutil.copyfile(made[-1], dest)
        return True
    return False


# ---------- Main ----------

def process(job):
    job_id = job["id"]
    params = job["params"]
    work = WORK_DIR / job_id
    (work / "frames").mkdir(parents=True, exist_ok=True)
    (work / "clips").mkdir(exist_ok=True)
    workflow_template = json.loads((WORKFLOW_DIR / f"{job['workflow']}.json").read_text())
    # Optional UI-format twin (scripts/workflow-ui.mjs) with the same placeholders.
    ui_path = WORKFLOW_DIR / f"{job['workflow']}.ui.json"
    ui_template = json.loads(ui_path.read_text()) if ui_path.exists() else None
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
        if cancel_requested(job, force=True):
            raise JobCancelled()
        set_status(job, "running", step="generating clips", clipsDone=seg["index"])
        started = time.time()
        values = {
            "PROMPT": seg.get("prompt", job["prompt"]),
            "NEGATIVE_PROMPT": job.get("negativePrompt", ""),
            "FIRST_IMAGE": comfy_names[seg["first"]],
            "LAST_IMAGE": comfy_names[seg["last"]],
            "WIDTH": params["width"],
            "HEIGHT": params["height"],
            "FRAMES": params["frames"],
            "FPS": params["fps"],
            "SEED": params["seed"] + seg["index"],
            "OUTPUT_PREFIX": f"city-drive/{job_id}/clip_{seg['index']:04d}",
        }
        ui_workflow = fill_template(ui_template, values) if ui_template else None
        clip = work / "clips" / f"clip_{seg['index']:04d}.mp4"
        if existing_clip(job_id, seg["index"], clip):
            log(f"Job {job_id}: clip {seg['index'] + 1}/{total} already made, reusing it")
            clips.append(clip)
            continue
        run_workflow(fill_template(workflow_template, values), clip, ui_workflow, job)
        clips.append(clip)
        log(f"Job {job_id}: clip {seg['index'] + 1}/{total} in {time.time() - started:.0f}s")

    set_status(job, "running", step="stitching", clipsDone=total)
    final = work / "drive.mp4"
    concat_clips(clips, params["fps"], final)
    set_status(job, "running", step="uploading", clipsDone=total)
    bucket.blob(job["output"]).upload_from_filename(str(final), content_type="video/mp4")
    set_status(job, "done", clipsDone=total, video=job["output"], finishedAt=now())
    log(f"Job {job_id}: done, gs://{BUCKET}/{job['output']}")
    shutil.rmtree(work, ignore_errors=True)


def main():
    WORK_DIR.mkdir(parents=True, exist_ok=True)
    idle_seconds()  # starts the idle clock if this is the first run since boot
    wait_for_comfy()
    idle = f"shutting down after {IDLE_SHUTDOWN_MINUTES:g} idle minutes" if IDLE_SHUTDOWN_MINUTES > 0 \
        else "idle shutdown off"
    resume_interrupted_jobs()
    log(f"Polling gs://{BUCKET}/queue/ every {POLL_SECONDS}s, {idle}")
    while True:
        job = claim_next_job()
        if not job:
            if comfy_busy():
                mark_active()  # someone is running a workflow by hand in ComfyUI's UI
            shutdown_if_idle()
            time.sleep(POLL_SECONDS)
            continue
        run_job(job)


def run_job(job):
    mark_active()
    try:
        process(job)
    except JobCancelled:
        log(f"Job {job['id']} cancelled")
        set_status(job, "cancelled", finishedAt=now())
        shutil.rmtree(WORK_DIR / job["id"], ignore_errors=True)
    except Exception as err:  # report it on the job (the app shows it) and move on
        log(f"Job {job['id']} failed: {err}")
        set_status(job, "failed", error=str(err)[:1000], finishedAt=now())
    mark_active()  # the idle clock starts when the job ends


def resume_interrupted_jobs():
    """Finishes jobs a worker restart (e.g. gpu-vm.sh push) or a reboot cut off.
    Their work dirs survive on disk; clips already made are reused, not redone."""
    for work in sorted(p for p in WORK_DIR.iterdir() if p.is_dir()):
        status_blob = bucket.blob(f"jobs/{work.name}/status.json")
        if not status_blob.exists():
            continue
        state = json.loads(status_blob.download_as_text()).get("state")
        if state != "running":
            shutil.rmtree(work, ignore_errors=True)  # finished, failed or cancelled
            continue
        job = json.loads(bucket.blob(f"jobs/{work.name}/job.json").download_as_text())
        log(f"Job {job['id']}: resuming after a worker restart")
        run_job(job)


if __name__ == "__main__":
    main()
