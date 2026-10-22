#!/bin/bash
# Startup script for the City Drive GPU worker VM (Ubuntu, G4 / RTX PRO 6000).
# scripts/gpu-vm.sh passes it as the VM's startup-script, so it runs as root on
# every boot. Each step skips work that's already done, so after the first boot
# (driver install, ComfyUI, ~67 GB of models) a restart syncs any new models from
# the models bucket and starts the services.
#
# Reads instance metadata:
#   video-bucket            the bucket shared with the app (worker code lives in gs://<bucket>/worker/)
#   models-bucket           model weights, mirrored into ComfyUI's models folder (see step 4)
#   idle-shutdown-minutes   power off after this long with no jobs (default 10, 0 = never)
#   install-wan             "true" to also seed Wan 2.2 for the wan22_* workflows
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
# Pinned to the versions AI Worlds runs H3 with on the same GPU (its
# comfyui_cloud/Dockerfile.rtx), so a boot never picks up an untested ComfyUI or
# PyTorch. Bumping either reinstalls the venv on the next boot.
COMFYUI_VERSION=v0.37.0
TORCH_PINS=(torch==2.14.0 torchvision==0.29.0 torchaudio==2.11.0)
if [[ ! -d "$COMFY/.git" ]]; then
  git clone --depth 1 --branch "$COMFYUI_VERSION" https://github.com/comfyanonymous/ComfyUI.git "$COMFY"
elif [[ "$(git -C "$COMFY" describe --tags --exact-match 2>/dev/null)" != "$COMFYUI_VERSION" ]]; then
  # VMs from before the pin cloned HEAD.
  git -C "$COMFY" fetch --depth 1 origin "refs/tags/$COMFYUI_VERSION:refs/tags/$COMFYUI_VERSION"
  git -C "$COMFY" checkout -q "$COMFYUI_VERSION"
fi
DEPS_DONE="$STATE/comfy-deps-$COMFYUI_VERSION-${TORCH_PINS[0]}"
if [[ ! -f "$DEPS_DONE" ]]; then
  # uv gives the same Python 3.12 whichever Ubuntu release the image is on.
  command -v uv >/dev/null || curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh
  export UV_PYTHON_INSTALL_DIR=/opt/uv-python HOME="${HOME:-/root}"
  rm -rf "$COMFY/venv"
  uv venv --python 3.12 --seed "$COMFY/venv"
  pip() { uv pip install --python "$COMFY/venv/bin/python" "$@"; }
  # ComfyUI wants a cu130 PyTorch on RTX 20-series and newer, which needs driver 580+.
  # The pins are for cu130; the cu128 fallback for older drivers takes the latest build.
  driver_major="$(nvidia-smi --query-gpu=driver_version --format=csv,noheader | head -n1 | cut -d. -f1)"
  if (( driver_major >= 580 )); then
    pip "${TORCH_PINS[@]}" --index-url https://download.pytorch.org/whl/cu130 --extra-index-url https://pypi.org/simple --index-strategy unsafe-best-match
  else
    pip torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu128 --extra-index-url https://pypi.org/simple --index-strategy unsafe-best-match
  fi
  pip -r "$COMFY/requirements.txt"
  # The worker shares this venv.
  pip google-cloud-storage requests
  rm -f "$STATE"/comfy-deps-*
  touch "$DEPS_DONE"
fi

command -v gcloud >/dev/null || snap install google-cloud-cli --classic

