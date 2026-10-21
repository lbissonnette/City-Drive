# Deploying City Drive to Cloud Run

The app runs as a single Cloud Run service. Pushes to `main` build the container and
deploy it through GitHub Actions ([`.github/workflows/deploy.yml`](.github/workflows/deploy.yml)),
which signs in to Google Cloud with Workload Identity Federation, so no service account
keys are stored anywhere.

## 1. One-time setup (run on your machine)

You need the [gcloud CLI](https://cloud.google.com/sdk/docs/install) signed in as an
account that can create projects and use a billing account.

```bash
gcloud auth login
gcloud billing accounts list          # copy the ACCOUNT_ID you want to use

PROJECT_ID=city-drive-$RANDOM \
BILLING_ACCOUNT=XXXXXX-XXXXXX-XXXXXX \
./scripts/gcp-setup.sh
```

[`scripts/gcp-setup.sh`](scripts/gcp-setup.sh) creates the project (or reuses it if it
exists), links billing, enables the APIs, and creates:

| Resource | Purpose |
| --- | --- |
| Artifact Registry repo `city-drive` | Container images |
| `city-drive-deployer` service account | What GitHub Actions acts as. Has Cloud Run Admin and Artifact Registry Writer |
| `city-drive-runtime` service account | What the app runs as. Can only read the Maps key secret |
| Workload Identity pool + provider `github` | Lets GitHub Actions in `lbissonnette/City-Drive` (and no other repo) act as the deployer |
| Secret `google-maps-api-key` | The Maps key, injected as `GOOGLE_MAPS_API_KEY` |

Optional settings: `REGION` (default `us-central1`), `MAPS_API_KEY` to store a key you
already have instead of creating one, `GITHUB_REPO` if the repo moves, and
`ORG_ID`/`FOLDER_ID` to create the project under an organization. The script is safe to
re-run; it skips anything that already exists.

At the end it prints four **repository variables** (not secrets, none of them are
sensitive). If the GitHub CLI (`gh`) is installed and signed in, it sets them for you;
otherwise add them at
[Settings > Secrets and variables > Actions > Variables](https://github.com/lbissonnette/City-Drive/settings/variables/actions):

| Variable | Example |
| --- | --- |
| `GCP_PROJECT_ID` | `city-drive-12345` |
| `GCP_REGION` | `us-central1` |
| `GCP_WIF_PROVIDER` | `projects/123456789/locations/global/workloadIdentityPools/github/providers/github` |
| `GCP_DEPLOY_SA` | `city-drive-deployer@city-drive-12345.iam.gserviceaccount.com` |

The deploy job is skipped until `GCP_PROJECT_ID` is set, so merging the workflow before
setup doesn't produce failing runs.

## 2. Deploy

Push to `main`, or run **Deploy to Cloud Run** from the Actions tab. The run log ends
with the service URL.

### Quick manual alternative

To deploy straight from your checkout without GitHub Actions (after running the setup
script, which creates the runtime service account and secret), Cloud Build builds the
Dockerfile for you:

```bash
gcloud run deploy city-drive --source . \
  --project=$PROJECT_ID --region=us-central1 \
  --service-account=city-drive-runtime@$PROJECT_ID.iam.gserviceaccount.com \
  --set-secrets=GOOGLE_MAPS_API_KEY=google-maps-api-key:latest \
  --max-instances=1 --memory=1Gi --timeout=600 \
  --no-allow-unauthenticated
```

If the build fails with a permissions error on a new project, grant Cloud Build's
service account the builder role and retry:

```bash
PROJECT_NUMBER=$(gcloud projects describe $PROJECT_ID --format='value(projectNumber)')
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member=serviceAccount:$PROJECT_NUMBER-compute@developer.gserviceaccount.com \
  --role=roles/run.builder
```

## 3. Open the app

The service is **private** by default: Cloud Run rejects requests without a Google
identity token. That matters because the app spends your Maps quota, and
`/api/download` fetches up to 500 billable Street View images per call. The easiest
way in is a local proxy that adds your credentials:

```bash
gcloud run services proxy city-drive --project=$PROJECT_ID --region=us-central1 --port=3000
# then open http://localhost:3000
```

To make it public instead (anyone with the URL can use it and run up your Maps bill, so
set a [budget alert](https://console.cloud.google.com/billing/budgets) first):

```bash
gcloud run services add-iam-policy-binding city-drive \
  --project=$PROJECT_ID --region=us-central1 \
  --member=allUsers --role=roles/run.invoker
```

Deploys from GitHub Actions keep whichever access you choose.

## Limitations on Cloud Run

- **Saved frames are temporary.** `Save frames` writes to the container's in-memory
  disk, which is wiped whenever the instance restarts or scales to zero (after roughly
  15 minutes idle). Download what you need right after saving. The service is capped at
  one instance so the `/output/...` links keep working while it's up. Moving output to
  a Cloud Storage bucket is the fix if this becomes a problem.
- **The Maps key is visible to the browser** (the map needs it). The key the setup
  script creates is restricted to the three Maps APIs. If you make the service public,
  also add an HTTP-referrer restriction for your `*.run.app` URL, and put an
  unrestricted server key in a second secret mapped to `GOOGLE_MAPS_SERVER_KEY`
  (see `.env.example`).
