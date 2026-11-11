#!/usr/bin/env bash
# Face swap side project: helpers around the City Drive GPU VM for putting your
# own face on a performer with Wan 2.2 Animate (character replacement) in ComfyUI.
# See faceswap/README.md for the whole walkthrough.
#
# The source film and the result stay in the video bucket under faceswap/ and on
# the VM. Nothing here copies footage into the repo.
#
# Usage (from the repo root, VM created with INSTALL_ANIMATE=true ./scripts/gpu-vm.sh up):
#   PROJECT_ID=... ./faceswap/faceswap.sh photos front.jpg left.jpg ...  # copy reference photos into ComfyUI's input/
#   PROJECT_ID=... ./faceswap/faceswap.sh prep 01:58:30 8               # cut 8 s from 1:58:30 of the source film
#   PROJECT_ID=... ./faceswap/faceswap.sh finish                        # put the clip's audio on ComfyUI's newest video
#
# Settings (environment variables):
#   PROJECT_ID     required
#   VIDEO_BUCKET   default <PROJECT_ID>-city-drive-video
#   SOURCE         default: the only file under gs://<VIDEO_BUCKET>/faceswap/source/
#   FPS            frame rate for the cut clip, default 16 (Wan's native rate; fewer frames to
#                  generate). 24 matches the film and looks smoother, ~1.5x the GPU time.
#   HEIGHT         default 720. Height of the cut clip; width keeps the film's aspect ratio.
#   CLIP_NAME      default phantom_clip.mp4, the name in ComfyUI's input/ folder

set -euo pipefail

CMD="${1:-}"
shift || true
PROJECT_ID="${PROJECT_ID:?Set PROJECT_ID}"
VIDEO_BUCKET="${VIDEO_BUCKET:-${PROJECT_ID}-city-drive-video}"
FPS="${FPS:-16}"
HEIGHT="${HEIGHT:-720}"
CLIP_NAME="${CLIP_NAME:-phantom_clip.mp4}"
VM=city-drive-gpu
COMFY=/opt/ComfyUI
WORK=/var/lib/faceswap
GS="gs://$VIDEO_BUCKET/faceswap"

gc() { gcloud --project="$PROJECT_ID" --quiet "$@"; }
ZONE="${ZONE:-$(gc compute instances list --filter="name=$VM" --format='value(zone.basename())' | head -n1)}"
[[ -n "$ZONE" ]] || { echo "No $VM VM. Create it: INSTALL_ANIMATE=true PROJECT_ID=$PROJECT_ID ./scripts/gpu-vm.sh up" >&2; exit 1; }
[[ "$(gc compute instances describe "$VM" --zone="$ZONE" --format='value(status)')" == RUNNING ]] \
  || { echo "$VM is not running. Start it: INSTALL_ANIMATE=true PROJECT_ID=$PROJECT_ID ./scripts/gpu-vm.sh up" >&2; exit 1; }
on_vm() { gc compute ssh "$VM" --zone="$ZONE" --command="sudo bash -euo pipefail -c $(printf '%q' "$1")"; }

case "$CMD" in
  photos)
    (( $# > 0 )) || { echo "Usage: faceswap.sh photos <image>..." >&2; exit 1; }
    gcloud storage cp --project="$PROJECT_ID" "$@" "$GS/photos/"
    on_vm "gcloud storage cp '$GS/photos/*' $COMFY/input/ && ls $COMFY/input"
    echo "In ComfyUI, pick one of these in the reference image's Load Image node."
    ;;

  prep)
    start="${1:?Usage: faceswap.sh prep <start, e.g. 01:58:30> <seconds>}"
    seconds="${2:?Usage: faceswap.sh prep <start> <seconds>}"
    if [[ -z "${SOURCE:-}" ]]; then
      mapfile -t found < <(gcloud storage ls --project="$PROJECT_ID" "$GS/source/" | grep -v '/$' || true)
      (( ${#found[@]} == 1 )) || { echo "Expected one file in $GS/source/, found ${#found[@]}. Set SOURCE=gs://..." >&2; exit 1; }
      SOURCE="${found[0]}"
    fi
    name="$(basename "$SOURCE")"
    # The film is copied once to the VM's disk and reused for later cuts.
    on_vm "
      mkdir -p $WORK
      [[ -s '$WORK/$name' ]] || gcloud storage cp '$SOURCE' '$WORK/$name'
      ffmpeg -y -loglevel error -ss '$start' -t '$seconds' -i '$WORK/$name' \
        -map 0:v:0 -map 0:a:0? -vf 'fps=$FPS,scale=-2:$HEIGHT' \
        -c:v libx264 -crf 16 -preset slow -pix_fmt yuv420p -c:a aac -b:a 192k \
        '$COMFY/input/$CLIP_NAME'
      ffprobe -v error -select_streams v:0 -count_frames \
        -show_entries stream=width,height,nb_read_frames -of default=nw=1 '$COMFY/input/$CLIP_NAME'
    "
    echo "Cut $seconds s from $start into ComfyUI's input/$CLIP_NAME at $FPS fps."
    ;;

  finish)
    # Default: ComfyUI's newest video. The workflow's own output can drop or shift the
    # audio, so this always takes the sound from the cut clip.
    out="${1:-}"
    stamp="$(date +%Y%m%d-%H%M%S)"
    on_vm "
      out='$out'
      [[ -n \"\$out\" ]] || out=\"\$(ls -t $COMFY/output/*.mp4 $COMFY/output/*/*.mp4 2>/dev/null | head -n1 || true)\"
      [[ \"\$out\" == /* ]] || out='$COMFY/output/'\"\$out\"
      [[ -s \"\$out\" ]] || { echo 'No video in $COMFY/output' >&2; exit 1; }
      echo \"Using \$out\"
      ffmpeg -y -loglevel error -i \"\$out\" -i '$COMFY/input/$CLIP_NAME' \
        -map 0:v:0 -map 1:a:0 -c:v copy -c:a aac -b:a 192k -shortest '$WORK/faceswap-$stamp.mp4'
      gcloud storage cp '$WORK/faceswap-$stamp.mp4' '$GS/out/faceswap-$stamp.mp4'
    "
    echo "Download it: gcloud storage cp $GS/out/faceswap-$stamp.mp4 ."
    ;;

  *)
    echo "Usage: faceswap.sh photos|prep|finish (see the top of this file)" >&2
    exit 1
    ;;
esac
