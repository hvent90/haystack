// Froxel volumetrics capture harness: boots the real client (WebGPU, real Metal via
// system Chrome) against a running dev stack and shoots screenshots at belt vantages
// chosen for the phase-1 visual gate — dense pocket, void/gap, belt edge — plus the
// stock spawn view. Optional froxel tuning overrides are applied via the debug hook.
//
// Usage:
//   PORT=8817 HAYSTACK_DB=/tmp/froxel-dev.sqlite bun src/server/main.ts &
//   VITE_API_PROXY=http://127.0.0.1:8817 vite --port 5183 &
//   node scripts/bench/froxel-captures.mjs <label> ['{"sigmaScale":0.5}']
//
// Output: screenshots/froxel-<label>-<shot>.png
import { chromium } from "playwright";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const CLIENT_URL = process.env.CAPTURE_URL ?? "http://127.0.0.1:5183/";
const LABEL = process.argv[2] ?? "p1";
const TUNING = process.argv[3] ? JSON.parse(process.argv[3]) : null;
const SHOTS_ARG = process.env.FROXEL_SHOTS ? process.env.FROXEL_SHOTS.split(",") : null;
const OUT = resolve(import.meta.dirname, "..", "..", "screenshots");
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

// Vantages (world meters; belt spans r 500..3250 km, midplane y=0, zMax ±90 km).
const SHOTS = [
  // The stock spawn view, no overrides — what a player actually sees.
  { name: "spawn", pos: null, look: null, settleMs: 14000 },
  // In-band flying view (same in-band point the belt captures use): dense pocket.
  {
    name: "dense",
    pos: { x: 1264900, y: 20, z: 250 },
    look: { x: 0.05, y: 0.02, z: 0.999 },
    settleMs: 14000,
  },
  // A resonance gap / void: between bands the baked density is ~0 — fog should clear.
  {
    name: "void",
    pos: { x: 2050000, y: 10000, z: 0 },
    look: { x: 0.4, y: 0.0, z: 0.917 },
    settleMs: 12000,
  },
  // Belt edge: looking along the band from just above it, structure in depth.
  {
    name: "edge",
    pos: { x: 1264900, y: 60000, z: 250 },
    look: { x: 0.3, y: -0.35, z: 0.89 },
    settleMs: 12000,
  },
];
const shots = SHOTS_ARG ? SHOTS.filter((s) => SHOTS_ARG.includes(s.name)) : SHOTS;

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
const consoleErrors = [];
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text());
});
await page.goto(CLIENT_URL, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2500);

const input = page.locator("input").first();
if ((await input.count()) > 0 && (await input.isVisible().catch(() => false))) {
  await input.fill(`Froxel-${LABEL}`.slice(0, 18));
  await page.keyboard.press("Enter");
}
await page.waitForTimeout(6000);

for (const shot of shots) {
  await page.evaluate(
    ([pos, look, tuning]) => {
      const dbg = window.__HAYSTACK_RENDER_DEBUG__;
      dbg.viewPos(pos);
      dbg.lookDir(look);
      dbg.froxel(tuning);
    },
    [shot.pos, shot.look, TUNING],
  );
  await page.waitForTimeout(shot.settleMs);
  const path = resolve(OUT, `froxel-${LABEL}-${shot.name}.png`);
  await page.screenshot({ path, scale: "device" });
  console.log(path);
}
const stats = await page.evaluate(() => window.__HAYSTACK_RENDER_STATS__ ?? null);
console.log("stats:", JSON.stringify(stats));
if (errors.length) console.log("pageerrors:", errors.slice(0, 5).join(" | "));
if (consoleErrors.length) console.log("consoleerrors:", consoleErrors.slice(0, 8).join(" | "));
await browser.close();
