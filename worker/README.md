# GPU video worker

Turns a saved drive (a sequence of Street View frames) into one video: a ~5 s
AI-generated clip between each pair of consecutive frames, stitched together.
It runs on a Google Cloud **spot VM with an NVIDIA RTX PRO 6000** (96 GB, G4
machine series) next to a local **ComfyUI**.

## How it fits together

```
 browser ──> Cloud Run app (server.js)                     GPU spot VM
              │  Save frames: frames + manifest ──┐         ┌──────────────────────────┐
              │  Make video:  job doc + queue ────┤         │ worker.py                │
              │  status / video  <────────────────┤         │  polls queue/            │
              ▼                                   ▼         │  pulls frames            │
                             gs://<project>-city-drive-video│  ComfyUI: 1 clip per pair│
                               runs/<run>/frame_0001.jpg…   │  ffmpeg: stitch          │
                               runs/<run>/manifest.json     │  uploads drive.mp4       │
                               queue/<id>.json   <──────────┤                          │
                               jobs/<id>/job.json           └──────────────────────────┘
                               jobs/<id>/status.json
                               jobs/<id>/drive.mp4
```

Cloud Storage is the only shared state. There is no database: the job doc is a
JSON file, and the queue is a folder of marker files that the worker deletes when
it claims a job.

### The job doc (`jobs/<id>/job.json`)

Written by `createVideoJob()` in `server.js`:

```json
{
  "version": 1,
  "id": "20261021223443-8d5d2d",
  "run": "2026-10-21T22-34-43-526Z_2014",
  "workflow": "minimax_h3_flf2v_turbo",
  "prompt": "Dashcam footage from a car driving smoothly forward…",
  "negativePrompt": "static, frozen, camera shake…",
  "params": { "width": 768, "height": 768, "frames": 124, "fps": 24, "seed": 1178908316 },
  "images": ["runs/<run>/frame_0001.jpg", "runs/<run>/frame_0002.jpg", "…"],
  "segments": [
    { "index": 0, "first": "runs/<run>/frame_0001.jpg", "last": "runs/<run>/frame_0002.jpg" },
    { "index": 1, "first": "runs/<run>/frame_0002.jpg", "last": "runs/<run>/frame_0003.jpg" }
  ],
  "output": "jobs/<id>/drive.mp4"
}
```

`status.json` goes `queued` → `running` (with `step` and `clipsDone`/`clipsTotal`)
→ `done` or `failed` (with `error`). The app polls it and plays the video when done.

### Per job, the worker

1. downloads `images` and uploads them to ComfyUI,
2. for each segment, fills the workflow template (`workflows/<workflow>.json`) with
   the two frames, prompt, size, frame count and seed, queues it, and downloads the clip,
