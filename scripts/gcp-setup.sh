#!/usr/bin/env bash
# One-time Google Cloud setup for deploying City Drive to Cloud Run from GitHub Actions.
#
# Creates (or reuses) a GCP project and everything the deploy workflow needs:
#   - billing link and required APIs (Cloud Run, Artifact Registry, Secret Manager, IAM, Maps)
#   - Artifact Registry repo for the container images
#   - city-drive-deployer SA (used by GitHub Actions) and city-drive-runtime SA (runs the app)
#   - Workload Identity Federation pool/provider that only trusts this GitHub repo
#   - a Google Maps API key stored in Secret Manager as google-maps-api-key
#   - the video bucket shared by the app and the GPU worker, and the
#     city-drive-gpu-worker SA the GPU VM runs as (see scripts/gpu-vm.sh)
#   - a cityDriveGpuControl role that lets the app start and stop that VM
# Then prints the GitHub repository variables to add (or sets them with `gh` if it can).
#
# Safe to re-run: each step checks for what already exists.
#
# Usage:
#   gcloud auth login
#   PROJECT_ID=city-drive-123456 BILLING_ACCOUNT=XXXXXX-XXXXXX-XXXXXX ./scripts/gcp-setup.sh
#
# Settings (environment variables):
#   PROJECT_ID        required. 6-30 chars, lowercase letters/digits/hyphens, globally unique.
#   BILLING_ACCOUNT   required when the project has no billing yet. List yours with
#                     `gcloud billing accounts list`.
#   REGION            default us-central1
#   GITHUB_REPO       default lbissonnette/City-Drive (owner/name, exactly as on GitHub)
#   MAPS_API_KEY      optional. An existing Maps key to store. If unset and no secret exists
#                     yet, the script creates a new key restricted to the three Maps APIs.
#   ORG_ID / FOLDER_ID  optional parent for a new project.

set -euo pipefail

PROJECT_ID="${PROJECT_ID:?Set PROJECT_ID, e.g. PROJECT_ID=city-drive-123456}"
REGION="${REGION:-us-central1}"
GITHUB_REPO="${GITHUB_REPO:-lbissonnette/City-Drive}"
BILLING_ACCOUNT="${BILLING_ACCOUNT:-}"
MAPS_API_KEY="${MAPS_API_KEY:-}"
VIDEO_BUCKET="${VIDEO_BUCKET:-${PROJECT_ID}-city-drive-video}"

SERVICE=city-drive
AR_REPO=city-drive
DEPLOY_SA_NAME=city-drive-deployer
RUNTIME_SA_NAME=city-drive-runtime
WORKER_SA_NAME=city-drive-gpu-worker
POOL=github
PROVIDER=github
SECRET=google-maps-api-key
GPU_ROLE=cityDriveGpuControl

DEPLOY_SA="${DEPLOY_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
RUNTIME_SA="${RUNTIME_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
WORKER_SA="${WORKER_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

log() { printf '\n==> %s\n' "$*"; }
gc() { gcloud --project="$PROJECT_ID" --quiet "$@"; }

command -v gcloud >/dev/null || { echo "gcloud CLI not found. Install: https://cloud.google.com/sdk/docs/install" >&2; exit 1; }
ACCOUNT="$(gcloud config get-value account 2>/dev/null || true)"
[[ -n "$ACCOUNT" ]] || { echo "Not logged in. Run: gcloud auth login" >&2; exit 1; }
echo "Running as $ACCOUNT"

# --- Project and billing ------------------------------------------------------
log "Project $PROJECT_ID"
if gcloud projects describe "$PROJECT_ID" >/dev/null 2>&1; then
  echo "Exists, reusing it."
else
  parent=()
  [[ -n "${ORG_ID:-}" ]] && parent=(--organization="$ORG_ID")
  [[ -n "${FOLDER_ID:-}" ]] && parent=(--folder="$FOLDER_ID")
  # The ${x+...} form keeps macOS's bash 3.2 happy with an empty array under set -u.
  gcloud projects create "$PROJECT_ID" --name="City Drive" ${parent[@]+"${parent[@]}"}
fi

log "Billing"
if [[ "$(gcloud billing projects describe "$PROJECT_ID" --format='value(billingEnabled)')" == "True" ]]; then
  echo "Already enabled."
elif [[ -n "$BILLING_ACCOUNT" ]]; then
  gcloud billing projects link "$PROJECT_ID" --billing-account="$BILLING_ACCOUNT"
else
  echo "Billing is not enabled and BILLING_ACCOUNT is not set. Pick one from:" >&2
  gcloud billing accounts list >&2 || true
  exit 1
fi

