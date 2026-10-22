# GPU video worker

Turns a saved drive (a sequence of Street View frames) into one video: a short
(5 s by default)
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
  "prompt": "The car drives steadily forward in its lane…",
  "negativePrompt": "static, frozen, camera shake…",
  "params": { "width": 768, "height": 768, "frames": 124, "fps": 24, "seed": 1178908316 },
  "images": ["runs/<run>/frame_0001.jpg", "runs/<run>/frame_0002.jpg", "…"],
  "segments": [
    { "index": 0, "first": "runs/<run>/frame_0001.jpg", "last": "runs/<run>/frame_0002.jpg",
      "prompt": "How the reference pictures align with the target video — Picture 1 …" },
    { "index": 1, "first": "runs/<run>/frame_0002.jpg", "last": "runs/<run>/frame_0003.jpg",
      "prompt": "…" }
  ],
  "output": "jobs/<id>/drive.mp4"
}
```

`prompt` is the user's description of the drive. Each segment carries the full prompt
for its clip, built by [`prompts.js`](../prompts.js) (see [Prompts](#prompts) below);
the worker falls back to the job's `prompt` when a segment has none.

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

Clip length is set per run with **"Seconds per clip"** in the app (1–15 s, default 5;
`clipSeconds` on `/api/video`). The app turns it into the nearest frame count the model
accepts and writes it to `params.frames` in job.json, which the worker passes to the
workflow's `{{FRAMES}}`. At the default, H3 clips are 124 frames at 24 fps (~5.2 s;
H3 frame counts sit on a 17k+5 grid) and Wan 2.2 clips are 81 frames at 16 fps. Both
models were trained around 5 s, so much longer clips may drift or loop and take
proportionally longer to generate. Clips render on
H3's native canvas: 768 px short edge, so the 640×640 Street View frames are
generated at 768×768. H3 also generates an audio track; the worker only decodes
video for now. Choose a different default with `VIDEO_WORKFLOW` on the app, or per
job with `"params": {"workflow": "<name>"}` on `/api/video`.

**License:** H3's open weights ship under MiniMax's community license, which is
reported to leave the US, EU, UK and South Korea out of the self-hosting grant unless
MiniMax gives written permission. Read it on the model card and make sure your use is
covered. The Wan 2.2 workflows (Apache 2.0) are the fallback.

### Prompts

H3 is trained on a fixed prompt structure per input mode, which MiniMax publishes as
the [h3-prompt-writing skill](https://github.com/MiniMax-AI/MiniMax-H3/tree/main/skills/h3-prompt-writing)
(the FL2VA rules are in
[`references/base-en.txt`](https://github.com/MiniMax-AI/MiniMax-H3/blob/main/skills/h3-prompt-writing/references/base-en.txt)).
For first+last-frame clips that is:

```text
How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot 1) aligns with the 5.17-second mark of the target video.

integrated_multimodal_description: [Shot 1] Live-action, a forward-facing POV shot from the driver's seat begins on the street exactly as shown in Picture 1, … The camera pushes in at a steady speed and pans left with small amplitude as the road bends to the left, … settles into the position, framing and composition established by Picture 2 at the end of the shot.

overall_soundscape: A steady engine hum and the soft roll of tires on asphalt …

non_diegetic_music: N/A
```

What `prompts.js` follows from the guide:

- The alignment line comes first, verbatim, with the clip's length (frames / fps) as
  the Picture 2 time. ComfyUI's `MiniMaxH3ImageToVideo` node already prefixes the
  two images as `<Picture 1>:` / `<Picture 2>:`, so the prompt refers to them by name.
- FL2VA favors one continuous shot, described as the path from the first frame to
  the last, ending on Picture 2, rather than two static image descriptions.
- Camera motion uses the guide's vocabulary (`Push In`, `Pan Left/Right`, amplitude,
  speed) written as a sentence. Each clip gets a forward push, plus a pan when the
  heading changes by 15° or more between its two frames.
- `overall_soundscape` and `non_diegetic_music` are required fields. H3 also
  generates audio, which the worker currently drops.
- H3 has no negative prompt (the workflow uses `BasicGuider`, no CFG), so
  `negativePrompt` only reaches the Wan 2.2 workflows, which get a short plain
  caption instead.

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
PROJECT_ID=city-drive-123456 ./scripts/gpu-vm.sh tunnel # ComfyUI at http://localhost:8188 without the app
PROJECT_ID=city-drive-123456 ./scripts/gpu-vm.sh stop   # stop paying for the GPU
```

The VM boots from an image that already has the NVIDIA driver: `gpu-vm.sh` picks the
first family in its `IMAGE_CANDIDATES` list that exists (Deep Learning VM, then Ubuntu
accelerator images), and falls back to plain Ubuntu 22.04 with Google's driver
installer. Building the driver on the stock Ubuntu 24.04 image fails on its newer
kernels. Override with `IMAGE_PROJECT` + `IMAGE_FAMILY`. The first boot then installs
ComfyUI (Python 3.12 via uv, CUDA 13 PyTorch, or 12.8 on a pre-580 driver) and ~38 GB
of MiniMax H3 weights from Hugging Face. Allow 20–30 minutes. Later boots reuse the disk and start in a couple
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
VM, and a GPU worker panel at the top of the app shows the VM's state, how long it
has been up, a rough cost so far (set `GPU_VM_HOURLY_USD` to your spot price), and
Start/Stop buttons. That
needs the `cityDriveGpuControl` role `gcp-setup.sh` grants the app's runtime service
account (re-run the setup script if you set up before this existed). Creating the VM,
`push` and `logs` still go through `gpu-vm.sh`. Locally, set `GCP_PROJECT_ID` in
`.env`; your gcloud login needs the same start/stop permissions.

### Opening ComfyUI for debugging

While the VM is running, the **ComfyUI** button in the app's video step opens
ComfyUI's own web UI in a new tab (the app proxies `/comfy/` to the VM's port 8188).
You can load a workflow from `worker/workflows/`, watch the worker's jobs in the queue,
and run things by hand. Prompts you queue there keep the VM from idling off.

How it's wired: the Cloud Run service uses Direct VPC egress on the `default` network
(`deploy.yml`), and `gpu-vm.sh up` adds the `city-drive-comfyui` firewall rule
(tcp:8188 from the region's default subnet) and tags the VM for it. ComfyUI has no
login of its own; it is only reachable through the app, which Cloud Run keeps private.
Keep the app private if you use this, since anyone who can open the app can drive
ComfyUI. If you set up before this existed, re-run `gcp-setup.sh` (the deployer needs
`roles/compute.networkViewer`) and `gpu-vm.sh up` (firewall, tag, ComfyUI listening
on the VPC), then redeploy.

Without the app, `PROJECT_ID=... ./scripts/gpu-vm.sh tunnel` forwards ComfyUI over
SSH to http://localhost:8188. To use the tunnel from a locally running app, set
`COMFY_URL=http://localhost:8188` in `.env`; the button then always goes there.

To run the app locally against the bucket, set `VIDEO_BUCKET` in `.env`; the server
uses your `gcloud auth login` credentials for Cloud Storage.

## Timing and cost

Every pair of frames is one clip, so a 200-frame drive is 199 clips and about
17 minutes of video at 5 s per clip. Use **"Use every Nth frame"** in the app to make fewer, longer
jumps; the video model fills in the motion between them. Generation time per clip
depends on the workflow and size; measure it on the first job (the worker logs
seconds per clip) and size your drives from that.
