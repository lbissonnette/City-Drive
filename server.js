// City Drive proof-of-concept server. Zero dependencies (Node 18+).
//
//   GOOGLE_MAPS_API_KEY=... node server.js
//
// Serves the map UI, proxies driving-route requests to the Routes API, and
// downloads Street View Static images for a planned drive into ./output/.
// With VIDEO_BUCKET set, saved frames are also copied to Cloud Storage and
// /api/video queues a job for the GPU worker (see worker/README.md), starting
// the worker's VM if it is stopped. /api/gpu reports, starts and stops the VM,
// and /comfy/ proxies to ComfyUI on it for debugging (see comfy-proxy.js).

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const gcs = require('./gcs');
const prompts = require('./prompts');
const gpu = require('./compute');
const comfy = require('./comfy-proxy');

loadDotEnv(path.join(__dirname, '.env'));

const PORT = Number(process.env.PORT) || 3000;
const API_KEY = process.env.GOOGLE_MAPS_API_KEY;
// Optional separate key for server-side calls, so the browser key can be
// HTTP-referrer restricted. Falls back to the browser key.
const SERVER_KEY = process.env.GOOGLE_MAPS_SERVER_KEY || API_KEY;
const PUBLIC_DIR = path.join(__dirname, 'public');
const OUTPUT_DIR = path.join(__dirname, 'output');
const MAX_FRAMES = 500;
// Cloud Storage bucket shared with the GPU video worker. Empty = video disabled.
const VIDEO_BUCKET = process.env.VIDEO_BUCKET || '';
// ComfyUI workflow templates in worker/workflows/ and the clip shape each model
// was trained on. canvas() maps the saved image size to the generation size;
// grid [step, offset] is the frame counts the model accepts (step * k + offset).
const WORKFLOWS = {
  // MiniMax H3: 24 fps, frame counts on a 17k+5 grid (124 = ~5.2 s), 768 px short edge.
  minimax_h3_flf2v_turbo: { fps: 24, grid: [17, 5], canvas: h3Canvas },
  minimax_h3_flf2v: { fps: 24, grid: [17, 5], canvas: h3Canvas },
  // Wan 2.2: 16 fps, frame counts on a 4k+1 grid (81 = ~5 s), any size in multiples of 16.
  wan22_flf2v_fast: { fps: 16, grid: [4, 1], canvas: (w, h) => [w, h] },
  wan22_flf2v: { fps: 16, grid: [4, 1], canvas: (w, h) => [w, h] },
};
// Seconds of generated video between each pair of frames; the UI can change it per run.
const DEFAULT_CLIP_SECONDS = 5;
const MIN_CLIP_SECONDS = 1;
const MAX_CLIP_SECONDS = 15;
const DEFAULT_WORKFLOW = process.env.VIDEO_WORKFLOW || 'minimax_h3_flf2v_turbo';