3. concatenates the clips with ffmpeg, trimming the first frame of every clip after
   the first (it's the same image the previous clip ended on),
4. uploads `drive.mp4` and marks the job done.

Jobs run one at a time. **No failure tolerance (v1):** a job's queue marker is deleted
when the worker claims it, so if the spot VM is preempted mid-job that job stays
`running` forever and has to be resubmitted from the app.

## The model

Default: **MiniMax H3** (Hailuo 3.0), using ComfyUI's native `MiniMaxH3ImageToVideo`
node with both `first_frame` and `last_frame` connected (H3's "fl2va" mode). The
workflow mirrors ComfyUI's own `video_minimax_h3_i2v` template, with the same model
files from [Comfy-Org/MiniMax-H3](https://huggingface.co/Comfy-Org/MiniMax-H3):

| File | Folder | Size |
| --- | --- | --- |
| `minimax_h3_fl2va_pruned_int8_convrot.safetensors` | `diffusion_models` | 19.5 GB |
| `qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors` | `text_encoders` | 14.6 GB |
| `minimax_h3_video_vae_int8_convrot.safetensors` | `vae` | 2.6 GB |
| `minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors` ([lightx2v](https://huggingface.co/lightx2v/Minimax-h3-Turbo)) | `loras` | 1.8 GB |

| Workflow | Steps | Notes |
| --- | --- | --- |
| `minimax_h3_flf2v_turbo` (default) | 8 | Adds the lightx2v 8-step turbo LoRA. Much faster per clip |
| `minimax_h3_flf2v` | 20 | The template's stock settings (`res_multistep`, simple schedule) |
| `wan22_flf2v_fast` | 4 | Wan 2.2 14B + lightx2v 4-step LoRAs. Needs `install-wan=true` VM metadata |
| `wan22_flf2v` | 20 | Wan 2.2 14B, stock two-pass setup |

H3 clips are 124 frames at 24 fps (~5.2 s; H3 frame counts sit on a 17k+5 grid) on
H3's native canvas: 768 px short edge, so the 640×640 Street View frames are
generated at 768×768. H3 also generates an audio track; the worker only decodes
video for now. Choose a different default with `VIDEO_WORKFLOW` on the app, or per
job with `"params": {"workflow": "<name>"}` on `/api/video`.

**License:** H3's open weights ship under MiniMax's community license, which is
reported to leave the US, EU, UK and South Korea out of the self-hosting grant unless
MiniMax gives written permission. Read it on the model card and make sure your use is
covered. The Wan 2.2 workflows (Apache 2.0) are the fallback.

### Adding another model

1. Get its files onto the VM (add `fetch` lines to `vm-startup.sh`) and build its
   first+last-frame workflow in the ComfyUI UI.
2. **Export (API)** it to JSON and replace the values the worker should fill with
   these placeholder strings: `{{FIRST_IMAGE}}`, `{{LAST_IMAGE}}` (the two `LoadImage`
   nodes), `{{PROMPT}}`, `{{NEGATIVE_PROMPT}}`, `{{WIDTH}}`, `{{HEIGHT}}`, `{{FRAMES}}`,
   `{{FPS}}`, `{{SEED}}`, and `{{OUTPUT_PREFIX}}` (the save node's filename prefix). The
   workflow must end in a node that saves an `.mp4`/`.webm` (e.g. `SaveVideo`).
3. Save it as `worker/workflows/<name>.json`, add it to `WORKFLOWS` in `server.js`
   (frame count, fps, canvas size), and run `./scripts/gpu-vm.sh push`.

## Running it

Once per project, `scripts/gcp-setup.sh` (see [DEPLOY.md](../DEPLOY.md)) creates the
bucket, gives the app and the `city-drive-gpu-worker` service account access to it,
and sets the `GCP_VIDEO_BUCKET` repo variable so the deployed app shows the video step.

You'll most likely also need **GPU quota**: new projects usually have 0 spot RTX PRO
6000 GPUs. Request it under IAM & Admin > Quotas (search for "RTX PRO 6000" and the
preemptible/spot variant in your region) before the first `up`.

```bash
PROJECT_ID=city-drive-123456 ./scripts/gpu-vm.sh up     # create or start the VM
PROJECT_ID=city-drive-123456 ./scripts/gpu-vm.sh logs   # watch setup, then the worker
PROJECT_ID=city-drive-123456 ./scripts/gpu-vm.sh push   # after changing worker code/workflows
PROJECT_ID=city-drive-123456 ./scripts/gpu-vm.sh stop   # stop paying for the GPU
```

The first boot installs the NVIDIA driver (Google's installer, one automatic reboot),
ComfyUI with a CUDA 13 PyTorch build, and ~38 GB of MiniMax H3 weights from
Hugging Face. Allow 20–30 minutes. Later boots reuse the disk and start in a couple
of minutes. When Google reclaims the spot VM it is **stopped**, not deleted; run `up`
again to bring it back.

The VM costs money while it runs, so it **stops itself when idle**: once no job has
run or been queued for 10 minutes, the worker powers it off. That leaves it in the
same stopped state as `gpu-vm.sh stop` (no GPU billing, disk and models kept), and
`up` brings it back in a couple of minutes. Change the window with
`IDLE_SHUTDOWN_MINUTES=30 ./scripts/gpu-vm.sh up`, or set it to `0` to keep the VM
running until you stop it. The window applies from boot too, so a VM whose setup or
ComfyUI never comes up still stops once the worker is running. It does not cover a
first boot that fails before the worker is installed; check `logs` then.

Once the VM exists, **the app starts it for you**: queueing a video starts a stopped
VM, and the video step has Start/Stop buttons with the VM's current state. That
needs the `cityDriveGpuControl` role `gcp-setup.sh` grants the app's runtime service
account (re-run the setup script if you set up before this existed). Creating the VM,
`push` and `logs` still go through `gpu-vm.sh`. Locally, set `GCP_PROJECT_ID` in
`.env`; your gcloud login needs the same start/stop permissions.

To run the app locally against the bucket, set `VIDEO_BUCKET` in `.env`; the server
uses your `gcloud auth login` credentials for Cloud Storage.

## Timing and cost

Every pair of frames is one clip, so a 200-frame drive is 199 clips and about
17 minutes of video. Use **"Use every Nth frame"** in the app to make fewer, longer
jumps; the video model fills in the motion between them. Generation time per clip
depends on the workflow and size; measure it on the first job (the worker logs
seconds per clip) and size your drives from that.
