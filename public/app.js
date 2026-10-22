// City Drive browser app.
//
// Flow: click waypoints -> route (Routes API via our server) -> sample points
// every N metres -> ask StreetViewService for the panorama at each point,
// including its historic "time machine" panoramas -> pick one panorama per
// point for the chosen year -> preview/download via Street View Static API
// using the panorama ID.

const MAX_SAMPLES = 500;
const SCAN_CONCURRENCY = 8;
const PREVIEW_SIZE = '640x400';

const $ = (id) => document.getElementById(id);
const state = {
  map: null,
  sv: null,
  waypoints: [],     // google.maps.Marker[]
  routeLine: null,   // google.maps.Polyline
  path: [],          // google.maps.LatLng[] (the drive)
  samples: [],       // { latLng, heading, candidates: [{ pano, date }] }
  frames: [],        // { pano, date, heading, lat, lng }
  frameIndex: 0,
  playing: null,
  carMarker: null,
  savedRun: null,    // { run, frames } from the last save, for the video step
  videoPoll: null,
  gpuPoll: null,
  gpuStatus: null,  // last /api/gpu status
  videoRunning: false,
};

loadMaps();

function loadMaps() {
  const key = window.CITY_DRIVE_CONFIG?.apiKey;
  const script = document.createElement('script');
  script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&libraries=geometry&v=weekly&callback=initMap&loading=async`;
  script.async = true;
  script.onerror = () => setStatus('routeInfo', 'Could not load Google Maps. Check your API key.', true);
  document.head.appendChild(script);
}

window.initMap = function initMap() {
  state.map = new google.maps.Map($('map'), {
    center: { lat: 40.7580, lng: -73.9855 }, // Times Square
    zoom: 16,
    streetViewControl: true,
    clickableIcons: false,
  });
  state.sv = new google.maps.StreetViewService();
  // Shows blue Street View coverage lines so you can see where imagery exists.
  new google.maps.StreetViewCoverageLayer().setMap(state.map);

  state.map.addListener('click', (e) => addWaypoint(e.latLng));
  $('undoBtn').onclick = undoWaypoint;
  $('clearBtn').onclick = clearAll;
  $('followRoads').onchange = rebuildRoute;
  $('spacing').oninput = updateSampleInfo;
  $('scanBtn').onclick = scanRoute;
  $('yearSelect').onchange = buildFrames;
  $('fallback').onchange = buildFrames;
  $('fov').onchange = () => showFrame(state.frameIndex);
  $('playBtn').onclick = togglePlay;
  $('frameSlider').oninput = (e) => showFrame(Number(e.target.value));
  $('downloadBtn').onclick = downloadFrames;
  $('videoSection').hidden = !window.CITY_DRIVE_CONFIG?.videoEnabled;
  $('videoPrompt').value = window.CITY_DRIVE_CONFIG?.defaultPrompt || '';
  $('videoStride').oninput = updateVideoInfo;
  const cfg = window.CITY_DRIVE_CONFIG || {};
  if (cfg.clipSeconds) $('videoClipSeconds').value = cfg.clipSeconds;
  if (cfg.minClipSeconds) $('videoClipSeconds').min = cfg.minClipSeconds;
  if (cfg.maxClipSeconds) $('videoClipSeconds').max = cfg.maxClipSeconds;
  $('videoClipSeconds').oninput = updateVideoInfo;
  $('videoBtn').onclick = makeVideo;
  $('gpuStartBtn').onclick = () => gpuAction('start');
  $('gpuStopBtn').onclick = () => gpuAction('stop');
  const comfy = window.CITY_DRIVE_CONFIG?.comfy;
  if (comfy) {
    $('comfyBtn').hidden = false;
    $('comfyBtn').disabled = !comfy.alwaysOn;
    $('comfyBtn').onclick = () => window.open(comfy.url, '_blank');
  }
  if (window.CITY_DRIVE_CONFIG?.videoEnabled) pollGpu();
};

// ---------- 1. Route ----------

function addWaypoint(latLng) {
  const marker = new google.maps.Marker({
    position: latLng,
    map: state.map,
    label: String(state.waypoints.length + 1),
    draggable: true,
  });
  marker.addListener('dragend', rebuildRoute);
  state.waypoints.push(marker);
  rebuildRoute();
}

function undoWaypoint() {
  state.waypoints.pop()?.setMap(null);
  rebuildRoute();
}

function clearAll() {
  state.waypoints.forEach((m) => m.setMap(null));
  state.waypoints = [];
  rebuildRoute();
}

let routeRequestId = 0;
async function rebuildRoute() {
  const requestId = ++routeRequestId;
  resetScan();
  const points = state.waypoints.map((m) => m.getPosition());
  if (points.length < 2) {
    setPath([]);
    setStatus('routeInfo', points.length ? 'Add another point to make a route.' : 'No route yet.');
    return;
  }
  if (!$('followRoads').checked) {
    setPath(points);
    return;
  }
  setStatus('routeInfo', 'Finding driving route…');
  try {
    const resp = await fetch('/api/route', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ waypoints: points.map((p) => ({ lat: p.lat(), lng: p.lng() })) }),
    });
    const data = await resp.json();
    if (requestId !== routeRequestId) return; // a newer edit superseded this one
    if (!resp.ok) throw new Error(data.error);
    setPath(google.maps.geometry.encoding.decodePath(data.encodedPolyline));
  } catch (err) {
    if (requestId !== routeRequestId) return;
    setPath(points);
    setStatus('routeInfo', `Routing failed (${err.message}). Using straight lines instead.`, true);
  }
}

function setPath(path) {
  state.path = path;
  state.routeLine?.setMap(null);
  state.routeLine = path.length
    ? new google.maps.Polyline({ path, map: state.map, strokeColor: '#e8710a', strokeWeight: 5, strokeOpacity: 0.85 })
    : null;
  if (path.length) {
    const metres = google.maps.geometry.spherical.computeLength(path);
    setStatus('routeInfo', `Route: ${(metres / 1000).toFixed(2)} km.`);
  }
  updateSampleInfo();
}

// ---------- 2. Scan ----------

function samplePath(path, spacing) {
  const { computeDistanceBetween, computeHeading, interpolate } = google.maps.geometry.spherical;
  const points = [];
  if (path.length < 2) return points;
  points.push(path[0]);
  let carried = 0; // distance travelled since the last emitted sample
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    const seg = computeDistanceBetween(a, b);
    let d = spacing - carried;
    while (d <= seg) {
      points.push(interpolate(a, b, d / seg));
      d += spacing;
    }
    carried = (carried + seg) % spacing;
  }
  // Heading for each sample points towards the next one (the direction of travel).
  return points.map((p, i) => {
    const next = points[i + 1] || points[i];
    const prev = points[i - 1] || points[i];
    const heading = i < points.length - 1 ? computeHeading(p, next) : computeHeading(prev, p);
    return { latLng: p, heading: (heading + 360) % 360, candidates: [] };
  });
}

function updateSampleInfo() {
  const n = state.path.length ? samplePath(state.path, spacing()).length : 0;
  $('scanBtn').disabled = n === 0;
  $('sampleInfo').textContent = n
    ? `${n} sample points${n > MAX_SAMPLES ? ` (over the ${MAX_SAMPLES} limit, increase spacing)` : ''}.`
    : '';
  $('scanBtn').disabled = n === 0 || n > MAX_SAMPLES;
}

function spacing() {
  return Math.max(5, Number($('spacing').value) || 15);
}

async function scanRoute() {
  resetScan();
  const samples = samplePath(state.path, spacing());
  state.samples = samples;
  const progress = $('scanProgress');
  progress.hidden = false;
  progress.max = samples.length;
  progress.value = 0;
  $('scanBtn').disabled = true;
  setStatus('scanInfo', 'Scanning…');

  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < samples.length) {
      const s = samples[next++];
      s.candidates = await panoramasAt(s.latLng);
      progress.value = ++done;
    }
  };
  await Promise.all(Array.from({ length: SCAN_CONCURRENCY }, worker));
  await fillMissingDates(samples);

  progress.hidden = true;
  $('scanBtn').disabled = false;
  const covered = samples.filter((s) => s.candidates.length).length;
  setStatus('scanInfo', `${covered} of ${samples.length} points have Street View imagery.`);
  renderYears();
  buildFrames();
}

// Returns every panorama (current + historic) available at a location.
async function panoramasAt(latLng) {
  const request = { location: latLng, radius: 25, preference: google.maps.StreetViewPreference.NEAREST };
  // Exclude user-uploaded photospheres; we want Google's car imagery.
  if (google.maps.StreetViewSource.GOOGLE) request.sources = [google.maps.StreetViewSource.GOOGLE];
  else request.source = google.maps.StreetViewSource.OUTDOOR;

  let data;
  try {
    ({ data } = await state.sv.getPanorama(request));
  } catch {
    return []; // ZERO_RESULTS: no coverage here
  }
  const byPano = new Map();
  byPano.set(data.location.pano, { pano: data.location.pano, date: normaliseDate(data.imageDate) });
  // `data.time` lists the historic panoramas at this spot (what the Google Maps
  // "See more dates" time machine shows). Each entry has a `pano` id and a Date
  // stored under a minified property name, so we look for the Date by type.
  for (const entry of data.time || []) {
    if (!entry?.pano || byPano.has(entry.pano)) continue;
    const dateValue = Object.values(entry).find((v) => v instanceof Date);
    byPano.set(entry.pano, { pano: entry.pano, date: dateValue ? toYearMonth(dateValue) : null });
  }
  return [...byPano.values()];
}

// If a historic entry had no readable date, ask for that panorama directly;
// `imageDate` on a pano lookup is part of the documented API.
async function fillMissingDates(samples) {
  const missing = new Map();
  samples.forEach((s) => s.candidates.forEach((c) => !c.date && missing.set(c.pano, null)));
  for (const pano of missing.keys()) {
    try {
      const { data } = await state.sv.getPanorama({ pano });
      missing.set(pano, normaliseDate(data.imageDate));
    } catch { /* leave undated */ }
  }
  samples.forEach((s) => s.candidates.forEach((c) => { if (!c.date) c.date = missing.get(c.pano); }));
}

function normaliseDate(imageDate) {
  // imageDate is "YYYY-MM"
  return /^\d{4}-\d{2}/.test(imageDate || '') ? imageDate.slice(0, 7) : null;
}

function toYearMonth(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function renderYears() {
  // Count how many sample points have at least one panorama from each year.
  const counts = new Map();
  for (const s of state.samples) {
    const years = new Set(s.candidates.map((c) => c.date?.slice(0, 4)).filter(Boolean));
    years.forEach((y) => counts.set(y, (counts.get(y) || 0) + 1));
  }
  const years = [...counts.keys()].sort();
  const select = $('yearSelect');
  select.innerHTML = '<option value="latest">Latest available</option>' +
    years.map((y) => `<option value="${y}">${y} (${counts.get(y)} pts)</option>`).join('');
  select.disabled = years.length === 0;

  const total = state.samples.length || 1;
  $('yearChart').innerHTML = years.map((y) => `
    <div class="bar" data-year="${y}" title="${counts.get(y)} of ${total} points">
      <span>${y}</span><span class="fill" style="width:${Math.max(2, (counts.get(y) / total) * 220)}px"></span>
      <span>${Math.round((counts.get(y) / total) * 100)}%</span>
    </div>`).join('');
  $('yearChart').querySelectorAll('.bar').forEach((el) => {
    el.onclick = () => { select.value = el.dataset.year; buildFrames(); };
  });
}

// ---------- 3. Frames for the chosen year ----------

function buildFrames() {
  const year = $('yearSelect').value;
  const fallback = $('fallback').checked;
  const frames = [];
  let exact = 0;
  let filled = 0;
  for (const s of state.samples) {
    const pick = choosePano(s.candidates, year, fallback);
    if (!pick) continue;
    if (pick.exact) exact++; else filled++;
    // Neighbouring samples often land on the same panorama; one frame each.
    if (frames.length && frames[frames.length - 1].pano === pick.pano) continue;
    frames.push({ pano: pick.pano, date: pick.date, heading: Math.round(s.heading), lat: s.latLng.lat(), lng: s.latLng.lng() });
  }
  state.frames = frames;
  document.querySelectorAll('.bar').forEach((el) => el.classList.toggle('selected', el.dataset.year === year));

  if (!state.samples.length) return;
  const label = year === 'latest' ? 'latest imagery' : year;
  setStatus('frameInfo', `${frames.length} unique frames for ${label}. ` +
    (year === 'latest' ? '' : `${exact} points matched ${year}${fallback ? `, ${filled} filled from nearby years` : ''}.`));
  $('downloadBtn').disabled = frames.length === 0;
  $('viewer').hidden = frames.length === 0;
  $('frameSlider').max = Math.max(0, frames.length - 1);
  showFrame(0);
}

function choosePano(candidates, year, fallback) {
  const dated = candidates.filter((c) => c.date).sort((a, b) => a.date.localeCompare(b.date));
  if (!dated.length) return candidates[0] ? { ...candidates[0], exact: year === 'latest' } : null;
  if (year === 'latest') return { ...dated[dated.length - 1], exact: true };
  const inYear = dated.filter((c) => c.date.startsWith(year));
  if (inYear.length) return { ...inYear[inYear.length - 1], exact: true };
  if (!fallback) return null;
  const target = Number(year) + 0.5;
  const yearsOf = (c) => Number(c.date.slice(0, 4)) + (Number(c.date.slice(5, 7)) - 0.5) / 12;
  const nearest = dated.reduce((best, c) => (Math.abs(yearsOf(c) - target) < Math.abs(yearsOf(best) - target) ? c : best));
  return { ...nearest, exact: false };
}

// ---------- 4. Preview + download ----------

function staticUrl(frame, size = PREVIEW_SIZE) {
  const params = new URLSearchParams({
    size, pano: frame.pano, heading: frame.heading, pitch: 0, fov: $('fov').value,
    key: window.CITY_DRIVE_CONFIG.apiKey,
  });
  return `https://maps.googleapis.com/maps/api/streetview?${params}`;
}

