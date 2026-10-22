// Starts, stops and reports on the GPU worker VM (scripts/gpu-vm.sh creates it)
// through the Compute Engine REST API. Same credentials as gcs.js; on Cloud Run
// the runtime service account needs the cityDriveGpuControl role that
// scripts/gcp-setup.sh grants.

const { accessToken } = require('./gcs');

const VM_NAME = process.env.GPU_VM_NAME || 'city-drive-gpu';
const API = 'https://compute.googleapis.com/compute/v1';
const PROJECT_ID_URL = 'http://metadata.google.internal/computeMetadata/v1/project/project-id';

let projectId = process.env.GCP_PROJECT_ID || '';
let zone = process.env.GPU_VM_ZONE || '';

async function project() {
  if (projectId) return projectId;
  try {
    const resp = await fetch(PROJECT_ID_URL, { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(1000) });
    if (resp.ok) projectId = (await resp.text()).trim();
  } catch {}
  if (!projectId) throw Object.assign(new Error('Set GCP_PROJECT_ID to control the GPU VM'), { status: 503 });
  return projectId;
}

async function request(url, method = 'GET') {
  const resp = await fetch(url, { method, headers: { Authorization: `Bearer ${await accessToken()}` } });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const err = new Error(`Compute ${method} ${url.replace(API, '')}: ${data.error?.message || `HTTP ${resp.status}`}`);
    err.status = resp.status;
    throw err;
  }
  return data;
}

// The VM's zone is wherever gpu-vm.sh put it, so look it up once and remember it.
async function findZone() {
  if (zone) return zone;
  const filter = encodeURIComponent(`name = "${VM_NAME}"`);
  const data = await request(`${API}/projects/${await project()}/aggregated/instances?filter=${filter}&returnPartialSuccess=true`);
  for (const [key, scoped] of Object.entries(data.items || {})) {
    if (scoped.instances?.length) return (zone = key.replace(/^zones\//, ''));
  }
  return null;
}

const instanceUrl = async (z) => `${API}/projects/${await project()}/zones/${z}/instances/${VM_NAME}`;

// { name, zone, status, internalIp, startedAt } where status is a GCE instance status
// (RUNNING, TERMINATED = stopped, STAGING, STOPPING, ...) or MISSING if
// gpu-vm.sh up hasn't created the VM yet. internalIp is the VM's VPC address,
// which the /comfy/ proxy in server.js connects to. startedAt is when the
// current run began (null unless RUNNING), for the app's uptime and cost.
async function status() {
  const z = await findZone();
  if (!z) return { name: VM_NAME, zone: null, status: 'MISSING' };
  try {
    const vm = await request(await instanceUrl(z));
    return {
      name: VM_NAME,
      zone: z,
      status: vm.status,
      internalIp: vm.networkInterfaces?.[0]?.networkIP || null,
      startedAt: vm.status === 'RUNNING' ? vm.lastStartTimestamp || null : null,
    };
  } catch (err) {
    if (err.status !== 404) throw err;
    zone = process.env.GPU_VM_ZONE || ''; // deleted or recreated elsewhere
    return { name: VM_NAME, zone: null, status: 'MISSING' };
  }
}

function missing() {
  return Object.assign(new Error(`GPU VM ${VM_NAME} doesn't exist yet. Create it with scripts/gpu-vm.sh up.`), { status: 409 });
}

// Starting a stopped VM keeps its disk, metadata and installed models; the
// worker comes back up on its own. Spot capacity can be short, in which case
// the API error says so.
async function start() {
  const s = await status();
  if (s.status === 'MISSING') throw missing();
  if (['TERMINATED', 'STOPPED', 'SUSPENDED'].includes(s.status)) {
    await request(`${await instanceUrl(s.zone)}/${s.status === 'SUSPENDED' ? 'resume' : 'start'}`, 'POST');
    return { ...s, status: 'STAGING', startedAt: null };
  }
  return s;
}

async function stop() {
  const s = await status();
  if (s.status === 'MISSING') throw missing();
  if (['RUNNING', 'STAGING', 'PROVISIONING', 'REPAIRING'].includes(s.status)) {
    await request(`${await instanceUrl(s.zone)}/stop`, 'POST');
    return { ...s, status: 'STOPPING', startedAt: null };
  }
  return s;
}

module.exports = { status, start, stop };
