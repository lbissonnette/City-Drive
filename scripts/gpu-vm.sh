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
#   PROJECT_ID=city-drive-123456 ./scripts/gpu-vm.sh stop    # stop the VM (stops GPU billing; disk is kept)
#   PROJECT_ID=city-drive-123456 ./scripts/gpu-vm.sh delete  # delete the VM and its disk
#
# Settings (environment variables):
#   PROJECT_ID     required
#   REGION         default us-central1. ZONE is picked from the region's zones that offer MACHINE_TYPE.
#   ZONE           optional, overrides the pick
#   MACHINE_TYPE   default g4-standard-48 (1x RTX PRO 6000 96 GB, 48 vCPU, 180 GB RAM)
#   VIDEO_BUCKET   default <PROJECT_ID>-city-drive-video
#   DISK_SIZE_GB   default 300 (models are ~40 GB; ComfyUI + PyTorch another ~15 GB)
#   DISK_TYPE      default hyperdisk-balanced (G4 VMs only take Hyperdisk)
#   IDLE_SHUTDOWN_MINUTES  default 30. The worker powers the VM off (stopped, not
#                  deleted) after this long with no jobs. 0 keeps it running.
#                  Applied on 'up'.

set -euo pipefail
cd "$(dirname "$0")/.."

CMD="${1:-up}"
PROJECT_ID="${PROJECT_ID:?Set PROJECT_ID}"
REGION="${REGION:-us-central1}"
MACHINE_TYPE="${MACHINE_TYPE:-g4-standard-48}"
VIDEO_BUCKET="${VIDEO_BUCKET:-${PROJECT_ID}-city-drive-video}"
DISK_SIZE_GB="${DISK_SIZE_GB:-300}"
DISK_TYPE="${DISK_TYPE:-hyperdisk-balanced}"
IDLE_SHUTDOWN_MINUTES="${IDLE_SHUTDOWN_MINUTES:-30}"
VM=city-drive-gpu
WORKER_SA="city-drive-gpu-worker@${PROJECT_ID}.iam.gserviceaccount.com"

gc() { gcloud --project="$PROJECT_ID" --quiet "$@"; }
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

push_worker() {
  log "Uploading worker code to gs://$VIDEO_BUCKET/worker/"
  gcloud storage rsync --project="$PROJECT_ID" --recursive --delete-unmatched-destination-objects \
    --exclude='__pycache__/.*' worker "gs://$VIDEO_BUCKET/worker"
}

vm_status() { gc compute instances describe "$VM" --zone="$ZONE" --format='value(status)' 2>/dev/null || true; }

case "$CMD" in
  up)
    push_worker
    status="$(vm_status)"
    if [[ -z "$status" ]]; then
      log "Creating spot VM $VM ($MACHINE_TYPE) in $ZONE"
      gc compute instances create "$VM" \
        --zone="$ZONE" \
        --machine-type="$MACHINE_TYPE" \
        --provisioning-model=SPOT \
        --instance-termination-action=STOP \
        --maintenance-policy=TERMINATE \
        --image-family=ubuntu-2404-lts-amd64 --image-project=ubuntu-os-cloud \
        --boot-disk-size="${DISK_SIZE_GB}GB" --boot-disk-type="$DISK_TYPE" \
        --service-account="$WORKER_SA" --scopes=cloud-platform \
        --metadata="video-bucket=$VIDEO_BUCKET,idle-shutdown-minutes=$IDLE_SHUTDOWN_MINUTES" \
        --metadata-from-file=startup-script=worker/vm-startup.sh
      echo "First boot installs the driver (one reboot), ComfyUI and ~40 GB of models: allow 20-30 minutes."
    elif [[ "$status" != "RUNNING" ]]; then
      log "Starting $VM ($status)"
      gc compute instances add-metadata "$VM" --zone="$ZONE" \
        --metadata="video-bucket=$VIDEO_BUCKET,idle-shutdown-minutes=$IDLE_SHUTDOWN_MINUTES" --metadata-from-file=startup-script=worker/vm-startup.sh
      gc compute instances start "$VM" --zone="$ZONE"
    else
      log "$VM is already running. Use 'push' to restart the worker with new code."
      # Starting the VM also restarts the idle clock; a running VM keeps its own.
    fi
    echo "Follow progress: PROJECT_ID=$PROJECT_ID ./scripts/gpu-vm.sh logs"
    ;;
  push)
    push_worker
    gc compute ssh "$VM" --zone="$ZONE" --command="sudo gcloud storage rsync --recursive --delete-unmatched-destination-objects gs://$VIDEO_BUCKET/worker /opt/city-drive-worker && sudo systemctl restart city-drive-worker"
    ;;
  logs)
    gc compute ssh "$VM" --zone="$ZONE" --command='sudo tail -n 50 /var/log/city-drive-startup.log; sudo journalctl -u city-drive-worker -u comfyui -f'
    ;;
  stop)
    gc compute instances stop "$VM" --zone="$ZONE"
    ;;
  delete)
    gc compute instances delete "$VM" --zone="$ZONE"
    ;;
  *)
    echo "Unknown command $CMD (use up, push, logs, stop or delete)" >&2
    exit 1
    ;;
esac
