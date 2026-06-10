// Belt flythrough captures (Phase 4): boots the real client against a running dev stack
// and shoots ≥1080p screenshots at three scales using the viewPos/lookDir debug controls.
//
// Usage:
//   PORT=8807 bun src/server/main.ts &           (HAYSTACK_FIELD=hash for the baseline)
//   VITE_API_PROXY=http://127.0.0.1:8807 vite --port 5173 &
//   node scripts/bench/belt-captures.mjs <label>
//
// Output: screenshots/belt-<label>-{close,region,belt}.png
import { chromium } from "playwright";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const CLIENT_URL = process.env.CAPTURE_URL ?? "http://127.0.0.1:5173/";
const LABEL = process.argv[2] ?? "default";
const OUT = resolve(import.meta.dirname, "..", "..", "screenshots");
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

// Three scales. close = in-band flying view; region = over the 3:1 gap edge so band/gap
// contrast is visible; belt = the whole annulus from high above the plane.
const HASH_BASELINE = process.env.HASH_BASELINE === "1";
const SHOTS_BELT = [
  {
    name: "close",
    pos: { x: 1264900, y: 20, z: 250 },
    look: { x: 0.05, y: 0.02, z: 0.999 },
    settleMs: 16000,
  },
  {
    name: "region",
    pos: { x: 1430000, y: 60000, z: 0 },
    look: { x: 0.12, y: -0.55, z: 0.83 },
    settleMs: 12000,
  },
  {
    name: "belt",
    pos: { x: 0, y: 5000000, z: 0 },
    look: { x: 0.02, y: -0.999, z: 0.04 },
    settleMs: 9000,
  },
];
// The legacy hash field is a ±56.5 km cube at the origin — its baseline shots frame the
// same three scales there. At belt scale it is a dot: that IS the comparison statement.
const SHOTS_HASH = [
  {
    name: "close",
    pos: { x: 0, y: 20, z: 250 },
    look: { x: 0.05, y: 0.02, z: 0.999 },
    settleMs: 16000,
  },
  {
    name: "region",
    pos: { x: 0, y: 40000, z: 0 },
    look: { x: 0.12, y: -0.85, z: 0.5 },
    settleMs: 12000,
  },
  {
    name: "belt",
    pos: { x: 0, y: 5000000, z: 0 },
    look: { x: 0.02, y: -0.999, z: 0.04 },
    settleMs: 9000,
  },
];
const SHOTS = HASH_BASELINE ? SHOTS_HASH : SHOTS_BELT;

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

// Onboard a pilot when the create form is showing.
const input = page.locator("input").first();
if ((await input.count()) > 0 && (await input.isVisible().catch(() => false))) {
  await input.fill(`Capture-${LABEL}`.slice(0, 18));
  await page.keyboard.press("Enter");
}
await page.waitForTimeout(6000);

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
  const path = resolve(OUT, `belt-${LABEL}-${shot.name}.png`);
  await page.screenshot({ path, scale: "device" });
  console.log(path);
}
if (errors.length) console.log("pageerrors:", errors.slice(0, 5).join(" | "));
await browser.close();
