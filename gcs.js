// Minimal Cloud Storage client over the JSON API, so the server stays
// zero-dependency. Auth comes from the metadata server on Cloud Run/GCE, or
// from `gcloud auth print-access-token` when running locally.

const { execFile } = require('child_process');

const METADATA_TOKEN_URL =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';

let cached = { token: null, expires: 0 };

async function accessToken() {
  if (cached.token && Date.now() < cached.expires - 60_000) return cached.token;
  try {
    const resp = await fetch(METADATA_TOKEN_URL, {
      headers: { 'Metadata-Flavor': 'Google' },
      signal: AbortSignal.timeout(1000),
    });
    if (!resp.ok) throw new Error(`metadata server: HTTP ${resp.status}`);
    const data = await resp.json();
    cached = { token: data.access_token, expires: Date.now() + data.expires_in * 1000 };
  } catch {
    // Not on Google Cloud: use the developer's gcloud login.
    const token = await new Promise((resolve, reject) => {
      execFile('gcloud', ['auth', 'print-access-token'], (err, stdout) =>
        err ? reject(new Error('No GCS credentials: run `gcloud auth login`')) : resolve(stdout.trim()));
    });
    cached = { token, expires: Date.now() + 30 * 60_000 };
  }
  return cached.token;
}

async function request(url, init = {}) {
  const headers = { Authorization: `Bearer ${await accessToken()}`, ...init.headers };
  const resp = await fetch(url, { ...init, headers });
  if (!resp.ok && resp.status !== 206) {
    const err = new Error(`GCS ${init.method || 'GET'} ${url}: HTTP ${resp.status} ${await resp.text()}`);
    err.status = resp.status;
    throw err;
  }
  return resp;
}

const objectUrl = (bucket, name) =>
  `https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encodeURIComponent(name)}`;

async function upload(bucket, name, body, contentType) {
  const url = `https://storage.googleapis.com/upload/storage/v1/b/${bucket}/o?uploadType=media&name=${encodeURIComponent(name)}`;
  await request(url, { method: 'POST', headers: { 'Content-Type': contentType }, body });
}

const uploadJson = (bucket, name, obj) =>
  upload(bucket, name, JSON.stringify(obj, null, 2), 'application/json');

// Returns the parsed object, or null if it doesn't exist.
async function readJson(bucket, name) {
  try {
    return await (await request(`${objectUrl(bucket, name)}?alt=media`)).json();
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

// Raw fetch Response for the object's bytes; forwards a Range header if given.
function download(bucket, name, range) {
  return request(`${objectUrl(bucket, name)}?alt=media`, { headers: range ? { Range: range } : {} });
}

module.exports = { upload, uploadJson, readJson, download };
