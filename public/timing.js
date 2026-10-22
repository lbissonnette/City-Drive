// Clip timing for the video step, shared by the app (public/app.js) and the
// server (server.js) so the app's estimate matches the job the server writes.
//
// Street View panoramas sit unevenly along a route, so a fixed length per clip
// makes the drive speed up and slow down. In speed mode each clip lasts as long
// as it takes to cover the road between its two frames at the chosen speed.
(function (exports) {
  // Which saved frames ({ lat, lng }) a video uses: every Nth one plus the
  // last, minus any closer than minMeters to the previous one kept (in speed
  // mode, a gap shorter than the shortest clip would play too slowly), then at
  // most maxClips + 1 of them.
  function pickFrames(frames, { stride = 1, maxClips, minMeters = 0 } = {}) {
    const count = frames.length;
    stride = Math.max(1, Math.floor(Number(stride) || 1));
    let picked = [];
    for (let i = 0; i < count; i++) if (i % stride === 0 || i === count - 1) picked.push(i);
    if (minMeters > 0) {
      const kept = [picked[0]];
      for (const i of picked.slice(1)) {
        if (pathMeters(frames, kept[kept.length - 1], i) >= minMeters) kept.push(i);
        // The last frame always stays; it replaces a kept one that's too close.
        else if (i === count - 1) kept[kept.length > 1 ? kept.length - 1 : 1] = i;
      }
      picked = kept;
    }
    if (maxClips) picked = picked.slice(0, Math.max(1, Number(maxClips)) + 1);
    return picked;
  }

  // Distance from frame a to frame b through every saved frame in between, so
  // skipping frames doesn't cut corners. NaN if a frame has no location.
  function pathMeters(frames, a, b) {
    let meters = 0;
    for (let i = a + 1; i <= b; i++) {
      const p = frames[i - 1];
      const q = frames[i];
      meters += p && q && Number.isFinite(p.lat) && Number.isFinite(q.lat) ? haversineMeters(p, q) : NaN;
    }
    return meters;
  }

  // Great-circle distance in metres between two { lat, lng } points.
  function haversineMeters(a, b) {
    const rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad;
    const dLng = (b.lng - a.lng) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * 6371000 * Math.asin(Math.sqrt(h));
  }

  // Frame count closest to the requested clip length that the model accepts
  // (5 s gives 124 for H3 and 81 for Wan 2.2, the counts they were trained on).
  function clipFrames({ fps, grid: [step, offset] }, seconds) {
    return Math.max(1, Math.round((seconds * fps - offset) / step)) * step + offset;
  }

  // One entry per clip: { meters, seconds, frames, clamped }. frames are the
  // saved frames ({ lat, lng }), picked the indexes pickFrames chose. With
  // speedKmh, seconds = distance / speed, clamped to [minSeconds, maxSeconds]
  // (clamped is 'short' or 'long' when that kicked in); otherwise
  // every clip is clipSeconds long. preset is the model's { fps, grid }.
  function planClips({ frames, picked, preset, speedKmh, clipSeconds, minSeconds, maxSeconds }) {
    const clips = [];
    for (let c = 1; c < picked.length; c++) {
      const meters = pathMeters(frames, picked[c - 1], picked[c]);
      let seconds = clipSeconds;
      let clamped = null;
      if (speedKmh) {
        seconds = meters / (speedKmh / 3.6);
        if (seconds < minSeconds) [seconds, clamped] = [minSeconds, 'short'];
        else if (seconds > maxSeconds) [seconds, clamped] = [maxSeconds, 'long'];
      }
      const count = clipFrames(preset, seconds);
      clips.push({ meters, seconds: count / preset.fps, frames: count, clamped });
    }
    return clips;
  }

  Object.assign(exports, { pickFrames, pathMeters, haversineMeters, clipFrames, planClips });
})(typeof module === 'object' && module.exports ? module.exports : (window.CityDriveTiming = {}));