if (!API_KEY) {
  console.error('Missing GOOGLE_MAPS_API_KEY. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
};

const COMFY_ENABLED = Boolean(VIDEO_BUCKET || comfy.COMFY_URL);
// Rough costs for the GPU panel's estimate. The default is about the spot price
// of a g4-standard-48 in us-central1 in Oct 2026; spot prices move, so set your
// own. The disk (300 GB Hyperdisk) is billed even while the VM is stopped.
const GPU_HOURLY_USD = Number(process.env.GPU_VM_HOURLY_USD) || 1.7;
const GPU_DISK_MONTHLY_USD = Number(process.env.GPU_VM_DISK_MONTHLY_USD) || 25;

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (COMFY_ENABLED && url.pathname === comfy.PREFIX) {
      res.writeHead(301, { Location: `${comfy.PREFIX}/` });
      return res.end();
    }
    if (COMFY_ENABLED && url.pathname.startsWith(`${comfy.PREFIX}/`)) return comfy.handle(req, res);
    if (req.method === 'GET' && url.pathname === '/config.js') {
      const config = {
        apiKey: API_KEY, videoEnabled: Boolean(VIDEO_BUCKET), defaultPrompt: prompts.DEFAULT_DRIVE_DESCRIPTION,
        clipSeconds: DEFAULT_CLIP_SECONDS, minClipSeconds: MIN_CLIP_SECONDS, maxClipSeconds: MAX_CLIP_SECONDS,
        gpuCost: { hourlyUsd: GPU_HOURLY_USD, diskMonthlyUsd: GPU_DISK_MONTHLY_USD },
        comfy: COMFY_ENABLED ? { url: `${comfy.PREFIX}/`, alwaysOn: Boolean(comfy.COMFY_URL) } : null,
      };
      return send(res, 200, `window.CITY_DRIVE_CONFIG = ${JSON.stringify(config)};`, MIME['.js']);
    }
    if (req.method === 'POST' && url.pathname === '/api/route') {
      return sendJson(res, 200, await computeRoute(await readJson(req)));
    }
    if (req.method === 'POST' && url.pathname === '/api/download') {
      return sendJson(res, 200, await downloadFrames(await readJson(req)));
    }
    if (req.method === 'GET' && url.pathname === '/api/videos') {
      return sendJson(res, 200, await recentVideos(Number(url.searchParams.get('limit')) || 20));
    }
    if (req.method === 'POST' && url.pathname === '/api/video') {
      return sendJson(res, 200, await createVideoJob(await readJson(req)));
    }
    if (url.pathname === '/api/gpu' || url.pathname.startsWith('/api/gpu/')) {
      if (!VIDEO_BUCKET) throw httpError(503, 'Video is not set up: VIDEO_BUCKET is empty');
      if (req.method === 'GET' && url.pathname === '/api/gpu') return sendJson(res, 200, await gpu.status());
      if (req.method === 'POST' && url.pathname === '/api/gpu/start') return sendJson(res, 200, await gpu.start());
      if (req.method === 'POST' && url.pathname === '/api/gpu/stop') return sendJson(res, 200, await gpu.stop());
    }
    const cancelMatch = url.pathname.match(/^\/api\/video\/([\w-]+)\/cancel$/);
    if (req.method === 'POST' && cancelMatch) return sendJson(res, 200, await cancelVideo(cancelMatch[1]));
    const videoMatch = url.pathname.match(/^\/api\/video\/([\w-]+)(\/drive\.mp4)?$/);
    if (req.method === 'GET' && videoMatch) {
      if (videoMatch[2]) return streamVideo(req, res, videoMatch[1], url.searchParams.has('download'));
      return sendJson(res, 200, await videoStatus(videoMatch[1]));
    }
    if (req.method === 'GET' && url.pathname.startsWith('/output/')) {
      return serveFile(res, OUTPUT_DIR, url.pathname.slice('/output/'.length));
    }
    if (req.method === 'GET') {
      return serveFile(res, PUBLIC_DIR, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
    }
    send(res, 405, 'Method not allowed');
  } catch (err) {
    console.error(err);
    sendJson(res, err.status || 500, { error: err.message });
  }
});

// ComfyUI's WebSocket; nothing else in the app upgrades.
server.on('upgrade', (req, socket, head) => {
  if (COMFY_ENABLED && req.url.startsWith(`${comfy.PREFIX}/`)) return comfy.upgrade(req, socket, head);
  socket.destroy();
});

server.listen(PORT, () => console.log(`City Drive running at http://localhost:${PORT}`));

// Snaps the user's clicked waypoints to a driving route using the Routes API.
// Returns an encoded polyline the browser decodes with the geometry library.
async function computeRoute({ waypoints }) {
  if (!Array.isArray(waypoints) || waypoints.length < 2) {
    throw httpError(400, 'Need at least two waypoints');
  }
  const toWaypoint = (p) => ({ location: { latLng: { latitude: p.lat, longitude: p.lng } } });
  const body = {
    origin: toWaypoint(waypoints[0]),
    destination: toWaypoint(waypoints[waypoints.length - 1]),
    intermediates: waypoints.slice(1, -1).map(toWaypoint),
    travelMode: 'DRIVE',
  };
  const resp = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': SERVER_KEY,
      'X-Goog-FieldMask': 'routes.polyline.encodedPolyline,routes.distanceMeters',
    },
    body: JSON.stringify(body),
  });
  const data = await resp.json();
  if (!resp.ok) throw httpError(502, `Routes API: ${data.error?.message || resp.status}`);
  const route = data.routes?.[0];
  if (!route) throw httpError(404, 'No driving route found between those points');
  return { encodedPolyline: route.polyline.encodedPolyline, distanceMeters: route.distanceMeters };
}

