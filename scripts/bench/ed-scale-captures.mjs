// Scale-judgment shot list for the ED belt: known-size anchors at measured distances.
// Anchors: the 438 m-radius hero at (1266130, 750, 2493) — ~876 m across, the same
// class as ED's measured 964 m core rock — approached from up-sun (lit face); the
// station + parked ~110 m capture-pilot ships at spawn; an eye-line fog-depth shot.
//
// Usage: CAPTURE_URL=http://127.0.0.1:5177/ node scripts/bench/ed-scale-captures.mjs <label>
// Output: screenshots/edscale-<label>-{hero2000,hero900,station,fog}.png
import { chromium } from "playwright";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const CLIENT_URL = process.env.CAPTURE_URL ?? "http://127.0.0.1:5177/";
const LABEL = process.argv[2] ?? "a";
const OUT = resolve(import.meta.dirname, "..", "..", "screenshots");
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

// Up-sun unit offset (sun dir is (0.55, 0.62, -0.56)) so the hero's lit face shows.
const U = { x: 0.69, y: 0.19, z: -0.7 };
const HERO = { x: 1266130, y: 750, z: 2493 };
const at = (d) => ({ x: HERO.x + U.x * d, y: HERO.y + U.y * d, z: HERO.z + U.z * d });
const LOOK_BACK = { x: -U.x, y: -U.y, z: U.z * -1 };

const SHOTS = [
  { name: "hero2000", pos: at(2000), look: LOOK_BACK, settleMs: 14000 },
  { name: "hero900", pos: at(900), look: LOOK_BACK, settleMs: 12000 },
  {
    name: "station",
    pos: { x: 1265100, y: 100, z: -550 },
    look: { x: -0.24, y: -0.1, z: 0.97 },
    settleMs: 14000,
  },
  {
    name: "fog",
    pos: { x: 1264900, y: 0, z: 4500 },
    look: { x: 0.05, y: 0.02, z: 0.999 },
    settleMs: 16000,
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
  await input.fill(`Scale-${LABEL}`.slice(0, 18));
  await page.keyboard.press("Enter");
}
await page.waitForTimeout(6000);

// Hide the HUD (canvas-safe: never hide an element that is or contains a canvas).
await page.evaluate(() => {
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
  const path = resolve(OUT, `edscale-${LABEL}-${shot.name}.png`);
  await page.screenshot({ path, scale: "device" });
  console.log(path);
}
if (errors.length) console.log("pageerrors:", errors.slice(0, 5).join(" | "));
await browser.close();