function showFrame(i) {
  const frame = state.frames[i];
  if (!frame) return;
  state.frameIndex = i;
  $('frameImg').src = staticUrl(frame);
  $('frameSlider').value = i;
  $('frameLabel').textContent = `${i + 1} / ${state.frames.length} · ${frame.date || 'date unknown'}`;
  const pos = { lat: frame.lat, lng: frame.lng };
  if (!state.carMarker) {
    state.carMarker = new google.maps.Marker({
      map: state.map,
      icon: { path: google.maps.SymbolPath.FORWARD_CLOSED_ARROW, scale: 5, fillColor: '#1a73e8', fillOpacity: 1, strokeColor: '#fff', strokeWeight: 1.5 },
      zIndex: 999,
    });
  }
  state.carMarker.setPosition(pos);
  state.carMarker.setIcon({ ...state.carMarker.getIcon(), rotation: frame.heading });
  state.carMarker.setMap(state.map);
}

function togglePlay() {
  if (state.playing) return stopPlaying();
  $('playBtn').textContent = 'Pause';
  // Wait for each image to load before advancing, so playback never outruns the API.
  const step = () => {
    if (!state.playing) return;
    if (state.frameIndex >= state.frames.length - 1) return stopPlaying();
    const img = $('frameImg');
    img.onload = img.onerror = () => { img.onload = img.onerror = null; state.playing = setTimeout(step, 250); };
    showFrame(state.frameIndex + 1);
  };
  state.playing = setTimeout(step, 0);
}