// Fetches a Street View Static image for each frame and writes them, plus a
// manifest, to output/<timestamp>/. Frames reference panoramas by ID, which is
// how historic imagery is requested (see README).
async function downloadFrames({ frames, size = '640x640', fov = 90, pitch = 0, label = 'drive' }) {
  if (!Array.isArray(frames) || frames.length === 0) throw httpError(400, 'No frames to download');
  if (frames.length > MAX_FRAMES) throw httpError(400, `At most ${MAX_FRAMES} frames per download`);
  if (!/^\d{2,4}x\d{2,4}$/.test(size)) throw httpError(400, 'size must look like 640x640');

  const runName = `${new Date().toISOString().replace(/[:.]/g, '-')}_${slug(label)}`;
  const runDir = path.join(OUTPUT_DIR, runName);
  fs.mkdirSync(runDir, { recursive: true });

  const results = [];
  // Small concurrency pool keeps this quick without hammering the API.
  let next = 0;
  async function worker() {
    while (next < frames.length) {
      const i = next++;
      const frame = frames[i];
      const file = `frame_${String(i + 1).padStart(4, '0')}.jpg`;
      const params = new URLSearchParams({
        pano: frame.pano,
        heading: String(frame.heading),
        pitch: String(pitch),
        fov: String(fov),
        size,
        return_error_code: 'true',
        key: SERVER_KEY,
      });
      try {
        const resp = await fetch(`https://maps.googleapis.com/maps/api/streetview?${params}`);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const bytes = Buffer.from(await resp.arrayBuffer());
        fs.writeFileSync(path.join(runDir, file), bytes);
        if (VIDEO_BUCKET) await gcs.upload(VIDEO_BUCKET, `runs/${runName}/${file}`, bytes, 'image/jpeg');
        results[i] = { ...frame, file, ok: true };
      } catch (err) {
        results[i] = { ...frame, file: null, ok: false, error: err.message };
      }
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker));

  const manifest = { createdAt: new Date().toISOString(), label, size, fov, pitch, frames: results };
  fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  if (VIDEO_BUCKET) await gcs.uploadJson(VIDEO_BUCKET, `runs/${runName}/manifest.json`, manifest);
  return {
    run: runName,
    inBucket: Boolean(VIDEO_BUCKET),
    saved: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    baseUrl: `/output/${runName}/`,
    frames: results,
  };
}

// Writes a stitching job for the GPU worker (worker/worker.py). The job doc
// lists the saved frames in order and the consecutive pairs to turn into
// clips, each with its own prompt (see prompts.js); the worker generates one
// clip per pair and concatenates them. `prompt` is the user's description of
// the drive, which prompts.js wraps in the model's prompt format.
//
//   gs://<bucket>/jobs/<id>/job.json     the instructions (below)
//   gs://<bucket>/jobs/<id>/status.json  written by the worker as it goes
//   gs://<bucket>/jobs/<id>/drive.mp4    the finished video
//   gs://<bucket>/queue/<id>.json        marker the worker picks up and deletes
async function createVideoJob({ run, prompt, negativePrompt, stride = 1, maxClips, clipSeconds, params = {} }) {
  if (!VIDEO_BUCKET) throw httpError(503, 'Video is not set up: VIDEO_BUCKET is empty');
  if (typeof run !== 'string' || !/^[\w.-]+$/.test(run)) throw httpError(400, 'run must be a saved run name');
  const manifest = await gcs.readJson(VIDEO_BUCKET, `runs/${run}/manifest.json`);
  if (!manifest) throw httpError(404, `No frames in the bucket for run ${run}. Save frames again.`);

  stride = Math.max(1, Math.floor(Number(stride) || 1));
  let frames = manifest.frames.filter((f) => f.ok);
  frames = frames.filter((_, i) => i % stride === 0 || i === frames.length - 1);
  if (maxClips) frames = frames.slice(0, Math.max(1, Number(maxClips)) + 1);
  const images = frames.map((f) => `runs/${run}/${f.file}`);
  if (images.length < 2) throw httpError(400, 'Need at least two saved frames to make a video');

  const workflow = params.workflow || DEFAULT_WORKFLOW;
  const preset = WORKFLOWS[workflow];
  if (!preset) throw httpError(400, `Unknown workflow ${workflow}`);
  clipSeconds = clipSeconds == null || clipSeconds === '' ? DEFAULT_CLIP_SECONDS : Number(clipSeconds);
  if (!(clipSeconds >= MIN_CLIP_SECONDS && clipSeconds <= MAX_CLIP_SECONDS)) {
    throw httpError(400, `Clip length must be between ${MIN_CLIP_SECONDS} and ${MAX_CLIP_SECONDS} seconds`);
  }
  const [width, height] = preset.canvas(...(manifest.size || '640x640').split('x').map(Number));
  const frameCount = Number(params.frames) || clipFrames(preset, clipSeconds);
  const fps = Number(params.fps) || preset.fps;
  const description = prompt || prompts.DEFAULT_DRIVE_DESCRIPTION;
  const id = `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${crypto.randomBytes(3).toString('hex')}`;
  const job = {
    version: 1,
    id,
    createdAt: new Date().toISOString(),
    run,
    label: manifest.label,
    workflow,
    prompt: description,
    negativePrompt: negativePrompt || prompts.DEFAULT_NEGATIVE_PROMPT,
    params: {
      width,
      height,
      frames: frameCount,
      fps,
      seed: Number.isInteger(params.seed) ? params.seed : crypto.randomInt(2 ** 31),
    },
    images,
    segments: images.slice(1).map((last, i) => ({
      index: i,
      first: images[i],
      last,
      prompt: prompts.clipPrompt(workflow, {
        seconds: frameCount / fps,
        turn: prompts.headingDelta(Number(frames[i].heading), Number(frames[i + 1].heading)),
        description,
      }),
    })),
    output: `jobs/${id}/drive.mp4`,
  };
  await gcs.uploadJson(VIDEO_BUCKET, `jobs/${id}/job.json`, job);
  await gcs.uploadJson(VIDEO_BUCKET, `jobs/${id}/status.json`, {
    state: 'queued', clipsDone: 0, clipsTotal: job.segments.length, updatedAt: job.createdAt,
  });
  await gcs.uploadJson(VIDEO_BUCKET, `queue/${id}.json`, { id, job: `jobs/${id}/job.json` });
  // Wake the worker. The job is already queued, so a failure here (no VM yet,
  // no spot capacity, missing permission) is reported rather than thrown.
  let vm;
  try {
    vm = await gpu.start();
  } catch (err) {
    console.error(err);
    vm = { status: 'UNKNOWN', error: err.message };
  }
  return {
    id, clips: job.segments.length, seconds: Math.round((job.segments.length * job.params.frames) / job.params.fps), vm,
  };
}

