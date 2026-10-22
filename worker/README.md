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
→ `done`, `failed` (with `error`) or `cancelled`. The app polls it and plays the video
when done. Its **Recent videos** list (`GET /api/videos`) reads the newest jobs from the
bucket, so a job can be reopened after the page was closed.

**Restarts:** a job that a worker restart (`gpu-vm.sh push`) or reboot cuts off is
picked up again when the worker starts. Its work dir is still on disk, and clips
already made (in that dir or in ComfyUI's `output/city-drive/<id>/`) are reused rather
than regenerated. A failure while stitching or uploading marks the job `failed` with
ffmpeg's error, which the app shows.

**Cancelling** (`POST /api/video/<id>/cancel`, the Cancel button in that list) writes
`jobs/<id>/cancel.json`. A queued job also loses its queue marker and is marked
`cancelled` at once. For a running job, the worker checks for the flag before each clip
and every ~10 s while one generates; it then drops the prompt from ComfyUI's queue,
interrupts it, discards the clips and marks the job `cancelled`.

### Per job, the worker

1. downloads `images` and uploads them to ComfyUI,
   - with a `restyle` block ("Year style"), restyles every image to the era first and
     uses the restyled frames from here on (see [Year style](#year-style-era-restyle)),
2. for each segment, fills the workflow template (`workflows/<workflow>.json`) with
   the two frames, prompt, size, frame count and seed, queues it, and downloads the clip,
3. concatenates the clips with ffmpeg, trimming the first frame of every clip after
   the first (it's the same image the previous clip ended on),
4. uploads `drive.mp4` and marks the job done.

Jobs run one at a time. A job's queue marker is deleted when the worker claims it; if
the VM stops mid-job (preemption, idle stop, a restart), the job resumes from its saved
clips the next time the worker starts (see **Restarts** below).

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
| `minimax_h3_flf2v` (default, "Quality") | 20 | The template's stock settings (`res_multistep`, simple schedule) |
| `minimax_h3_flf2v_turbo` ("Fast") | 8 | Adds the lightx2v 8-step turbo LoRA. ~2.5x faster per clip, but fine detail such as foliage turns to mush |
| `wan22_flf2v_fast` | 4 | Wan 2.2 14B + lightx2v 4-step LoRAs. Needs `install-wan=true` VM metadata |
| `wan22_flf2v` | 20 | Wan 2.2 14B, stock two-pass setup |

Clip length is set per run with **"Clip length"** in the app. By default it comes from a
**driving speed** (default 30 km/h; `speedKmh` on `/api/video`): Street View panoramas
are unevenly spaced, so each clip lasts as long as it takes to drive the road between
its two frames at that speed, which keeps the apparent speed constant. Distances are
straight lines between where Google's camera took each saved panorama (looked up when
frames are saved; a panorama can be up to 25 m from the route point it was found from),
summed over any frames skipped by "Use every Nth frame". Frames closer to the previous
one than the shortest clip covers at that speed (8 m at 30 km/h) are left out, since
their clip would have to play slower. Clips are clamped to 1–15 s, so gaps longer than
15 s of driving run faster; the app lists skipped frames and clamped clips. Runs saved
before panorama positions were looked up use the route points, so save frames again. Each segment in job.json carries its own `frames`
(and `meters`), which the worker passes to the workflow's `{{FRAMES}}`; `params.frames`
is the count nearest the average, used by a worker that predates per-segment frames.
The other mode is a fixed **"Seconds per clip"** (1–15 s, default 5; `clipSeconds`).
Either way the app turns seconds into the nearest frame count the model accepts. At the default, H3 clips are 124 frames at 24 fps (~5.2 s;
H3 frame counts sit on a 17k+5 grid) and Wan 2.2 clips are 81 frames at 16 fps. Both
models were trained around 5 s, so much longer clips may drift or loop and take
proportionally longer to generate. Clips render on
H3's native canvas: 768 px short edge, so the 640×640 Street View frames are
generated at 768×768. H3 also generates an audio track; the worker only decodes
video for now. Pick the workflow per run with **"Quality"** in the app (`"params":
{"workflow": "<name>"}` on `/api/video`), or change the default with `VIDEO_WORKFLOW`.

**Source resolution caps quality.** The Street View Static API returns at most
640×640, so every frame H3 sees is upscaled to its 768 px canvas. More steps help the
model draw plausible detail, but can't recover detail that isn't in the source. The
other big lever is spacing: frames far apart leave the model more to make up.

The job's `status.json` (and the app, under the job status) carries `settings`: the
workflow, model, steps, canvas, frame count and source size. Once the first clip
starts, the worker adds the model and LoRA files and step count it actually sent to
ComfyUI, plus `lastClipSeconds`/`avgClipSeconds`. The worker log has the same line
(`scripts/gpu-vm.sh logs`).

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

### Year style (era restyle)

**Year style** in the Make video step (off by default) redraws every keyframe as if
it had been photographed in a chosen era ("1960s", or any free text up to 60
characters) before any clip is made. The video model then animates between the
restyled frames, and each clip prompt says the drive is period footage of that era.

The job doc gets a `restyle` block:

```json
"restyle": {
  "era": "1960s",
  "workflow": "restyle_qwen_edit_2511",
  "prompt": "Restyle Picture 1 so it looks like a photograph taken on this exact street in the 1960s. …",
  "chainPrompt": "… Picture 2 is the moment just before Picture 1 on the same drive, and Picture 3 is where the drive started …",
  "negativePrompt": "modern cars, …",
  "seed": 123456789,
  "output": "runs/<run>/restyle-<job id>/"
}
```

**Chained references.** Restyling each frame on its own would reinvent every car and
storefront in each frame, and the video model would then morph between unrelated
designs. Instead the edits are chained, with one seed and one set of instructions:

1. frame 1 is restyled from its Street View image alone (`prompt`);
2. every later frame is edited with its Street View image as Picture 1, the previous
   **restyled** frame as Picture 2 and the first restyled frame as Picture 3
   (`chainPrompt`), which asks for the same look and, for anything visible in both,
   the same period design.

This is what keeps moving traffic consistent on busy roads: cars are restyled, not
masked out, and a car still in view in the next frame gets the design it already had.
Picture 3 holds the overall look steady over long drives, where a chain of
one-frame-back references alone would slowly drift.

Restyled frames are uploaded to `runs/<run>/restyle-<job id>/frame_0001.png`… next to
the originals as they are made. A resumed job downloads them rather than redoing
them, so the chain continues from where it stopped.

**Model: Qwen-Image-Edit-2511** (Apache 2.0, ComfyUI-native nodes in the pinned
ComfyUI v0.37.0, int8 weights from ComfyUI's own `image_qwen_image_edit_2511_int8`
template, ~29 GB with its text encoder, VAE and Lightning LoRA). It was picked because:

- `TextEncodeQwenImageEditPlus` takes up to three pictures, each fed to both the
  vision encoder and as a reference latent, which is exactly the frame + previous
  frame + first frame the chain needs;
- the 2511 release was tuned for consistency of people and objects across references;
- the license allows self-hosting and commercial use (unlike FLUX.1 Kontext dev and
  FLUX.2 dev, non-commercial, or Qwen-Image 2.1, released Sep 2026 under a
  research-only license). MiniMax publishes no H3-family image-edit model.
- It fits next to H3 on the 96 GB card (ComfyUI unloads one model to load the other
  between the restyle pass and the clips).

**No depth/edge conditioning.** The frame being edited is itself the main reference
latent, so the model keeps its geometry (road, building outlines, car positions)
without a separate ControlNet; adding depth would mean a custom preprocessor node for
little gain. Picture 1 is scaled to about 1 MP (1024×1024 for a 640×640 frame) by
`FluxKontextImageScale`; the H3 workflow scales it to its own canvas.

Two presets:

| Preset | Workflow | Steps / CFG | Rough time per frame* |
|---|---|---|---|
| Quality (default) | `restyle_qwen_edit_2511` | 20 / 4.0 | ~40 s |
| Fast | `restyle_qwen_edit_2511_fast` (Lightning LoRA) | 4 / 1.0 | ~8 s |

\* Estimates, not measured on this VM yet; the worker logs seconds per restyled frame
and the app shows the average while it runs. At the default ~$1.70/h spot price, 100
frames cost about $1.90 (Quality, ~67 min) or $0.40 (Fast, ~13 min) on top of the clips.

The models are in `MODELS` in `vm-startup.sh` (group `restyle`), so a running VM needs
`./scripts/gpu-vm.sh up` (not just `push`) once to download them.

### Adding another model

1. Upload its files to the models bucket in ComfyUI's layout, e.g.
   `gcloud storage cp my_lora.safetensors gs://<PROJECT_ID>-city-drive-models/models/loras/`.
   The next boot (or `gpu-vm.sh up` on a running VM) copies them to the VM. The copy
   never overwrites a file the VM already has, so a changed model needs a new filename.
   If a fresh project should get the model without anyone uploading it, also add it to
   `MODELS` in `vm-startup.sh` with its download URL. Then build its first+last-frame
   workflow in the ComfyUI UI.
2. **Export (API)** it to JSON and replace the values the worker should fill with
   these placeholder strings: `{{FIRST_IMAGE}}`, `{{LAST_IMAGE}}` (the two `LoadImage`
   nodes), `{{PROMPT}}`, `{{NEGATIVE_PROMPT}}`, `{{WIDTH}}`, `{{HEIGHT}}`, `{{FRAMES}}`,
   `{{FPS}}`, `{{SEED}}`, and `{{OUTPUT_PREFIX}}` (the save node's filename prefix). The
   workflow must end in a node that saves an `.mp4`/`.webm` (e.g. `SaveVideo`).
3. Save it as `worker/workflows/<name>.json`, add it to `WORKFLOWS` in `server.js`
   (frame count, fps, canvas size), and generate its UI-format twin
   `<name>.ui.json` with `scripts/workflow-ui.mjs` (see below). Then run `./scripts/gpu-vm.sh push`.

### Opening a clip's workflow in ComfyUI

Each workflow has a `<name>.ui.json` twin: the same graph in ComfyUI's editable
(UI) format, with the same placeholders. The worker fills both and sends the UI one
as the prompt's `extra_pnginfo.workflow`, so in ComfyUI's queue/history panel
**Open workflow** (or opening the clip's video) shows the exact graph that made the
clip: frames, prompt, size and a fixed seed, ready to tweak and re-queue. The twins
are generated, not hand-edited: after changing an API-format workflow, regenerate
with `node scripts/workflow-ui.mjs <comfy-url> worker/workflows/<name>.json`.

## Running it

Once per project, `scripts/gcp-setup.sh` (see [DEPLOY.md](../DEPLOY.md)) creates the
video and models buckets (re-run it if you set up before the models bucket existed),
gives the app and the `city-drive-gpu-worker` service account access to them,
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
ComfyUI (pinned to v0.37.0, Python 3.12 via uv, PyTorch 2.14 for CUDA 13, or the latest
12.8 build on a pre-580 driver) and ~38 GB of MiniMax H3 weights. Allow 20–30 minutes.
Later boots reuse the disk and start in a couple of minutes.

The weights come from the **models bucket**, `gs://<PROJECT_ID>-city-drive-models/models/`,
in ComfyUI's own layout (`diffusion_models/`, `text_encoders/`, `vae/`, `loras/`). Every
boot copies anything new in it to the VM's disk. The very first boot in a project finds
the bucket empty: it downloads each file `vm-startup.sh` lists from Hugging Face and
uploads it, or uploads the copy already on disk if the VM had downloaded it before the
bucket existed. After that, Hugging Face is out of the loop: the same files stay in use
until you change the bucket, and a recreated VM pulls them from same-region GCS.
Everything in the bucket is copied, so `DISK_SIZE_GB` has to hold all of it. When Google reclaims the spot VM it is **stopped**, not deleted; run `up`
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

The app finds the VM's internal IP through the Compute API, with the same
`cityDriveGpuControl` role as Start/Stop. If that lookup fails (a 403 means
`gcp-setup.sh` hasn't been re-run), the button stays clickable and the page it opens
says why. To skip the lookup, set the repo variable `GCP_COMFY_URL` to
`http://<internal IP>:8188` and redeploy; the IP survives stop/start and changes only
if the VM is recreated:
`gcloud compute instances describe city-drive-gpu --zone=<zone> --format='value(networkInterfaces[0].networkIP)'`.

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