function stopPlaying() {
  clearTimeout(state.playing);
  state.playing = null;
  $('playBtn').textContent = 'Play';
}

async function downloadFrames() {
  const year = $('yearSelect').value;
  $('downloadBtn').disabled = true;
  setStatus('downloadInfo', `Downloading ${state.frames.length} frames…`);
  try {
    const resp = await fetch('/api/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ frames: state.frames, fov: Number($('fov').value), size: '640x640', label: year }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error);
    $('downloadInfo').innerHTML = `Saved ${data.saved} frames${data.failed ? `, ${data.failed} failed` : ''} to ` +
      `<code>output/${data.run}/</code> (<a href="${data.baseUrl}manifest.json" target="_blank">manifest</a>).`;
    $('downloadInfo').classList.remove('error');
    state.savedRun = data.inBucket ? { run: data.run, frames: data.saved } : null;
    updateVideoInfo();
  } catch (err) {
    setStatus('downloadInfo', `Download failed: ${err.message}`, true);
  } finally {
    $('downloadBtn').disabled = false;
  }
}

// ---------- 5. Video (GPU worker) ----------

function videoStride() {
  return Math.max(1, Math.floor(Number($('videoStride').value) || 1));
}

function videoClipSeconds() {
  const input = $('videoClipSeconds');
  const seconds = Number(input.value) || window.CITY_DRIVE_CONFIG?.clipSeconds || 5;
  return Math.min(Number(input.max), Math.max(Number(input.min), seconds));
}

function updateVideoInfo() {
  const saved = state.savedRun;
  $('videoBtn').disabled = !saved || saved.frames < 2;
  if (!saved) return setStatus('videoInfo', 'Save frames first.');
  // Matches the server's selection: every Nth frame plus the last one.
  const used = Math.ceil(saved.frames / videoStride()) + ((saved.frames - 1) % videoStride() ? 1 : 0);
  const clips = Math.max(0, used - 1);
  setStatus('videoInfo', `${clips} clips from run ${saved.run}, about ${Math.round(clips * videoClipSeconds())} s of video.`);
}

async function makeVideo() {
  $('videoBtn').disabled = true;
  $('videoPlayer').hidden = true;
  setStatus('videoStatus', 'Queueing…');
  try {
    const resp = await fetch('/api/video', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        run: state.savedRun.run, prompt: $('videoPrompt').value, stride: videoStride(), clipSeconds: videoClipSeconds(),
      }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error);
    state.videoRunning = true;
    if (data.vm?.error) setStatus('gpuStatus', `GPU worker: could not start it (${data.vm.error})`, true);
    pollVideo(data.id);
    pollGpu();
  } catch (err) {
    setStatus('videoStatus', `Could not queue the video: ${err.message}`, true);
    $('videoBtn').disabled = false;
  }
}

