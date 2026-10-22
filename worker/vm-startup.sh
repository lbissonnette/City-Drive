#!/bin/bash
# Startup script for the City Drive GPU worker VM (Ubuntu 24.04, G4 / RTX PRO 6000).
# scripts/gpu-vm.sh passes it as the VM's startup-script, so it runs as root on
# every boot. Each step skips work that's already done, so after the first boot
# (driver install, ~40 GB of model downloads) a restart just starts the services.
#
# Reads instance metadata:
#   video-bucket            the bucket shared with the app (worker code lives in gs://<bucket>/worker/)
#   idle-shutdown-minutes   power off after this long with no jobs (default 30, 0 = never)
#
# Log: /var/log/city-drive-startup.log (also in the serial console).

set -euxo pipefail
exec > >(tee -a /var/log/city-drive-startup.log) 2>&1

metadata() {
  curl -sf -H 'Metadata-Flavor: Google' \
    "http://metadata.google.internal/computeMetadata/v1/instance/attributes/$1" || true
}
BUCKET="$(metadata video-bucket)"
[[ -n "$BUCKET" ]] || { echo "video-bucket metadata is not set" >&2; exit 1; }
IDLE_SHUTDOWN_MINUTES="$(metadata idle-shutdown-minutes)"
IDLE_SHUTDOWN_MINUTES="${IDLE_SHUTDOWN_MINUTES:-30}"

STATE=/var/lib/city-drive
COMFY=/opt/ComfyUI
WORKER=/opt/city-drive-worker
mkdir -p "$STATE"

# --- 1. NVIDIA driver -----------------------------------------------------------
# Google's installer picks the right driver (open kernel modules for Blackwell)
# and reboots the VM when it needs to; this script then runs again from the top.
if ! nvidia-smi >/dev/null 2>&1; then
  attempts=$(( $(cat "$STATE/driver-attempts" 2>/dev/null || echo 0) + 1 ))
  echo "$attempts" > "$STATE/driver-attempts"
  (( attempts <= 4 )) || { echo "Driver install keeps failing, giving up" >&2; exit 1; }
  apt-get update
  apt-get install -y python3 curl
  curl -fsSL -o /opt/cuda_installer.pyz \
    https://storage.googleapis.com/compute-gpu-installation-us/installer/latest/cuda_installer.pyz
  python3 /opt/cuda_installer.pyz install_driver --installation-mode=repo --installation-branch=prod
  nvidia-smi || reboot
  exit 0
fi
nvidia-smi

# --- 2. System packages -----------------------------------------------------------
if [[ ! -f "$STATE/packages-done" ]]; then
  apt-get update
  apt-get install -y git ffmpeg python3-venv python3-pip curl
  touch "$STATE/packages-done"
fi

# --- 3. ComfyUI ---------------------------------------------------------------------
if [[ ! -d "$COMFY/.git" ]]; then
  git clone https://github.com/comfyanonymous/ComfyUI.git "$COMFY"
fi
if [[ ! -f "$STATE/comfy-deps-done" ]]; then
  python3 -m venv "$COMFY/venv"
  # Blackwell (RTX PRO 6000) needs a CUDA 12.8+ build of PyTorch.
  "$COMFY/venv/bin/pip" install --upgrade pip
  "$COMFY/venv/bin/pip" install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu128
  "$COMFY/venv/bin/pip" install -r "$COMFY/requirements.txt"
  # The worker shares this venv.
  "$COMFY/venv/bin/pip" install google-cloud-storage requests
  touch "$STATE/comfy-deps-done"
fi

# --- 4. Models (Wan 2.2 14B first+last frame to video) -----------------------------
HF=https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files
fetch() { # fetch <url> <dest>; resumable, skipped once present
  local url="$1" dest="$2"
  [[ -s "$dest" ]] && return 0
  mkdir -p "$(dirname "$dest")"
  curl -fL --retry 5 --retry-delay 10 -C - -o "$dest.part" "$url"
  mv "$dest.part" "$dest"
}
M="$COMFY/models"
fetch "$HF/diffusion_models/wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors" "$M/diffusion_models/wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors"
fetch "$HF/diffusion_models/wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors"  "$M/diffusion_models/wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors"
fetch "$HF/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors"              "$M/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors"
fetch "$HF/vae/wan_2.1_vae.safetensors"                                       "$M/vae/wan_2.1_vae.safetensors"
# 4-step distillation LoRAs used by the default "fast" workflow.
fetch "$HF/loras/wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors"    "$M/loras/wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors"
fetch "$HF/loras/wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors"     "$M/loras/wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors"

# --- 5. Worker code (pushed to the bucket by scripts/gpu-vm.sh) ------------------------
command -v gcloud >/dev/null || snap install google-cloud-cli --classic
mkdir -p "$WORKER"
gcloud storage rsync --recursive --delete-unmatched-destination-objects "gs://$BUCKET/worker" "$WORKER"

# --- 6. Services ------------------------------------------------------------------------
cat > /etc/systemd/system/comfyui.service <<EOF
[Unit]
Description=ComfyUI
After=network-online.target

[Service]
WorkingDirectory=$COMFY
ExecStart=$COMFY/venv/bin/python main.py --listen 127.0.0.1 --port 8188
Restart=always

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/city-drive-worker.service <<EOF
[Unit]
Description=City Drive video worker
After=comfyui.service
Wants=comfyui.service

[Service]
WorkingDirectory=$WORKER
Environment=VIDEO_BUCKET=$BUCKET
Environment=PYTHONUNBUFFERED=1
Environment=IDLE_SHUTDOWN_MINUTES=$IDLE_SHUTDOWN_MINUTES
ExecStart=$COMFY/venv/bin/python $WORKER/worker.py
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable comfyui city-drive-worker
systemctl restart comfyui city-drive-worker
echo "City Drive worker is up."