// Frame count closest to the requested clip length that the model accepts
// (5 s gives 124 for H3 and 81 for Wan 2.2, the counts they were trained on).
function clipFrames({ fps, grid: [step, offset] }, seconds) {
  return Math.max(1, Math.round((seconds * fps - offset) / step)) * step + offset;
}

// The newest jobs in the bucket, so a closed or reloaded page can find its videos
// again. Job ids start with a UTC timestamp, so they sort by age.
async function recentVideos(limit) {
  if (!VIDEO_BUCKET) throw httpError(503, 'Video is not set up: VIDEO_BUCKET is empty');
  const ids = (await gcs.listPrefixes(VIDEO_BUCKET, 'jobs/'))
    .map((p) => p.slice('jobs/'.length, -1))
    .filter((id) => /^[\w-]+$/.test(id))
    .sort()
    .reverse()
    .slice(0, Math.min(Math.max(limit, 1), 100));
  const jobs = await Promise.all(ids.map(async (id) => {
    const [job, status] = await Promise.all([
      gcs.readJson(VIDEO_BUCKET, `jobs/${id}/job.json`),
      gcs.readJson(VIDEO_BUCKET, `jobs/${id}/status.json`),
    ]);
    if (!job || !status) return null;
    return {
      id,
      createdAt: job.createdAt,
      label: job.label,
      run: job.run,
      clips: job.segments.length,
      seconds: Math.round((job.segments.length * job.params.frames) / job.params.fps),
      state: status.state,
      step: status.step,
      clipsDone: status.clipsDone,
      error: status.error,
      cancelRequested: Boolean(status.cancelRequested),
      videoUrl: status.state === 'done' ? `/api/video/${id}/drive.mp4` : null,
    };
  }));
  return { videos: jobs.filter(Boolean) };
}

