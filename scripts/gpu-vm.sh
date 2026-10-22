#!/usr/bin/env bash
# Creates and manages the City Drive GPU worker: a spot VM with an NVIDIA
# RTX PRO 6000 (G4 machine series) running ComfyUI + worker/worker.py.
# Run scripts/gcp-setup.sh first; it creates the video bucket and the
# city-drive-gpu-worker service account this VM runs as.
#
# Usage:
#   PROJECT_ID=city-drive-123456 ./scripts/gpu-vm.sh up      # push worker code, create or start the VM
#   PROJECT_ID=city-drive-123456 ./scripts/gpu-vm.sh push    # push worker code and restart the worker
#   PROJECT_ID=city-drive-123456 ./scripts/gpu-vm.sh logs    # follow the worker's log
#   PROJECT_ID=city-drive-123456 ./scripts/gpu-vm.sh tunnel  # ComfyUI's web UI at http://localhost:8188
#   PROJECT_ID=city-drive-123456 ./scripts/gpu-vm.sh stop    # stop the VM (stops GPU billing; disk is kept)
#   PROJECT_ID=city-drive-123456 ./scripts/gpu-vm.sh delete  # delete the VM and its disk
#
# Settings (environment variables):
#   PROJECT_ID     required
#   REGION         default us-central1. ZONE is picked from the region's zones that offer MACHINE_TYPE.
#   ZONE           optional, overrides the pick
#   MACHINE_TYPE   default g4-standard-48 (1x RTX PRO 6000 96 GB, 48 vCPU, 180 GB RAM)
#   VIDEO_BUCKET   default <PROJECT_ID>-city-drive-video
#   MODELS_BUCKET  default <PROJECT_ID>-city-drive-models. Model weights; every boot mirrors
#                  it onto the VM's disk (worker/vm-startup.sh step 4). Applied on 'up'.
#   DISK_SIZE_GB   default 300. Must hold everything in MODELS_BUCKET (H3 ~38 GB, Wan 2.2
#                  ~37 GB more) plus ~15 GB for ComfyUI + PyTorch.
#   DISK_TYPE      default hyperdisk-balanced (G4 VMs only take Hyperdisk)
#   IMAGE_PROJECT / IMAGE_FAMILY  boot image. Default: the first family in IMAGE_CANDIDATES
#                  below that exists, preferring images with the NVIDIA driver preinstalled.
#   TUNNEL_PORT    default 8188, the local port 'tunnel' listens on
#   IDLE_SHUTDOWN_MINUTES  default 10. The worker powers the VM off (stopped, not
#                  deleted) after this long with no jobs. 0 keeps it running.
#                  Applied on 'up'.

set -euo pipefail
cd "$(dirname "$0")/.."

CMD="${1:-up}"
PROJECT_ID="${PROJECT_ID:?Set PROJECT_ID}"
REGION="${REGION:-us-central1}"
MACHINE_TYPE="${MACHINE_TYPE:-g4-standard-48}"
VIDEO_BUCKET="${VIDEO_BUCKET:-${PROJECT_ID}-city-drive-video}"
MODELS_BUCKET="${MODELS_BUCKET:-${PROJECT_ID}-city-drive-models}"
DISK_SIZE_GB="${DISK_SIZE_GB:-300}"
DISK_TYPE="${DISK_TYPE:-hyperdisk-balanced}"
IDLE_SHUTDOWN_MINUTES="${IDLE_SHUTDOWN_MINUTES:-10}"
VM=city-drive-gpu
TAG=city-drive-gpu
COMFY_FIREWALL=city-drive-comfyui
TUNNEL_PORT="${TUNNEL_PORT:-8188}"
WORKER_SA="city-drive-gpu-worker@${PROJECT_ID}.iam.gserviceaccount.com"
METADATA="video-bucket=$VIDEO_BUCKET,models-bucket=$MODELS_BUCKET,idle-shutdown-minutes=$IDLE_SHUTDOWN_MINUTES"