# --- APIs ---------------------------------------------------------------------
log "Enabling APIs (can take a minute or two the first time)"
gc services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com \
  secretmanager.googleapis.com \
  iam.googleapis.com \
  iamcredentials.googleapis.com \
  sts.googleapis.com \
  cloudresourcemanager.googleapis.com \
  apikeys.googleapis.com \
  maps-backend.googleapis.com \
  street-view-image-backend.googleapis.com \
  routes.googleapis.com \
  storage.googleapis.com \
  compute.googleapis.com

# --- Artifact Registry --------------------------------------------------------
log "Artifact Registry repo $AR_REPO in $REGION"
if gc artifacts repositories describe "$AR_REPO" --location="$REGION" >/dev/null 2>&1; then
  echo "Exists."
else
  gc artifacts repositories create "$AR_REPO" --location="$REGION" \
    --repository-format=docker --description="City Drive container images"
fi

# --- Service accounts ---------------------------------------------------------
ensure_sa() {
  local name="$1" display="$2"
  if gc iam service-accounts describe "${name}@${PROJECT_ID}.iam.gserviceaccount.com" >/dev/null 2>&1; then
    echo "$name exists."
  else
    gc iam service-accounts create "$name" --display-name="$display"
  fi
}
log "Service accounts"
ensure_sa "$DEPLOY_SA_NAME" "City Drive GitHub deployer"
ensure_sa "$RUNTIME_SA_NAME" "City Drive Cloud Run runtime"
ensure_sa "$WORKER_SA_NAME" "City Drive GPU video worker"
# New service accounts take a few seconds to become visible to IAM policy calls.
for sa in "$DEPLOY_SA" "$RUNTIME_SA" "$WORKER_SA"; do
  for _ in {1..10}; do gc iam service-accounts describe "$sa" >/dev/null 2>&1 && break; sleep 3; done
done

log "Granting roles to the deployer"
# compute.networkViewer: deploying with Direct VPC egress (so the app can reach
# ComfyUI on the GPU VM) needs to read the default network.
for role in roles/run.admin roles/artifactregistry.writer roles/compute.networkViewer; do
  gc projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:$DEPLOY_SA" --role="$role" --condition=None >/dev/null
  echo "$role"
done
# Lets the deployer launch the service as the runtime SA.
gc iam service-accounts add-iam-policy-binding "$RUNTIME_SA" \
  --member="serviceAccount:$DEPLOY_SA" --role=roles/iam.serviceAccountUser >/dev/null
echo "roles/iam.serviceAccountUser on $RUNTIME_SA_NAME"

# --- Maps API key in Secret Manager --------------------------------------------
log "Secret $SECRET"
if ! gc secrets describe "$SECRET" >/dev/null 2>&1; then
  gc secrets create "$SECRET" --replication-policy=automatic
  if [[ -z "$MAPS_API_KEY" ]]; then
    echo "Creating a Maps API key restricted to Maps JavaScript, Street View Static and Routes APIs"
    find_key() { gc services api-keys list --filter='displayName="City Drive"' --format='value(name)' --limit=1; }
    key_name="$(find_key)"
    if [[ -z "$key_name" ]]; then
      gc services api-keys create --display-name="City Drive" \
        --api-target=service=maps-backend.googleapis.com \
        --api-target=service=street-view-image-backend.googleapis.com \
        --api-target=service=routes.googleapis.com >/dev/null
      key_name="$(find_key)"
    fi
    MAPS_API_KEY="$(gc services api-keys get-key-string "$key_name" --format='value(keyString)')"
  fi
  printf '%s' "$MAPS_API_KEY" | gc secrets versions add "$SECRET" --data-file=-
  echo "Stored."
elif [[ -n "$MAPS_API_KEY" ]]; then
  printf '%s' "$MAPS_API_KEY" | gc secrets versions add "$SECRET" --data-file=-
  echo "Exists. Added MAPS_API_KEY as a new version."
else
  echo "Exists, leaving it as is. (Set MAPS_API_KEY to replace the stored key.)"
fi
gc secrets add-iam-policy-binding "$SECRET" \
  --member="serviceAccount:$RUNTIME_SA" --role=roles/secretmanager.secretAccessor >/dev/null
echo "$RUNTIME_SA_NAME can read it."

# --- Video bucket (frames, job docs, finished videos) ----------------------------
log "Bucket gs://$VIDEO_BUCKET"
if gcloud storage buckets describe "gs://$VIDEO_BUCKET" --project="$PROJECT_ID" >/dev/null 2>&1; then
  echo "Exists."
else
  gcloud storage buckets create "gs://$VIDEO_BUCKET" --project="$PROJECT_ID" --location="$REGION" \
    --uniform-bucket-level-access --public-access-prevention
fi
# The app writes frames + jobs and reads videos; the worker reads frames + jobs and writes videos.
for sa in "$RUNTIME_SA" "$WORKER_SA"; do
  gcloud storage buckets add-iam-policy-binding "gs://$VIDEO_BUCKET" --project="$PROJECT_ID" \
    --member="serviceAccount:$sa" --role=roles/storage.objectAdmin >/dev/null
  echo "roles/storage.objectAdmin for ${sa%%@*}"
