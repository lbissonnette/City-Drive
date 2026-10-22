# City Drive

Plot a drive on a map, pull Google Street View imagery along it (optionally from a
chosen historic year), and save the frames. A GPU worker then turns the frames into a
video of the drive, generating a short clip (5 s by default, adjustable per run) between each pair of frames with
MiniMax H3 in ComfyUI and stitching them together (see
[worker/README.md](worker/README.md)).

## Run it

Requires Node 18+. No `npm install` needed (zero dependencies).

```bash
cp .env.example .env      # then paste your key into GOOGLE_MAPS_API_KEY
npm start                 # http://localhost:3000
```

### Google Cloud setup

In a Google Cloud project with billing enabled, enable these three APIs and create an
API key restricted to them:

| API | Used for |
| --- | --- |
| Maps JavaScript API | The map, and `StreetViewService` lookups that find panoramas (including historic ones) |
| Street View Static API | The actual images, requested by panorama ID |
| Routes API | Snapping your clicked points to a driving route (optional; falls back to straight lines) |

If you want to referrer-restrict the browser key, put a second key (not
referrer-restricted) in `GOOGLE_MAPS_SERVER_KEY`. The server uses it for Routes and
image downloads.

## Deploying

See [DEPLOY.md](DEPLOY.md) for running it on Google Cloud Run, with a one-time setup
script and a GitHub Actions workflow that deploys on every push to `main`.

## Using it

1. **Plot the drive.** Click the map to drop numbered waypoints (drag to adjust). With
   "Follow roads" on, the route follows real streets. Blue lines on the map show where
   Street View coverage exists.
2. **Scan.** Choose the spacing between frames (default 15 m) and click *Scan route*.
   For each sample point the app asks Street View for every panorama it has there,
   current and historic, then charts which years are available along the route.
3. **Pick a year.** Choose a year (or click a bar in the chart). Points without imagery
   from that year can be filled from the nearest available year, or skipped.
4. **Preview and save.** Scrub or play through the frames in the viewer (the arrow on
   the map shows where you are). *Save frames* writes `output/<timestamp>_<year>/`
   containing `frame_0001.jpg…` and a `manifest.json` with each frame's panorama ID,
   capture date, heading and coordinates, ready for the video stage. With
   `VIDEO_BUCKET` set they're also copied to Cloud Storage.
5. **Make a video** (only shown when `VIDEO_BUCKET` is set). Describe the drive (the
   app wraps it in MiniMax H3's prompt format for each clip), optionally use every Nth
   frame, and click *Make video*. The app writes a job doc to the bucket, the GPU worker picks it up, and the finished video plays in the panel.

## How historic imagery works (and its limits)

The Street View Static API has no "year" parameter, but it accepts `pano=<id>`, and it
serves historic panoramas when given their IDs. The trick is finding those IDs:

- `StreetViewService.getPanorama()` in the Maps JavaScript API returns the current
  panorama at a location, and its response includes a `time` array listing the older
  panoramas at that spot: the same data behind the "See more dates" time machine in
  Google Maps. See `panoramasAt()` in `public/app.js`.
- **`time` is not an officially documented field.** Its date property has a minified
  name, so the code finds it by type, and falls back to the documented `imageDate` from
  a direct panorama lookup. Google could change or remove it without notice.
- Historic coverage is patchy. Big cities typically have several captures going back to
  2007–2009, but a given year rarely covers 100% of a route. The year chart shows how
  much does.
- Each image is a single static view (640×640 max) facing the direction of travel.
  Frames are 10–20 m apart at best, so the result is a slideshow, not smooth video.
  That's the gap the video model is meant to fill.

## Cost and terms

- Every preview frame and every saved frame is a billable Street View Static request,
  and each scan point is a Street View lookup through the Maps JavaScript API. Check
  current pricing at https://mapsplatform.google.com/pricing/ and set a budget alert.
- Google Maps Platform terms restrict storing/caching Street View imagery and creating
  derivative works from it. Fine for a private experiment, but review the terms before
  building anything public on top of it.

## Layout

```
server.js          Static file server + /api/route (Routes API) + /api/download (saves frames)
                   + /api/video (queues a video job, reports status, streams the result)
                   + /api/gpu (GPU VM status, start, stop)
gcs.js             Tiny Cloud Storage client (no dependencies)
compute.js         Starts/stops the GPU worker VM via the Compute Engine API
public/index.html  UI
public/app.js      Map, route sampling, Street View scanning, year selection, preview
public/style.css
Dockerfile         Container for Cloud Run (see DEPLOY.md)
scripts/gcp-setup.sh  One-time GCP project + GitHub Actions deploy setup
scripts/gpu-vm.sh     Create/start/stop the GPU spot VM
worker/            GPU worker: worker.py, ComfyUI workflows, VM startup script
```
