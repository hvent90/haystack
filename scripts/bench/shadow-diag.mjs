// Shadow diagnosis harness — proves what each shadow tier VISIBLY contributes in the live
// game, on a real device, by screenshot A/B.
//
// The two-tier asteroid shadow blend is receivedShadowNode = mix(aSunlit, shadowMap,
// bubbleWeight). Both tiers can silently fail (an indirect-draw depth pass that renders
// nothing, a dead attribute) while every numeric gate stays green — the only honest check
// is pixels. This harness:
//   1. Boots the real server + client (GPU_LIVE_PROD=1 for the production build).
//   2. Points the camera DOWN-SUN via the lookDir debug control, so every visible rock
//      face is sun-facing — brightness variation then isolates the shadow terms.
//   3. Captures HUD-off screenshots with each tier toggled via the shadowTiers debug
//      control: both on / tier2 only / tier1 only / both off (fully lit baseline).
//   4. Reports per-shot luminance stats and per-pair "darkened pixel" counts vs the
//      fully-lit baseline: tier2's count is the deep-field inter-shadowing; tier1's count
//      is the near-field shadow map actually receiving the GPU-driven asteroids.
//
// Usage: node scripts/bench/shadow-diag.mjs            (system Chrome / Metal if found)
//        GPU_LIVE_PROD=1 node scripts/bench/shadow-diag.mjs
// Exits 0 iff all captures were produced (judgment thresholds are reported, not enforced —
// the enforced gate lives in gpu-live-loop.mjs).

import { chromium } from "playwright";
import { PNG } from "pngjs";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "..", "..");
const SERVER_PORT = Number(process.env.SHADOW_DIAG_SERVER_PORT ?? "8813");
const CLIENT_PORT = Number(process.env.SHADOW_DIAG_CLIENT_PORT ?? "5213");
const RENDERED_LIMIT = Number(process.env.GPU_LIVE_LIMIT ?? "50000");
const SERVER_URL = `http://127.0.0.1:${SERVER_PORT}`;
const CLIENT_URL = `http://127.0.0.1:${CLIENT_PORT}`;

// Must match src/client/eve/lighting.ts sunDirection.
const SUN = { x: 0.55, y: 0.62, z: -0.56 };
const sunLen = Math.hypot(SUN.x, SUN.y, SUN.z);
const sunDir = { x: SUN.x / sunLen, y: SUN.y / sunLen, z: SUN.z / sunLen };
const downSun = { x: -sunDir.x, y: -sunDir.y, z: -sunDir.z };
// A side view perpendicular to the sun, for eyeballing crisp near shadows + terminators.
const side = (() => {
  const c = { x: sunDir.z, y: 0, z: -sunDir.x }; // cross(sun, +y), unnormalized
  const l = Math.hypot(c.x, c.y, c.z);
  return { x: c.x / l, y: c.y / l, z: c.z / l };
})();

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const SHOTS_DIR = resolve(REPO, "screenshots");
mkdirSync(SHOTS_DIR, { recursive: true });
const dbPath = resolve(tmpdir(), `haystack-shadow-diag-${Date.now()}.sqlite`);

function detectChrome() {
  if (process.env.GPU_LIVE_BUNDLED === "1") return undefined;
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH))
    return process.env.CHROME_PATH;
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return undefined;
}