async function pollVideo(id) {
  clearTimeout(state.videoPoll);
  try {
    const resp = await fetch(`/api/video/${id}`);
    const s = await resp.json();
    if (!resp.ok) throw new Error(s.error);
    const progress = s.state === 'running' ? ` (${s.step || 'clips'}: ${s.clipsDone}/${s.clipsTotal})` : '';
    setStatus('videoStatus', `Job ${id}: ${s.state}${progress}${s.error ? ` – ${s.error}` : ''}`, s.state === 'failed');
    if (s.state === 'done') {
      $('videoPlayer').src = s.videoUrl;
      $('videoPlayer').hidden = false;
    }
    if (s.state === 'done' || s.state === 'failed') {
      $('videoBtn').disabled = false;
      state.videoRunning = false;
      return;
    }
  } catch (err) {
    setStatus('videoStatus', `Job ${id}: status check failed (${err.message}), retrying`, true);
  }
  state.videoPoll = setTimeout(() => pollVideo(id), 10000);
}

// ---------- GPU worker VM ----------

const GPU_LABELS = {
  RUNNING: 'running',
  TERMINATED: 'stopped',
  STOPPED: 'stopped',
  SUSPENDED: 'suspended',
  PROVISIONING: 'starting…',
  STAGING: 'starting…',
  STOPPING: 'stopping…',
  SUSPENDING: 'suspending…',
  REPAIRING: 'being repaired by Google Cloud',
  MISSING: 'not created yet (run scripts/gpu-vm.sh up)',
};
const GPU_SETTLED = ['RUNNING', 'TERMINATED', 'STOPPED', 'SUSPENDED', 'MISSING'];