# project/family pairs, best first. Images with the driver already installed come first:
# building it with DKMS on the stock Ubuntu 24.04 image fails on its newer kernels.
IMAGE_CANDIDATES=(
  deeplearning-platform-release/common-cu129-ubuntu-2404-nvidia-580
  deeplearning-platform-release/common-cu128-ubuntu-2404-nvidia-570
  deeplearning-platform-release/common-cu129-ubuntu-2204-nvidia-580
  deeplearning-platform-release/common-cu128-ubuntu-2204-nvidia-570
  ubuntu-os-accelerator-images/ubuntu-accelerator-2404-amd64-with-nvidia-580
  ubuntu-os-accelerator-images/ubuntu-accelerator-2404-amd64-with-nvidia-570
  # Last resort: plain Ubuntu 22.04 (kernel 6.8), where vm-startup.sh installs the driver.
  ubuntu-os-cloud/ubuntu-2204-lts
)

gc() { gcloud --project="$PROJECT_ID" --quiet "$@"; }

pick_image() {
  if [[ -n "${IMAGE_FAMILY:-}" ]]; then
    IMAGE_PROJECT="${IMAGE_PROJECT:?Set IMAGE_PROJECT with IMAGE_FAMILY}"
    return
  fi
  local c
  for c in "${IMAGE_CANDIDATES[@]}"; do
    if gcloud compute images describe-from-family "${c#*/}" --project="${c%%/*}" >/dev/null 2>&1; then
      IMAGE_PROJECT="${c%%/*}" IMAGE_FAMILY="${c#*/}"
      return
    fi
  done
  echo "None of the image families in IMAGE_CANDIDATES exist. Set IMAGE_PROJECT and IMAGE_FAMILY." >&2
  exit 1
}
log() { printf '\n==> %s\n' "$*"; }

if [[ -z "${ZONE:-}" ]]; then
  # An existing VM's zone wins; otherwise the first zone in REGION offering the machine type.
  ZONE="$(gc compute instances list --filter="name=$VM" --format='value(zone.basename())' | head -n1)"
  if [[ -z "$ZONE" ]]; then
    ZONE="$(gc compute machine-types list --filter="name=$MACHINE_TYPE AND zone~^$REGION-" \
      --format='value(zone)' | sort | head -n1)"
  fi
  [[ -n "$ZONE" ]] || { echo "No zone in $REGION offers $MACHINE_TYPE. Set REGION or ZONE." >&2; exit 1; }
fi

# All three come from scripts/gcp-setup.sh; say so instead of failing deep inside gcloud.
preflight() {
  if ! gcloud storage buckets describe "gs://$VIDEO_BUCKET" --project="$PROJECT_ID" >/dev/null 2>&1 \
    || ! gcloud storage buckets describe "gs://$MODELS_BUCKET" --project="$PROJECT_ID" >/dev/null 2>&1 \
    || ! gc iam service-accounts describe "$WORKER_SA" >/dev/null 2>&1; then
    echo "gs://$VIDEO_BUCKET, gs://$MODELS_BUCKET or the city-drive-gpu-worker service account doesn't exist yet." >&2
    echo "Run the setup script (safe to re-run) first: PROJECT_ID=$PROJECT_ID ./scripts/gcp-setup.sh" >&2
    exit 1
  fi
}

push_worker() {
  log "Uploading worker code to gs://$VIDEO_BUCKET/worker/"
  gcloud storage rsync --project="$PROJECT_ID" --recursive --delete-unmatched-destination-objects \
    --exclude='__pycache__/.*' worker "gs://$VIDEO_BUCKET/worker"
}

# Lets the Cloud Run app (Direct VPC egress from the region's default subnet)
# reach ComfyUI on port 8188 for its /comfy/ proxy. Nothing outside the VPC can.
comfy_firewall() {
  gc compute firewall-rules describe "$COMFY_FIREWALL" >/dev/null 2>&1 && return
  local range
  range="$(gc compute networks subnets describe default --region="$REGION" --format='value(ipCidrRange)')"
  log "Allowing ComfyUI (tcp:8188) from the default subnet $range"
  gc compute firewall-rules create "$COMFY_FIREWALL" --network=default --direction=INGRESS \
    --allow=tcp:8188 --source-ranges="$range" --target-tags="$TAG"
}