async function waitForHttp(url, timeoutMs = 30000) {
  const start = Date.now();
  for (;;) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {}
    if (Date.now() - start > timeoutMs) throw new Error(`not ready: ${url}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

function spawnLogged(cmd, args, env, label) {
  const proc = spawn(cmd, args, {
    cwd: REPO,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on(
    "data",
    (d) => process.env.GPU_LIVE_VERBOSE && process.stdout.write(`[${label}] ${d}`),
  );
  proc.stderr.on(
    "data",
    (d) => process.env.GPU_LIVE_VERBOSE && process.stderr.write(`[${label}] ${d}`),
  );
  return proc;
}

// Luminance stats over a sampled grid. Background clear is #03040a (~lum 4).
const BG_LUM = 14;
function lumStats(pngBytes) {
  const png = PNG.sync.read(pngBytes);
  const step = 4;
  let rock = 0;
  let lit = 0;
  let sum = 0;
  let total = 0;
  const lums = [];
  for (let y = 0; y < png.height; y += step) {
    for (let x = 0; x < png.width; x += step) {
      const o = (y * png.width + x) * 4;
      const lum = 0.2126 * png.data[o] + 0.7152 * png.data[o + 1] + 0.0722 * png.data[o + 2];
      total += 1;
      lums.push(lum);
      if (lum > BG_LUM) {
        rock += 1;
        sum += lum;
        if (lum > 60) lit += 1;
      }
    }
  }
  return {
    sampled: total,
    rockPx: rock,
    litPx: lit,
    meanRockLum: rock ? Number((sum / rock).toFixed(1)) : 0,
    lums,
    width: png.width,
    height: png.height,
  };
}

// How many sampled pixels are lit (>60) in `base` but dark (<= half) in `shot` — i.e.
// pixels this tier visibly darkened. Robust to the slow tumble (which both brightens and
// darkens facets symmetrically; shadowing only darkens).
function darkenedCount(baseStats, shotStats) {
  let darkened = 0;
  const n = Math.min(baseStats.lums.length, shotStats.lums.length);
  for (let i = 0; i < n; i += 1) {
    if (baseStats.lums[i] > 60 && shotStats.lums[i] < baseStats.lums[i] * 0.5) darkened += 1;
  }
  return darkened;
}

const server = spawnLogged(
  "bun",
  ["src/server/main.ts"],
  {
    PORT: String(SERVER_PORT),
    HAYSTACK_DB: dbPath,
    HAYSTACK_RENDERED_LIMIT: String(RENDERED_LIMIT),
  },
  "server",
);
const PROD = process.env.GPU_LIVE_PROD === "1";
if (PROD) {
  const build = spawnLogged("./node_modules/.bin/vite", ["build"], {}, "vite-build");
  await new Promise((res, rej) =>
    build.on("exit", (c) => (c === 0 ? res() : rej(new Error(`vite build exited ${c}`)))),
  );
}
const client = PROD
  ? spawnLogged(
      "./node_modules/.bin/vite",
      ["preview", "--host", "127.0.0.1", "--port", String(CLIENT_PORT), "--strictPort"],
      { VITE_API_PROXY: SERVER_URL },
      "vite-preview",
    )
  : spawnLogged(
      "./node_modules/.bin/vite",
      ["--host", "127.0.0.1", "--port", String(CLIENT_PORT), "--strictPort"],
      { VITE_API_URL: SERVER_URL },
      "vite",
    );

let exitCode = 1;
let browser = null;
try {
  await waitForHttp(`${SERVER_URL}/api/health`);
  await waitForHttp(`${CLIENT_URL}/`);

  const joinRes = await fetch(`${SERVER_URL}/api/pilots`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callsign: `ShadowDiag-${String(Date.now()).slice(-5)}` }),
  });
  if (!joinRes.ok) throw new Error(`join failed: ${joinRes.status}`);
  const { pilot } = await joinRes.json();

  const executablePath = detectChrome();
  const launchOpts = {
    headless: true,
    args: [
      "--enable-unsafe-webgpu",
      "--enable-unsafe-swiftshader",
      "--use-mock-keychain",
      "--password-store=basic",
      "--use-gl=angle",
      "--ignore-gpu-blocklist",
      "--enable-gpu",
    ],
  };
  if (executablePath) launchOpts.executablePath = executablePath;
  browser = await chromium.launch(launchOpts);
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  const consoleLines = [];
  page.on("console", (m) => consoleLines.push(`[${m.type()}] ${m.text()}`));
  page.on("pageerror", (e) => consoleLines.push(`[pageerror] ${e.message}`));

  const url = new URL(CLIENT_URL);
  url.searchParams.set("pilotId", pilot.id);
  await page.goto(url.toString(), { waitUntil: "networkidle" });
  await page.waitForSelector("[data-testid='world-canvas']", { timeout: 30000 });
  await page.waitForFunction(
    () => {
      const s = window.__HAYSTACK_RENDER_STATS__;
      return s && s.derivedAsteroidCount > 1000 && s.drawCalls > 0 && s.frame > 5;
    },
    { timeout: 90000, polling: 250 },
  );

  // HUD off so only field pixels are measured.
  await page.addStyleTag({
    content: "body * { visibility: hidden !important; } canvas { visibility: visible !important; }",
  });

  async function capture(name, dir, tier1, tier2) {
    await page.evaluate(
      ([d, t1, t2]) => {
        const dbg = window.__HAYSTACK_RENDER_DEBUG__;
        dbg.lookDir(d);
        dbg.shadowTiers(t1, t2);
      },
      [dir, tier1, tier2],
    );
    await new Promise((r) => setTimeout(r, 400)); // settle a few frames
    const bytes = await page.screenshot({ scale: "device", fullPage: false });
    const path = resolve(SHOTS_DIR, `shadow-diag-${stamp}-${name}.png`);
    writeFileSync(path, bytes);
    const stats = lumStats(bytes);
    return { name, path, stats };
  }

  const shots = {};
  shots.off = await capture("downsun-off", downSun, false, false); // fully lit baseline
  shots.t2 = await capture("downsun-tier2", downSun, false, true); // aSunlit only
  shots.t1 = await capture("downsun-tier1", downSun, true, false); // shadow map only
  shots.on = await capture("downsun-on", downSun, true, true); // production blend
  shots.side = await capture("side-on", side, true, true); // perpendicular eyeball view

  const report = {
    adapter: executablePath ? "system-chrome" : "bundled-chromium",
    prod: PROD,
    shots: Object.fromEntries(
      Object.entries(shots).map(([k, s]) => [
        k,
        {
          path: s.path,
          rockPx: s.stats.rockPx,
          litPx: s.stats.litPx,
          meanRockLum: s.stats.meanRockLum,
        },
      ]),
    ),
    tier2DarkenedPx: darkenedCount(shots.off.stats, shots.t2.stats),
    tier1DarkenedPx: darkenedCount(shots.off.stats, shots.t1.stats),
    bothDarkenedPx: darkenedCount(shots.off.stats, shots.on.stats),
    consoleErrors: consoleLines.filter(
      (l) => l.startsWith("[error]") || l.startsWith("[pageerror]"),
    ),
  };
  console.log(JSON.stringify(report, null, 2));
  exitCode = 0;
} catch (e) {
  console.error("SHADOW_DIAG_ERROR:", e?.message ?? String(e));
} finally {
  if (browser) await browser.close().catch(() => {});
  server.kill("SIGTERM");
  client.kill("SIGTERM");
  if (existsSync(dbPath)) {
    try {
      rmSync(dbPath);
    } catch {}
  }
}
process.exit(exitCode);