function showGpu(s) {
  state.gpuStatus = s.status;
  const where = s.zone ? ` in ${s.zone}` : '';
  setStatus('gpuStatus', `GPU worker: ${GPU_LABELS[s.status] || s.status.toLowerCase()}${s.status === 'MISSING' ? '' : where}`);
  $('gpuStartBtn').disabled = !['TERMINATED', 'STOPPED', 'SUSPENDED'].includes(s.status);
  $('gpuStopBtn').disabled = !['RUNNING', 'PROVISIONING', 'STAGING', 'REPAIRING'].includes(s.status);
  // With COMFY_URL (a local tunnel) the app doesn't need the VM's status to reach ComfyUI.
  $('comfyBtn').disabled = s.status !== 'RUNNING' && !window.CITY_DRIVE_CONFIG?.comfy?.alwaysOn;
}

// Checks often while the VM is changing state, rarely once it has settled.
async function pollGpu() {
  clearTimeout(state.gpuPoll);
  let delay = 60000;
  try {
    const resp = await fetch('/api/gpu');
    const s = await resp.json();
    if (!resp.ok) throw new Error(s.error);
    showGpu(s);
    if (!GPU_SETTLED.includes(s.status)) delay = 5000;
  } catch (err) {
    setStatus('gpuStatus', `GPU worker: status unavailable (${err.message})`, true);
  }
  state.gpuPoll = setTimeout(pollGpu, delay);
}

async function gpuAction(action) {
  if (action === 'stop' && state.videoRunning &&
      !confirm('A video job may still be running. Stopping the VM loses that job. Stop anyway?')) return;
  $('gpuStartBtn').disabled = $('gpuStopBtn').disabled = true;
  try {
    const resp = await fetch(`/api/gpu/${action}`, { method: 'POST' });
    const s = await resp.json();
    if (!resp.ok) throw new Error(s.error);
    showGpu(s);
  } catch (err) {
    setStatus('gpuStatus', `GPU worker: could not ${action} it (${err.message})`, true);
  }
  // Refresh soon either way so the buttons match the VM again.
  clearTimeout(state.gpuPoll);
  state.gpuPoll = setTimeout(pollGpu, 3000);
}

function resetScan() {
  stopPlaying();
  state.samples = [];
  state.frames = [];
  $('yearSelect').innerHTML = '<option value="latest">Latest available</option>';
  $('yearSelect').disabled = true;
  $('yearChart').innerHTML = '';
  ['scanInfo', 'frameInfo', 'downloadInfo'].forEach((id) => setStatus(id, ''));
  $('downloadBtn').disabled = true;
  $('viewer').hidden = true;
  state.carMarker?.setMap(null);
}

function setStatus(id, text, isError = false) {
  const el = $(id);
  el.textContent = text;
  el.classList.toggle('error', isError);
}