# --- 4. Models ----------------------------------------------------------------------
# The models bucket is the source of truth, in ComfyUI's own layout
# (gs://<models-bucket>/models/<folder>/<file>). Every boot mirrors it into
# $COMFY/models, so adding a model is an upload, and a recreated VM pulls from
# same-region GCS instead of Hugging Face. The mirror never overwrites a file it
# already has: to change a model, upload it under a new name and point the
# workflow at that.
#
# MODELS lists what the bundled workflows need. Any the bucket lacks is seeded
# once, from a copy already on this disk or else from its Hugging Face URL, so the
# bucket only depends on Hugging Face the first time.
M="$COMFY/models"
H3=https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main
WAN=https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files
QWEN_EDIT=https://huggingface.co/Comfy-Org/Qwen-Image-Edit_ComfyUI/resolve/main/split_files
MODELS=( # <group> <folder/file> <url>
  # MiniMax H3 first+last frame to video (the default). Files and URLs are the ones
  # ComfyUI's own video_minimax_h3_i2v template uses (~38 GB).
  "h3 diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors $H3/diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors"
  "h3 text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors $H3/text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors"
  "h3 vae/minimax_h3_video_vae_int8_convrot.safetensors $H3/vae/minimax_h3_video_vae_int8_convrot.safetensors"
  # 8-step turbo LoRA used by the "Fast" minimax_h3_flf2v_turbo workflow.
  "h3 loras/minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors https://huggingface.co/lightx2v/Minimax-h3-Turbo/resolve/main/minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors"
  # Qwen-Image-Edit-2511 (Apache 2.0) for the "Year style" restyle_qwen_edit_2511*
  # workflows, from ComfyUI's image_qwen_image_edit_2511_int8 template (~29 GB).
  "restyle diffusion_models/qwen_image_edit_2511_int8_convrot.safetensors $QWEN_EDIT/diffusion_models/qwen_image_edit_2511_int8_convrot.safetensors"
  "restyle text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors https://huggingface.co/Comfy-Org/HunyuanVideo_1.5_repackaged/resolve/main/split_files/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors"
  "restyle vae/qwen_image_vae.safetensors https://huggingface.co/Comfy-Org/Qwen-Image_ComfyUI/resolve/main/split_files/vae/qwen_image_vae.safetensors"
  # 4-step Lightning LoRA for the "Fast" restyle_qwen_edit_2511_fast workflow.
  "restyle loras/Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors https://huggingface.co/lightx2v/Qwen-Image-Edit-2511-Lightning/resolve/main/Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors"
  # Wan 2.2 14B (Apache 2.0) for the wan22_* workflows. Only seeded when the VM has
  # metadata install-wan=true (~37 GB more).
  "wan diffusion_models/wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors $WAN/diffusion_models/wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors"
  "wan diffusion_models/wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors $WAN/diffusion_models/wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors"
  "wan text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors $WAN/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors"
  "wan vae/wan_2.1_vae.safetensors $WAN/vae/wan_2.1_vae.safetensors"
  # 4-step distillation LoRAs used by the default "fast" workflow.
  "wan loras/wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors $WAN/loras/wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors"
  "wan loras/wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors $WAN/loras/wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors"
)
ENABLED=(h3 restyle)
if [[ "$(metadata install-wan)" == "true" ]]; then ENABLED+=(wan); fi

MODELS_BUCKET="$(metadata models-bucket)"
# VMs set up before the models bucket existed have no models-bucket metadata
# until the next `gpu-vm.sh up`; they keep downloading straight to disk.
[[ -n "$MODELS_BUCKET" ]] || echo "models-bucket metadata is not set; downloading models to disk only" >&2

seed() { # seed <folder/file> <url>
  local path="$1" url="$2" dest="$M/$1"
  local obj="gs://$MODELS_BUCKET/models/$path"
  [[ -n "$MODELS_BUCKET" ]] && gcloud storage objects describe "$obj" >/dev/null 2>&1 && return 0
  if [[ ! -s "$dest" ]]; then
    mkdir -p "$(dirname "$dest")"
    curl -fL --retry 5 --retry-delay 10 -C - -o "$dest.part" "$url"
    mv "$dest.part" "$dest"
  fi
  [[ -z "$MODELS_BUCKET" ]] || gcloud storage cp "$dest" "$obj"
}
for entry in "${MODELS[@]}"; do
  read -r group path url <<<"$entry"
  if [[ " ${ENABLED[*]} " == *" $group "* ]]; then seed "$path" "$url"; fi
done
if [[ -n "$MODELS_BUCKET" ]]; then
  gcloud storage rsync --recursive --no-clobber "gs://$MODELS_BUCKET/models" "$M"
fi
for entry in "${MODELS[@]}"; do
  read -r group path url <<<"$entry"
  if [[ " ${ENABLED[*]} " == *" $group "* && ! -s "$M/$path" ]]; then
    echo "Model $path is missing from $M after the sync" >&2; exit 1
  fi
done

# --- 5. Worker code (pushed to the bucket by scripts/gpu-vm.sh) ------------------------
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
