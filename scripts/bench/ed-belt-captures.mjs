// ED-ring cockpit shot list (prompt-elite-dangerous-belt.md Phase 2): four fixed shots
// compared against Elite Dangerous reference footage every tuning iteration.
//
// Usage:
//   PORT=8807 HAYSTACK_DB=data/capture-ed.sqlite bun src/server/main.ts &
//   VITE_API_PROXY=http://127.0.0.1:8807 bunx vite --port 5173 &
//   node scripts/bench/ed-belt-captures.mjs <label>
//
// Output: screenshots/ed-<label>-{cruise,plane,above,hero}.png
import { chromium } from "playwright";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const CLIENT_URL = process.env.CAPTURE_URL ?? "http://127.0.0.1:5173/";
const LABEL = process.argv[2] ?? "iter";
const OUT = resolve(import.meta.dirname, "..", "..", "screenshots");
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

// Saturn-preset coordinates (station spawn x ≈ 9.42865e7; main promoted saturn to the
// default bake). The shots:
// (a) cruise: in-slab eye-line near spawn — the moment-to-moment flying view.
// (b) plane: just above the midplane looking along the ring tangent — slab thinness.
// (c) above: 15 km up looking down — the "drop into the sheet" approach view.
// (d) hero: near-miss framing on the largest rock inside the spawn derive bubble (a
//     355 m cap rock 4 km out — the field derives around the SERVER ship at spawn, so
//     viewPos can only roam ~±20 km before rocks stop existing; saturn's true heroes
//     are hundreds of km down-ring).
const SHOTS = [
  {
    // Offset from the station spawn so parked capture-pilot ships stay out of frame.
    name: "cruise",
    pos: { x: 94286500, y: 0, z: 4500 },
    look: { x: 0.05, y: 0.02, z: 0.999 },
    settleMs: 16000,
  },
  {
    name: "plane",
    pos: { x: 94286500, y: 600, z: 0 },
    look: { x: 0.02, y: -0.06, z: 0.998 },
    settleMs: 12000,
  },
  {
    name: "above",
    pos: { x: 94286500, y: 15000, z: 250 },
    look: { x: 0.05, y: -0.95, z: 0.3 },
    settleMs: 12000,
  },
  {
    name: "hero",
    pos: { x: 94290700, y: -325, z: 1344 },
    look: { x: -0.69, y: -0.19, z: 0.7 },
    settleMs: 14000,
  },
];

function detectChrome() {
  const c = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  return existsSync(c) ? c : undefined;
}

const browser = await chromium.launch({
  headless: true,
  executablePath: detectChrome(),
  args: ["--enable-unsafe-webgpu", "--enable-unsafe-swiftshader", "--use-angle=metal"],
});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto(CLIENT_URL, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2500);

const input = page.locator('input[type="text"], input:not([type])').first();
if ((await input.count()) > 0 && (await input.isVisible().catch(() => false))) {
  await input.fill(`EDCap-${LABEL}`.slice(0, 18));
  await page.keyboard.press("Enter");
}
await page.waitForTimeout(6000);

// Hide the HUD for clean ED-comparison frames: display:none on every sibling of the
// canvas's ancestor chain (visibility:hidden on an ancestor would kill the WebGPU
// canvas — see prompt gotchas).
await page.evaluate(() => {
  // The render surface is the LARGEST canvas (HUD widgets may own small canvases);
  // never hide any element that is or contains a canvas.
  const canvases = Array.from(document.querySelectorAll("canvas"));
  const main = canvases.sort((a, b) => b.width * b.height - a.width * a.height)[0];
  let node = main;
  while (node && node.parentElement && node !== document.body) {
    for (const sib of node.parentElement.children) {
      if (sib === node || !(sib instanceof HTMLElement)) continue;
      if (sib.tagName === "CANVAS" || sib.querySelector("canvas")) continue;
      sib.style.display = "none";
    }
    node = node.parentElement;
  }
});

// Optional froxel tuning override for A/B captures, e.g.
// FROXEL_TUNE='{"sigmaScale":0.55}' — applied via the live debug hook.
const FROXEL_TUNE = process.env.FROXEL_TUNE ? JSON.parse(process.env.FROXEL_TUNE) : null;
if (FROXEL_TUNE) {
  await page.evaluate((t) => window.__HAYSTACK_RENDER_DEBUG__.froxel(t), FROXEL_TUNE);
}

for (const shot of SHOTS) {
  await page.evaluate(
    ([pos, look]) => {
      const dbg = window.__HAYSTACK_RENDER_DEBUG__;
      dbg.viewPos(pos);
      dbg.lookDir(look);
    },
    [shot.pos, shot.look],
  );
  await page.waitForTimeout(shot.settleMs);
  const path = resolve(OUT, `ed-${LABEL}-${shot.name}.png`);
  await page.screenshot({ path, scale: "device" });
  console.log(path);
}
if (errors.length) console.log("pageerrors:", errors.slice(0, 5).join(" | "));
await browser.close();