vm_status() { gc compute instances describe "$VM" --zone="$ZONE" --format='value(status)' 2>/dev/null || true; }

case "$CMD" in
  up)
    preflight
    push_worker
    comfy_firewall
    status="$(vm_status)"
    if [[ -z "$status" ]]; then
      pick_image
      log "Creating spot VM $VM ($MACHINE_TYPE) in $ZONE from $IMAGE_PROJECT/$IMAGE_FAMILY"
      gc compute instances create "$VM" \
        --zone="$ZONE" \
        --machine-type="$MACHINE_TYPE" \
        --tags="$TAG" \
        --provisioning-model=SPOT \
        --instance-termination-action=STOP \
        --maintenance-policy=TERMINATE \
        --image-family="$IMAGE_FAMILY" --image-project="$IMAGE_PROJECT" \
        --boot-disk-size="${DISK_SIZE_GB}GB" --boot-disk-type="$DISK_TYPE" \
        --service-account="$WORKER_SA" --scopes=cloud-platform \
        --metadata="$METADATA,install-nvidia-driver=True" \
        --metadata-from-file=startup-script=worker/vm-startup.sh
      echo "First boot sets up the driver, ComfyUI and ~40 GB of models: allow 20-30 minutes"
      echo "(less once gs://$MODELS_BUCKET is seeded, since models then come from GCS)."
    elif [[ "$status" != "RUNNING" ]]; then
      log "Starting $VM ($status)"
      gc compute instances add-tags "$VM" --zone="$ZONE" --tags="$TAG" # VMs created before the ComfyUI firewall rule
      gc compute instances add-metadata "$VM" --zone="$ZONE" \
        --metadata="$METADATA" --metadata-from-file=startup-script=worker/vm-startup.sh
      gc compute instances start "$VM" --zone="$ZONE"
    else
      log "$VM is already running; updating its startup script and re-running it"
      gc compute instances add-tags "$VM" --zone="$ZONE" --tags="$TAG"
      gc compute instances add-metadata "$VM" --zone="$ZONE" \
        --metadata="$METADATA" --metadata-from-file=startup-script=worker/vm-startup.sh
      gc compute ssh "$VM" --zone="$ZONE" --command='sudo google_metadata_script_runner startup'
    fi
    echo "Follow progress: PROJECT_ID=$PROJECT_ID ./scripts/gpu-vm.sh logs"
    ;;
  push)
    preflight
    push_worker
    gc compute ssh "$VM" --zone="$ZONE" --command="sudo gcloud storage rsync --recursive --delete-unmatched-destination-objects gs://$VIDEO_BUCKET/worker /opt/city-drive-worker && sudo systemctl restart city-drive-worker"
    ;;
  logs)
    gc compute ssh "$VM" --zone="$ZONE" --command='sudo tail -n 50 /var/log/city-drive-startup.log; sudo journalctl -u city-drive-worker -u comfyui -f'
    ;;
  tunnel)
    # Forwards ComfyUI over SSH, for when the app's /comfy/ proxy isn't an option
    # (e.g. running the app locally: set COMFY_URL=http://localhost:8188 in .env).
    echo "ComfyUI at http://localhost:$TUNNEL_PORT (Ctrl-C to close the tunnel)"
    gc compute ssh "$VM" --zone="$ZONE" -- -N -L "$TUNNEL_PORT:localhost:8188"
    ;;
  stop)
    gc compute instances stop "$VM" --zone="$ZONE"
    ;;
  delete)
    gc compute instances delete "$VM" --zone="$ZONE"
    ;;
  *)
    echo "Unknown command $CMD (use up, push, logs, tunnel, stop or delete)" >&2
    exit 1
    ;;
esac