done
gc projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:$WORKER_SA" --role=roles/logging.logWriter --condition=None >/dev/null

# --- GPU VM control from the app -----------------------------------------------
# The app starts the GPU VM when a video job is queued and has Start/Stop
# buttons. A custom role keeps that to finding, starting and stopping VMs
# (no create, delete or SSH). It's project-wide because gpu-vm.sh creates the
# VM after this script runs.
log "Role $GPU_ROLE for $RUNTIME_SA_NAME"
gpu_perms=compute.instances.get,compute.instances.list,compute.instances.start,compute.instances.stop,compute.instances.resume
if gc iam roles describe "$GPU_ROLE" >/dev/null 2>&1; then
  gc iam roles update "$GPU_ROLE" --permissions="$gpu_perms" >/dev/null
  echo "Exists, permissions refreshed."
else
  gc iam roles create "$GPU_ROLE" --title="City Drive GPU VM control" \
    --description="Start, stop and check the City Drive GPU worker VM" --permissions="$gpu_perms" >/dev/null
fi
gc projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:$RUNTIME_SA" --role="projects/$PROJECT_ID/roles/$GPU_ROLE" --condition=None >/dev/null
# Starting a VM that runs as a service account can require acting as it.
gc iam service-accounts add-iam-policy-binding "$WORKER_SA" \
  --member="serviceAccount:$RUNTIME_SA" --role=roles/iam.serviceAccountUser >/dev/null
echo "$RUNTIME_SA_NAME can start and stop the GPU VM."

# --- Workload Identity Federation ---------------------------------------------
log "Workload Identity Federation for $GITHUB_REPO"
if gc iam workload-identity-pools describe "$POOL" --location=global >/dev/null 2>&1; then
  echo "Pool $POOL exists."
else
  gc iam workload-identity-pools create "$POOL" --location=global --display-name="GitHub Actions"
fi
provider_args=(
  --location=global
  --workload-identity-pool="$POOL"
  --display-name="GitHub OIDC"
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref"
  # Only tokens from this repo are accepted.
  --attribute-condition="assertion.repository == '${GITHUB_REPO}'"
)
if gc iam workload-identity-pools providers describe "$PROVIDER" --location=global --workload-identity-pool="$POOL" >/dev/null 2>&1; then
  gc iam workload-identity-pools providers update-oidc "$PROVIDER" "${provider_args[@]}" >/dev/null
  echo "Provider $PROVIDER exists, condition refreshed."
else
  gc iam workload-identity-pools providers create-oidc "$PROVIDER" "${provider_args[@]}" \
    --issuer-uri="https://token.actions.githubusercontent.com"
fi

PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
POOL_ID="projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}"
WIF_PROVIDER="${POOL_ID}/providers/${PROVIDER}"

gc iam service-accounts add-iam-policy-binding "$DEPLOY_SA" \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/${POOL_ID}/attribute.repository/${GITHUB_REPO}" >/dev/null
echo "GitHub Actions in $GITHUB_REPO can act as $DEPLOY_SA_NAME."

# --- GitHub repository variables ------------------------------------------------
log "GitHub repository variables"
# name=value pairs (no associative arrays, so this runs on macOS's bash 3.2).
VARS=(
  "GCP_PROJECT_ID=$PROJECT_ID"
  "GCP_REGION=$REGION"
  "GCP_WIF_PROVIDER=$WIF_PROVIDER"
  "GCP_DEPLOY_SA=$DEPLOY_SA"
  "GCP_VIDEO_BUCKET=$VIDEO_BUCKET"
)
if command -v gh >/dev/null && gh auth status >/dev/null 2>&1; then
  for kv in "${VARS[@]}"; do gh variable set "${kv%%=*}" --repo "$GITHUB_REPO" --body "${kv#*=}"; done
  echo "Set with gh. Pushing to main (or running the workflow by hand) will now deploy."
else
  echo "Add these under GitHub > Settings > Secrets and variables > Actions > Variables:"
  echo "  https://github.com/${GITHUB_REPO}/settings/variables/actions"
  for kv in "${VARS[@]}"; do printf '  %-17s %s\n' "${kv%%=*}" "${kv#*=}"; done
fi

cat <<EOF

Done. After the first deploy, open the app with:
  gcloud run services proxy $SERVICE --project=$PROJECT_ID --region=$REGION --port=3000
then browse to http://localhost:3000. See DEPLOY.md for other ways to open it.

To start the GPU video worker (see worker/README.md):
  PROJECT_ID=$PROJECT_ID REGION=$REGION ./scripts/gpu-vm.sh up
EOF
