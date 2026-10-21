// City Drive proof-of-concept server. Zero dependencies (Node 18+).
//
//   GOOGLE_MAPS_API_KEY=... node server.js
//
// Serves the map UI, proxies driving-route requests to the Routes API, and
// downloads Street View Static images for a planned drive into ./output/.

const http = require('http');
const fs = require('fs');
const path = require('path');

loadDotEnv(path.join(__dirname, '.env'));

const PORT = Number(process.env.PORT) || 3000;
const API_KEY = process.env.GOOGLE_MAPS_API_KEY;
// Optional separate key for server-side calls, so the browser key can be
// HTTP-referrer restricted. Falls back to the browser key.
const SERVER_KEY = process.env.GOOGLE_MAPS_SERVER_KEY || API_KEY;
const PUBLIC_DIR = path.join(__dirname, 'public');
const OUTPUT_DIR = path.join(__dirname, 'output');
const MAX_FRAMES = 500;

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

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === 'GET' && url.pathname === '/config.js') {
      return send(res, 200, `window.CITY_DRIVE_CONFIG = ${JSON.stringify({ apiKey: API_KEY })};`, MIME['.js']);
    }
    if (req.method === 'POST' && url.pathname === '/api/route') {
      return sendJson(res, 200, await computeRoute(await readJson(req)));
    }
    if (req.method === 'POST' && url.pathname === '/api/download') {
      return sendJson(res, 200, await downloadFrames(await readJson(req)));
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
        fs.writeFileSync(path.join(runDir, file), Buffer.from(await resp.arrayBuffer()));
        results[i] = { ...frame, file, ok: true };
      } catch (err) {
        results[i] = { ...frame, file: null, ok: false, error: err.message };
      }
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker));

  const manifest = { createdAt: new Date().toISOString(), label, size, fov, pitch, frames: results };
  fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return {
    run: runName,
    saved: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    baseUrl: `/output/${runName}/`,
    frames: results,
  };
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
