// Regenerates worker/workflows/<name>.ui.json from <name>.json: the UI-format
// (editable graph) twin the worker sends with each prompt so ComfyUI can open a
// queued clip as a workflow tab. Uses ComfyUI's own frontend to do the
// conversion (app.loadApiJson, then serialize the graph), so run it against a
// ComfyUI that has the workflow's nodes and model filenames (empty files are fine):
//
//   npm i -D playwright && npx playwright install chromium   # once
//   node scripts/workflow-ui.mjs http://127.0.0.1:8188/ worker/workflows/minimax_h3_flf2v.json ...
//
// Numeric placeholders are swapped for sentinel numbers while the frontend
// loads the graph, then put back.
import { chromium } from 'playwright';
import fs from 'fs';
const SENTINELS = { WIDTH: 4064, HEIGHT: 4032, FRAMES: 3541, FPS: 97, SEED: 987654321 };
const [,, comfyUrl, ...files] = process.argv;
const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('pageerror', e.message));
await page.goto(comfyUrl);
await page.waitForFunction(() => window.app?.graph && window.app.loadApiJson, null, { timeout: 120000 });
for (const file of files) {
  let text = fs.readFileSync(file, 'utf8');
  for (const [k, v] of Object.entries(SENTINELS)) text = text.replaceAll(`"{{${k}}}"`, String(v));
  const ui = await page.evaluate(async (api) => {
    await window.app.loadApiJson(JSON.parse(api), 'template');
    window.app.graph.arrange?.();
    return JSON.stringify(window.app.graph.serialize());
  }, text);
  // Put the placeholders back, but only in widget values (positions can collide with sentinels).
  const sentinelKey = Object.fromEntries(Object.entries(SENTINELS).map(([k, v]) => [v, `{{${k}}}`]));
  const graph = JSON.parse(ui);
  for (const node of graph.nodes) {
    const vals = node.widgets_values;
    if (Array.isArray(vals)) {
      vals.forEach((v, i) => {
        if (v in sentinelKey) vals[i] = sentinelKey[v];
        // Keep the seed fixed so re-running the opened workflow reproduces the clip.
        if (vals[i] === '{{SEED}}' && vals[i + 1] === 'randomize') vals[i + 1] = 'fixed';
      });
    }
    const named = node.widgets_values_named;
    if (named) {
      for (const k of Object.keys(named)) if (named[k] in sentinelKey) named[k] = sentinelKey[named[k]];
      if (named.control_after_generate) named.control_after_generate = 'fixed';
    }
  }
  const out = JSON.stringify(graph);
  for (const k of Object.keys(SENTINELS)) console.error(file, k, out.split(`{{${k}}}`).length - 1);
  const dest = file.replace(/\.json$/, '.ui.json');
  fs.writeFileSync(dest, JSON.stringify(graph, null, 1) + '\n');
  console.error('wrote', dest);
}
await browser.close();
