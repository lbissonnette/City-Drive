#!/bin/bash
# Startup script for the City Drive GPU worker VM (Ubuntu, G4 / RTX PRO 6000).
# scripts/gpu-vm.sh passes it as the VM's startup-script, so it runs as root on
# every boot. Each step skips work that's already done, so after the first boot
# (driver install, ~38 GB of model downloads) a restart just starts the services.
#
# Reads instance metadata:
#   video-bucket            the bucket shared with the app (worker code lives in gs://<bucket>/worker/)
#   idle-shutdown-minutes   power off after this long with no jobs (default 10, 0 = never)
#   install-wan             "true" to also download Wan 2.2 for the wan22_* workflows
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
IDLE_SHUTDOWN_MINUTES="${IDLE_SHUTDOWN_MINUTES:-10}"

STATE=/var/lib/city-drive
COMFY=/opt/ComfyUI
WORKER=/opt/city-drive-worker
mkdir -p "$STATE"

# --- 1. NVIDIA driver -----------------------------------------------------------
# scripts/gpu-vm.sh prefers images that already have the driver. Deep Learning VM
# images finish installing it in the background on first boot, so wait for that.
if ! nvidia-smi >/dev/null 2>&1 && [[ -d /opt/deeplearning ]]; then
  for _ in $(seq 60); do nvidia-smi >/dev/null 2>&1 && break; sleep 15; done
fi
# Otherwise Google's installer picks the right driver (open kernel modules for
# Blackwell) and reboots the VM when it needs to; this script then runs again.
if ! nvidia-smi >/dev/null 2>&1; then
  attempts=$(( $(cat "$STATE/driver-attempts" 2>/dev/null || echo 0) + 1 ))
  echo "$attempts" > "$STATE/driver-attempts"
  (( attempts <= 4 )) || { echo "Driver install keeps failing, giving up" >&2; exit 1; }
  apt-get update
  apt-get install -y python3 curl "linux-headers-$(uname -r)"
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
  # uv gives the same Python 3.12 whichever Ubuntu release the image is on.
  command -v uv >/dev/null || curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh
  export UV_PYTHON_INSTALL_DIR=/opt/uv-python HOME="${HOME:-/root}"
  rm -rf "$COMFY/venv"
  uv venv --python 3.12 --seed "$COMFY/venv"
  pip() { uv pip install --python "$COMFY/venv/bin/python" "$@"; }
  # ComfyUI wants a cu130 PyTorch on RTX 20-series and newer, which needs driver 580+.
  driver_major="$(nvidia-smi --query-gpu=driver_version --format=csv,noheader | head -n1 | cut -d. -f1)"
  cuda=cu130; (( driver_major >= 580 )) || cuda=cu128
  pip torch torchvision torchaudio --index-url "https://download.pytorch.org/whl/$cuda" --extra-index-url https://pypi.org/simple --index-strategy unsafe-best-match
  pip -r "$COMFY/requirements.txt"
  # The worker shares this venv.
  pip google-cloud-storage requests
  touch "$STATE/comfy-deps-done"
fi

# --- 4. Models ----------------------------------------------------------------------
fetch() { # fetch <url> <dest>; resumable, skipped once present
  local url="$1" dest="$2"
  [[ -s "$dest" ]] && return 0
  mkdir -p "$(dirname "$dest")"
  curl -fL --retry 5 --retry-delay 10 -C - -o "$dest.part" "$url"
  mv "$dest.part" "$dest"
}
M="$COMFY/models"

# MiniMax H3 first+last frame to video (the default). Files and URLs are the ones
# ComfyUI's own video_minimax_h3_i2v template uses (~38 GB).
H3=https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main
fetch "$H3/diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors" "$M/diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors"
fetch "$H3/text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors"        "$M/text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors"
fetch "$H3/vae/minimax_h3_video_vae_int8_convrot.safetensors"                 "$M/vae/minimax_h3_video_vae_int8_convrot.safetensors"
# 8-step turbo LoRA used by the default minimax_h3_flf2v_turbo workflow.
fetch "https://huggingface.co/lightx2v/Minimax-h3-Turbo/resolve/main/minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors" \
  "$M/loras/minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors"

# Wan 2.2 14B (Apache 2.0) for the wan22_* workflows. Off unless the VM has
# metadata install-wan=true (~37 GB more).
if [[ "$(metadata install-wan)" == "true" ]]; then
HF=https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files
fetch "$HF/diffusion_models/wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors" "$M/diffusion_models/wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors"
fetch "$HF/diffusion_models/wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors"  "$M/diffusion_models/wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors"
fetch "$HF/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors"              "$M/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors"
fetch "$HF/vae/wan_2.1_vae.safetensors"                                       "$M/vae/wan_2.1_vae.safetensors"
# 4-step distillation LoRAs used by the default "fast" workflow.
fetch "$HF/loras/wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors"    "$M/loras/wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors"
fetch "$HF/loras/wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors"     "$M/loras/wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors"
fi

# --- 5. Worker code (pushed to the bucket by scripts/gpu-vm.sh) ------------------------
command -v gcloud >/dev/null || snap install google-cloud-cli --classic
mkdir -p "$WORKER"
gcloud storage rsync --recursive --delete-unmatched-destination-objects "gs://$BUCKET/worker" "$WORKER"

# --- 6. Services ------------------------------------------------------------------------
# ComfyUI listens on all interfaces so the app's /comfy/ proxy can reach it over
# the VPC. Only the default network's internal traffic and the city-drive-comfyui
# firewall rule (scripts/gpu-vm.sh) allow port 8188; there is no rule from the internet.
cat > /etc/systemd/system/comfyui.service <<EOF
[Unit]
Description=ComfyUI
After=network-online.target

[Service]
WorkingDirectory=$COMFY
ExecStart=$COMFY/venv/bin/python main.py --listen 0.0.0.0 --port 8188
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
