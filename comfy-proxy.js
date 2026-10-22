// Reverse proxy from the app's /comfy/ path to ComfyUI on the GPU worker VM,
// so its web UI can be opened from the app for checking and debugging
// workflows. ComfyUI's frontend uses relative URLs, so it works under a prefix.
//
// On Cloud Run the app reaches the VM's internal IP on port 8188 over Direct
// VPC egress (see .github/workflows/deploy.yml); the IP comes from the Compute
// API via compute.js. Locally, open an SSH tunnel with `scripts/gpu-vm.sh
// tunnel` and set COMFY_URL=http://localhost:8188. COMFY_URL also works on Cloud
// Run (repo variable GCP_COMFY_URL, http://<VM internal IP>:8188) to skip the
// lookup, e.g. when the runtime service account can't read the VM.
//
// Access control is the app's: Cloud Run only lets in people with run.invoker.

const http = require('http');
const gpu = require('./compute');

const PREFIX = '/comfy';
const COMFY_PORT = 8188;
const COMFY_URL = process.env.COMFY_URL || '';

// The UI loads hundreds of files, so look the VM's IP up once a minute, not per request.
let cached = { target: null, expires: 0 };

async function target() {
  if (COMFY_URL) return new URL(COMFY_URL);
  if (cached.target && Date.now() < cached.expires) return cached.target;
  let s;
  try {
    s = await gpu.status();
  } catch (err) {
    if (err.status !== 403) throw err;
    throw Object.assign(new Error(`The app isn't allowed to look up the GPU VM's address (${err.message}). ` +
      'Re-run scripts/gcp-setup.sh to grant it, or set the GCP_COMFY_URL repo variable to ' +
      'http://<VM internal IP>:8188 to skip the lookup.'), { status: 503 });
  }
  if (s.status !== 'RUNNING' || !s.internalIp) {
    const state = s.status === 'MISSING' ? 'not created yet' : `not running (${s.status.toLowerCase()})`;
    throw Object.assign(new Error(`The GPU VM is ${state}. Start it from the app's video step, then reload this page.`), { status: 503 });
  }
  cached = { target: new URL(`http://${s.internalIp}:${COMFY_PORT}`), expires: Date.now() + 60_000 };
  return cached.target;
}

function upstreamOptions(req, t) {
  const headers = { ...req.headers, host: t.host };
  // ComfyUI rejects requests whose Origin doesn't match its Host (a CSRF guard),
  // and the browser's Origin is the app's.
  delete headers.origin;
  // Cloud Run's credentials for the app; ComfyUI has no use for them.
  delete headers.authorization;
  return {
    hostname: t.hostname,
    port: t.port || 80,
    method: req.method,
    path: req.url.slice(PREFIX.length) || '/',
    headers,
  };
}

async function handle(req, res) {
  let t;
  try {
    t = await target();
  } catch (err) {
    return errorPage(res, err.status || 502, err.message);
  }
  const upstream = http.request(upstreamOptions(req, t), (up) => {
    const headers = { ...up.headers };
    if (headers.location?.startsWith('/')) headers.location = PREFIX + headers.location;
    res.writeHead(up.statusCode, headers);
    up.pipe(res);
  });
  upstream.on('error', (err) => {
    cached.expires = 0; // the VM may have stopped or moved; look again next time
    if (res.headersSent) return res.destroy();
    errorPage(res, 502, `Can't reach ComfyUI at ${t.host} (${err.code || err.message}). ` +
      'If the VM just started, ComfyUI takes a minute or two to come up.');
  });
  req.pipe(upstream);
}

// ComfyUI's live progress comes over a WebSocket (/ws). Cloud Run cuts it at
// the request timeout and the UI reconnects on its own.
async function upgrade(req, socket, head) {
  socket.on('error', () => {});
  let t;
  try {
    t = await target();
  } catch {
    return socket.destroy();
  }
  const upstream = http.request(upstreamOptions(req, t));
  upstream.on('upgrade', (up, upSocket, upHead) => {
    let reply = 'HTTP/1.1 101 Switching Protocols\r\n';
    for (let i = 0; i < up.rawHeaders.length; i += 2) reply += `${up.rawHeaders[i]}: ${up.rawHeaders[i + 1]}\r\n`;
    socket.write(`${reply}\r\n`);
    if (upHead.length) socket.write(upHead);
    if (head.length) upSocket.write(head);
    upSocket.on('error', () => socket.destroy());
    socket.on('close', () => upSocket.destroy());
    upSocket.pipe(socket).pipe(upSocket);
  });
  upstream.on('response', (up) => {
    socket.end(`HTTP/1.1 ${up.statusCode} ${up.statusMessage}\r\nConnection: close\r\n\r\n`);
  });
  upstream.on('error', () => {
    cached.expires = 0;
    socket.destroy();
  });
  upstream.end();
}

function errorPage(res, status, message) {
  const esc = (s) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><meta charset="utf-8"><title>ComfyUI unavailable</title>
<body style="font:16px system-ui,sans-serif;max-width:40em;margin:3em auto;padding:0 1em">
<h1>ComfyUI is not reachable</h1><p>${esc(message)}</p>
<p><a href="${PREFIX}/">Try again</a> · <a href="/">Back to City Drive</a></p>`);
}

module.exports = { PREFIX, COMFY_URL, handle, upgrade };
