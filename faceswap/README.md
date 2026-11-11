# Face swap (side project)

Puts your own face on a performer in an existing video, using **Wan 2.2 Animate**
in character-replacement mode on the City Drive GPU VM. The first target is the
Phantom in "Past the Point of No Return" from the 2004 film.

This sits next to City Drive and shares only its GCP project, the GPU VM and the
video bucket. Nothing here changes the City Drive app or the video worker. The
extra models and custom nodes are installed only when you turn them on.

## Why this model

- **Wan 2.2 Animate 14B** (Apache 2.0 weights). In replacement ("Mix") mode it
  takes the original video, a mask of the person to replace and a reference image,
  and redraws only the masked area as the reference. It keeps the original
  motion, lighting and mouth movement, so the singing stays in sync.
- Classic face swappers (ReActor / inswapper) first have to detect a face, and they
  lose it on a half-masked or hooded face. Animate doesn't need to find the face first.
  The InsightFace weights those swappers use are also licensed for non-commercial use only.

## Ground rules

- **The film is copyrighted.** Use it for personal use only. Keep it in
  `gs://<project>-city-drive-video/faceswap/source/` and on the VM, and never commit it
  or any frames from it. `.gitignore` blocks video files and `faceswap/photos/` as a backstop.
- Get the film legitimately. Ripping a Blu-ray you own (for example with MakeMKV) gives the
  cleanest 1080p file. Digital purchases are DRM-locked and can't be used.

## One-time setup

```sh
# Adds Wan 2.2 Animate (~28 GB) and three custom node packs to the VM. Safe to re-run.
# A longer idle shutdown gives you time to click around ComfyUI between runs.
INSTALL_ANIMATE=true IDLE_SHUTDOWN_MINUTES=30 PROJECT_ID=city-drive-20899 ./scripts/gpu-vm.sh up
PROJECT_ID=city-drive-20899 ./scripts/gpu-vm.sh logs   # wait for "City Drive worker is up."

# Upload the film (any container ffmpeg reads: mkv, mp4, ...)
gcloud storage cp phantom.mkv gs://city-drive-20899-city-drive-video/faceswap/source/
```

## Each run

1. **Reference photos into ComfyUI**
   ```sh
   PROJECT_ID=city-drive-20899 ./faceswap/faceswap.sh photos front.jpg mouth_open.jpg
   ```
   Use a sharp, evenly lit, straight-on photo.

2. **Cut the clip** (start time in the film, length in seconds). Start with 5 to 8 s.
   ```sh
   PROJECT_ID=city-drive-20899 ./faceswap/faceswap.sh prep 01:58:30 8
   ```
   This writes `input/phantom_clip.mp4` at 16 fps, 720p high. Set `FPS=24` for the
   film's own frame rate, which looks smoother but costs about 1.5x the GPU time.

3. **Run the workflow in ComfyUI** (the app's ComfyUI link, or `./scripts/gpu-vm.sh tunnel`):
   - Open `faceswap/workflows/wan22_animate_replace.json` (drag it onto the canvas). It is
     ComfyUI's own `video_wan2_2_14B_animate` template (MIT, from Comfy-Org/workflow_templates),
     also in ComfyUI's template browser.
   - **Load Video**: `phantom_clip.mp4`. **Load Image** (reference): your photo.
   - Run once so the point editor shows the first frame. Then **shift + left click** to put
     green points on the person to replace, and **shift + right click** to put red points on
     anyone else in frame, such as Christine.
     - **Face only:** put green points on the head only. The costume stays as it is in the
       film, and only the head is redrawn from your photo. Try this first.
     - **Whole character:** cover the body too. In that case the reference must be you in the
       costume, or it redraws your shirt.
   - Keep the width and height multiples of 16, around 720p. The template's first section
     makes 77 frames. Copy its "extend" group to go longer, as its notes say.

4. **Put the sound back and download**
   ```sh
   PROJECT_ID=city-drive-20899 ./faceswap/faceswap.sh finish
   gcloud storage cp gs://city-drive-20899-city-drive-video/faceswap/out/faceswap-<stamp>.mp4 .
   ```
   This takes ComfyUI's newest output video and the audio from the cut clip.

5. Stop the VM when done (`./scripts/gpu-vm.sh stop`), or let the idle shutdown do it.

## Not done yet

- **The whole song in one go.** A 4 to 5 minute song is ~4,000 to 7,000 frames, which is
  dozens of 77-frame windows. Clicking through those in the UI isn't practical. Once a short
  test looks right, the plan is a script that queues the windows through ComfyUI's API, each
  one continuing from the last.
- **Your own vocals.** If you record the song yourself, a lip-sync pass (InfiniteTalk or
  LatentSync) would re-time the mouth to your recording.