// Queued: drop the queue marker so the worker never picks it up. Running: the
// worker sees jobs/<id>/cancel.json between status checks, interrupts ComfyUI and
// marks the job cancelled. The flag is written in both cases, which also covers a
// job the worker claims at the same moment.
async function cancelVideo(id) {
  if (!VIDEO_BUCKET) throw httpError(503, 'Video is not set up: VIDEO_BUCKET is empty');
  const status = await gcs.readJson(VIDEO_BUCKET, `jobs/${id}/status.json`);
  if (!status) throw httpError(404, 'No such video job');
  if (!['queued', 'running'].includes(status.state)) return { id, state: status.state };
  await gcs.uploadJson(VIDEO_BUCKET, `jobs/${id}/cancel.json`, { requestedAt: new Date().toISOString() });
  if (status.state === 'queued') {
    await gcs.remove(VIDEO_BUCKET, `queue/${id}.json`);
    const cancelled = { ...status, state: 'cancelled', updatedAt: new Date().toISOString() };
    await gcs.uploadJson(VIDEO_BUCKET, `jobs/${id}/status.json`, cancelled);
    return { id, state: 'cancelled' };
  }
  await gcs.uploadJson(VIDEO_BUCKET, `jobs/${id}/status.json`, { ...status, cancelRequested: true });
  return { id, state: 'cancelling' };
}

async function videoStatus(id) {
  if (!VIDEO_BUCKET) throw httpError(503, 'Video is not set up: VIDEO_BUCKET is empty');
  const status = await gcs.readJson(VIDEO_BUCKET, `jobs/${id}/status.json`);
  if (!status) throw httpError(404, 'No such video job');
  return { id, ...status, videoUrl: status.state === 'done' ? `/api/video/${id}/drive.mp4` : null };
}

// Cloud Run caps an HTTP/1 response with a Content-Length at 32 MiB, and a
// stitched drive is often bigger, so each Range response is at most this
// much; the browser asks for the next piece as it plays or seeks.
const VIDEO_CHUNK_BYTES = 8 * 1024 * 1024;

// Proxies the finished video from the (private) bucket, passing Range through
// (clamped to VIDEO_CHUNK_BYTES) so the browser can seek. ?download makes it a
// whole-file attachment, which works even when the browser can't play the encoding.
async function streamVideo(req, res, id, download) {
  if (!VIDEO_BUCKET) throw httpError(503, 'Video is not set up: VIDEO_BUCKET is empty');
  let range = download ? undefined : req.headers.range;
  const m = range && range.match(/^bytes=(\d+)-(\d*)$/);
  if (m) {
    const start = Number(m[1]);
    const end = m[2] ? Math.min(Number(m[2]), start + VIDEO_CHUNK_BYTES - 1) : start + VIDEO_CHUNK_BYTES - 1;
    range = `bytes=${start}-${end}`;
  }
  let upstream;
  try {
    upstream = await gcs.download(VIDEO_BUCKET, `jobs/${id}/drive.mp4`, range);
  } catch (err) {
    if (err.status === 416) return send(res, 416, 'Range not satisfiable');
    throw err;
  }
  const headers = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes' };
  if (download) headers['Content-Disposition'] = `attachment; filename="city-drive-${id}.mp4"`;
  // A whole-file (non-Range) response goes out chunked, with no Content-Length,
  // which Cloud Run streams without the size cap.
  const pass = upstream.status === 206 ? ['content-length', 'content-range'] : [];
  for (const h of pass) {
    if (upstream.headers.get(h)) headers[h] = upstream.headers.get(h);
  }
  res.writeHead(upstream.status, headers);
  Readable.fromWeb(upstream.body).pipe(res);
}

// H3's native canvas: 768 px short edge, at most 768x1344 pixels, multiples of 32
// (mirrors adapt_canvas in ComfyUI's nodes_minimax_h3.py).
function h3Canvas(width, height) {
  const ratio = width / height;
  let [w, h] = ratio >= 1 ? [768 * ratio, 768] : [768, 768 / ratio];
  const scale = Math.min(1, Math.sqrt((768 * 1344) / (w * h)));
  return [w, h].map((v) => Math.max(32, Math.round((v * scale) / 32) * 32));
}

function serveFile(res, root, relPath) {
  const filePath = path.normalize(path.join(root, decodeURIComponent(relPath)));
  if (!filePath.startsWith(root + path.sep)) return send(res, 403, 'Forbidden');
  fs.readFile(filePath, (err, data) => {
    if (err) return send(res, 404, 'Not found');
    send(res, 200, data, MIME[path.extname(filePath)] || 'application/octet-stream');
  });
}

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type });
  res.end(body);
}

function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), MIME['.json']);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 5e6) reject(httpError(413, 'Request too large'));
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch {
        reject(httpError(400, 'Invalid JSON'));
      }
    });
  });
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'drive';
}

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
