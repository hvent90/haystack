// Live WebGPU game e2e loop — boots the REAL app on a REAL GPU device and proves the
// pixels and the frame performance, not just the compute gates.
//
// What this does, end to end, repeatably:
//   1. Spawns the API server (bun) + the vite dev client, on 127.0.0.1 (a SECURE CONTEXT
//      — WebGPU's navigator.gpu only exists on localhost/127.0.0.1, never about:blank/LAN).
//   2. Joins a pilot via the CLI (REST POST /api/pilots) so the client reaches the 3D
//      WorldView Canvas — the same join path tests/e2e/screenshot.ts uses.
//   3. Launches Chromium with the WebGPU flags. By default it uses SYSTEM CHROME
//      (real Apple Metal — higher fidelity); without it falls back to bundled Chromium's
//      SwiftShader WebGPU. Both are real devices on a secure context.
//   4. Navigates to the game with ?pilotId=…, waits for the live field to actually render
//      (render stats show derived rocks + submitted instances + frames advancing), then
//      emits to repo dirs:
//        screenshots/gpu-live-<ts>.png      — >= 2560x1440 ACTUAL pixels of the live field
//        trace-analysis/gpu-live-<ts>.console.log  — full browser console incl. adapter line
//        trace-analysis/gpu-live-<ts>.trace.json    — Chrome DevTools CDP perf trace (~5 s)
//        trace-analysis/gpu-live-<ts>.frames.json   — in-page rAF frame-time sampling + stats
//        trace-analysis/gpu-live-<ts>.summary.json  — machine-readable run summary
//
// Usage:
//   node scripts/bench/gpu-live-loop.mjs                 # real Metal via system Chrome (auto-detected)
//   GPU_LIVE_BUNDLED=1 node scripts/bench/gpu-live-loop.mjs   # force bundled Chromium / SwiftShader
//   GPU_LIVE_LIMIT=50000 node scripts/bench/gpu-live-loop.mjs # field size (default 50000)
//   CHROME_PATH="/path/to/Chrome" node scripts/bench/gpu-live-loop.mjs
//
// Exits 0 iff a valid >=2560x1440 screenshot of the live field, console logs (with the
// adapter line), and a non-empty perf trace were all produced.

import { chromium } from "playwright";
import { PNG } from "pngjs";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, statSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "..", "..");
const SERVER_PORT = Number(process.env.GPU_LIVE_SERVER_PORT ?? "8811");
const CLIENT_PORT = Number(process.env.GPU_LIVE_CLIENT_PORT ?? "5211");
const RENDERED_LIMIT = Number(process.env.GPU_LIVE_LIMIT ?? "50000");
// >= 2K target. 1280x720 CSS at deviceScaleFactor 2 = 2560x1440 actual pixels.
const CSS_WIDTH = Number(process.env.GPU_LIVE_CSS_WIDTH ?? "1280");
const CSS_HEIGHT = Number(process.env.GPU_LIVE_CSS_HEIGHT ?? "720");
const DEVICE_SCALE = Number(process.env.GPU_LIVE_DSF ?? "2");
const TRACE_SECONDS = Number(process.env.GPU_LIVE_TRACE_SECONDS ?? "5");

const SERVER_URL = `http://127.0.0.1:${SERVER_PORT}`;
const CLIENT_URL = `http://127.0.0.1:${CLIENT_PORT}`;

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const SHOTS_DIR = resolve(REPO, "screenshots");
const TRACE_DIR = resolve(REPO, "trace-analysis");
mkdirSync(SHOTS_DIR, { recursive: true });
mkdirSync(TRACE_DIR, { recursive: true });
const screenshotPath = resolve(SHOTS_DIR, `gpu-live-${stamp}.png`);
const scanShotPath = resolve(SHOTS_DIR, `gpu-live-${stamp}.scan.png`);
const fieldShotPath = resolve(SHOTS_DIR, `gpu-live-${stamp}.field.png`);
const consolePath = resolve(TRACE_DIR, `gpu-live-${stamp}.console.log`);
const tracePath = resolve(TRACE_DIR, `gpu-live-${stamp}.trace.json`);
const framesPath = resolve(TRACE_DIR, `gpu-live-${stamp}.frames.json`);
const summaryPath = resolve(TRACE_DIR, `gpu-live-${stamp}.summary.json`);
const dbPath = resolve(tmpdir(), `haystack-gpu-live-${Date.now()}.sqlite`);

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
      if (r.ok || r.status === 200) return;
    } catch {}
    if (Date.now() - start > timeoutMs) throw new Error(`not ready: ${url} after ${timeoutMs}ms`);
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

// GPU_LIVE_PROD=1: serve the PRODUCTION build (`vite build` + `vite preview`) instead of
// the dev server. Dev-mode react-dom's performance-track props diffing over the 50k
// asteroid array costs whole seconds per commit during movement and completely distorts
// frame stats; production numbers are the real game's numbers. apiBase falls back to a
// relative /api in prod, which preview proxies to the server via VITE_API_PROXY.
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
const summary = { ok: false, stage: "init" };

try {
  summary.stage = "waiting-for-servers";
  await waitForHttp(`${SERVER_URL}/api/health`);
  await waitForHttp(`${CLIENT_URL}/`);

  // Join a pilot via the same REST path the CLI/screenshot harness uses, so the client
  // reaches the WorldView Canvas. The streamed field is all discovered=true, so the field
  // renders right after the world snapshot arrives (no scan required).
  summary.stage = "joining-pilot";
  const joinRes = await fetch(`${SERVER_URL}/api/pilots`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callsign: `GPU-Live-${String(Date.now()).slice(-5)}` }),
  });
  if (!joinRes.ok) throw new Error(`join failed: ${joinRes.status} ${await joinRes.text()}`);
  const { pilot } = await joinRes.json();
  const pilotId = pilot.id;
  // Confirm the server is actually running the requested field size, device-independent.
  const world = await (
    await fetch(`${SERVER_URL}/api/world?pilotId=${encodeURIComponent(pilotId)}`)
  ).json();
  summary.serverRenderedLimit = world?.field?.renderedLimit ?? null;

  summary.stage = "launching-browser";
  const executablePath = detectChrome();
  const launchOpts = {
    headless: true,
    args: [
      "--enable-unsafe-webgpu",
      "--enable-unsafe-swiftshader",
      "--use-mock-keychain",
      "--password-store=basic",
      // Force GPU on in headless so real Chrome uses Metal rather than disabling the GPU.
      "--use-gl=angle",
      "--ignore-gpu-blocklist",
      "--enable-gpu",
    ],
  };
  if (executablePath) launchOpts.executablePath = executablePath;
  summary.chromeChannel = executablePath ? `system-chrome (${executablePath})` : "bundled-chromium";

  browser = await chromium.launch(launchOpts);
  const context = await browser.newContext({
    viewport: { width: CSS_WIDTH, height: CSS_HEIGHT },
    deviceScaleFactor: DEVICE_SCALE,
  });
  const page = await context.newPage();

  const consoleLines = [];
  const record = (s) => consoleLines.push(s);
  page.on("console", (m) => record(`[${m.type()}] ${m.text()}`));
  page.on("pageerror", (e) => record(`[pageerror] ${e.message}`));
  page.on("requestfailed", (r) =>
    record(`[requestfailed] ${r.url()} ${r.failure()?.errorText ?? ""}`),
  );
  // Console "Failed to load resource" lines don't carry the URL; log error responses with it.
  page.on("response", (r) => {
    if (r.status() >= 400) record(`[http ${r.status()}] ${r.url()}`);
  });

  summary.stage = "navigating";
  const url = new URL(CLIENT_URL);
  url.searchParams.set("pilotId", pilotId);
  await page.goto(url.toString(), { waitUntil: "networkidle" });

  // Capture the adapter line up front and log it into the console capture (the spec wants
  // the WebGPU adapter line explicitly in the log).
  const adapter = await page.evaluate(async () => {
    if (!navigator.gpu) return "navigator.gpu ABSENT";
    try {
      const a = await navigator.gpu.requestAdapter();
      if (!a) return "requestAdapter() -> null";
      const i = a.info ?? {};
      return `vendor=${i.vendor ?? "?"} arch=${i.architecture ?? "?"} device=${i.device ?? "?"} desc=${i.description ?? "?"}`;
    } catch (e) {
      return `adapter error: ${e?.message ?? e}`;
    }
  });
  record(`[adapter] ${adapter}`);
  summary.adapter = adapter;
  if (adapter.includes("ABSENT") || adapter.includes("null")) {
    throw new Error(`WebGPU adapter unavailable in browser: ${adapter}`);
  }

  // The app refuses non-WebGPU; reaching haystack-app means WebGPU was accepted.
  summary.stage = "waiting-for-app";
  await page.waitForSelector("[data-testid='haystack-app']", { timeout: 30000 });
  await page.waitForSelector("[data-testid='world-canvas']", { timeout: 30000 });

  // Wait until the live field has actually rendered on the GPU. In the WebGPU-resident path
  // the single InstancedMesh is frustumCulled=false and drawn zero-copy by the positionNode,
  // so the legacy per-chunk submittedInstanceCount (material-gated onAfterRender) is 0 by
  // design. The real on-GPU signals are: the field is derived (rocks uploaded), the renderer
  // issued draw calls and rendered triangles (gl.info.render across the frame's passes), and
  // the frame counter is advancing.
  summary.stage = "waiting-for-render";
  const renderReady = await page
    .waitForFunction(
      () => {
        const s = window.__HAYSTACK_RENDER_STATS__;
        return (
          s &&
          s.derivedAsteroidCount > 1000 &&
          s.drawCalls > 0 &&
          s.renderedTriangles > 0 &&
          s.frame > 5
        );
      },
      { timeout: 90000, polling: 250 },
    )
    .then(() => true)
    .catch(() => false);
  const stats0 = await page.evaluate(() => window.__HAYSTACK_RENDER_STATS__ ?? null);
  summary.renderStats = stats0;
  if (!renderReady) {
    throw new Error(`field did not render in time; last stats: ${JSON.stringify(stats0)}`);
  }

  // Verify the canvas has real, non-uniform content (not a blank/cleared buffer).
  summary.stage = "canvas-content-check";
  const canvasStats = await page.evaluate(() => {
    const canvas =
      document.querySelector("[data-testid='world-canvas']") || document.querySelector("canvas");
    if (!canvas) return { error: "no canvas" };
    return {
      width: canvas.width,
      height: canvas.height,
      clientW: canvas.clientWidth,
      clientH: canvas.clientHeight,
    };
  });
  summary.canvas = canvasStats;

  // --- Performance trace via CDP Tracing over a few seconds of live rendering ---
  summary.stage = "tracing";
  const cdp = await context.newCDPSession(page);
  const traceChunks = [];
  cdp.on("Tracing.dataCollected", (e) => {
    for (const ev of e.value) traceChunks.push(ev);
  });
  const traceComplete = new Promise((res) => cdp.once("Tracing.tracingComplete", res));
  await cdp.send("Tracing.start", {
    transferMode: "ReportEvents",
    traceConfig: {
      recordMode: "recordContinuously",
      includedCategories: [
        "devtools.timeline",
        "disabled-by-default-devtools.timeline",
        "disabled-by-default-devtools.timeline.frame",
        "blink.user_timing",
        "gpu",
        "disabled-by-default-gpu.service",
        "latencyInfo",
        "v8.execute",
      ],
    },
  });

  // In-page rAF frame-time sampling during the trace window — a device-independent jank
  // signal that doesn't depend on parsing the CDP trace.
  await page.evaluate((seconds) => {
    return new Promise((resolve) => {
      const frames = [];
      let last = performance.now();
      const start = last;
      function tick(now) {
        frames.push(now - last);
        last = now;
        if (now - start < seconds * 1000) requestAnimationFrame(tick);
        else {
          window.__GPU_LIVE_FRAMES__ = frames;
          resolve();
        }
      }
      requestAnimationFrame(tick);
    });
  }, TRACE_SECONDS);

  await cdp.send("Tracing.end");
  await traceComplete;

  const frameDeltas = await page.evaluate(() => window.__GPU_LIVE_FRAMES__ ?? []);
  const statsEnd = await page.evaluate(() => window.__HAYSTACK_RENDER_STATS__ ?? null);

  // --- Screenshot of the live game (HUD on) at >= 2K actual pixels ---
  summary.stage = "screenshot";
  await page.screenshot({ path: screenshotPath, scale: "device", fullPage: false });

  // --- HUD-off field captures ---
  // The default-open HUD windows occlude ~70% of the field, so the field/scan shots hide
  // the DOM HUD (the canvas stays visible through hidden ancestors via the visibility
  // override; GPU_LIVE_HUD=1 keeps the HUD in these too). The idle field is genuinely
  // near-black (the intentional dark/dim look), so the HUD-on shot above remains the one
  // the basic pixel checks run on — the SCAN gate below is the real "geometry actually
  // renders" check (the pulse can only light real depth+normals).
  if (process.env.GPU_LIVE_HUD !== "1") {
    await page.addStyleTag({
      content:
        "body * { visibility: hidden !important; } canvas { visibility: visible !important; }",
    });
    await new Promise((r) => setTimeout(r, 100));
  }
  await page.screenshot({ path: fieldShotPath, scale: "device", fullPage: false });

  // --- ScanPulse visual gate (step 2): trigger the V-key scan and capture mid-pulse ---
  // The pulse runs 1.6 s; ~0.6 s in, the shell sits ~8.5 scene units out with envelope
  // ~0.92, lighting camera-facing facets in the scan teal (#7de5d8). The gate compares
  // teal-dominant sample counts mid-pulse vs idle, so HUD/base-render colors cancel out.
  summary.stage = "scan-pulse";
  const countTeal = (png) => {
    const decoded = PNG.sync.read(png);
    let teal = 0;
    const step = 8;
    for (let y = 0; y < decoded.height; y += step) {
      for (let x = 0; x < decoded.width; x += step) {
        const o = (y * decoded.width + x) * 4;
        const r = decoded.data[o],
          g = decoded.data[o + 1],
          b = decoded.data[o + 2];
        if (g > 60 && b > 55 && g > r * 1.35 && b > r * 1.2) teal += 1;
      }
    }
    return teal;
  };
  await page.keyboard.press("v");
  await new Promise((r) => setTimeout(r, 600));
  const scanShot = await page.screenshot({ scale: "device", fullPage: false });
  writeFileSync(scanShotPath, scanShot);
  let scanGate = { idleTeal: -1, pulseTeal: -1, pass: false };
  try {
    const idleTeal = countTeal(readFileSync(fieldShotPath));
    const pulseTeal = countTeal(scanShot);
    scanGate = { idleTeal, pulseTeal, pass: pulseTeal > idleTeal * 2 + 20 };
  } catch (e) {
    record(`[scan-gate] PNG decode failed: ${e?.message ?? e}`);
  }
  summary.scanGate = scanGate;

  // --- Inter-asteroid shadow gate (two-tier, screenshot A/B) ---
  // Both shadow tiers can silently die (an indirect-draw depth pass that renders nothing,
  // a dead packAttr.w) while every numeric gate stays green. Point the camera DOWN-SUN
  // (every visible face is sun-facing, so brightness variation isolates the shadow terms)
  // and toggle each tier via the debug controls: a tier is alive iff it darkens pixels
  // that the fully-lit baseline shows lit. "Darkened" = strongly lit (>90) in the baseline
  // and near-black (<18) in the shot — shadowing in the zero-ambient look drives pixels to
  // true black, while the cosmetic tumble between two captures mostly lands on partial
  // facet lums, so this cut separates them. Sampled every 8th pixel; measured healthy on
  // Metal: tier1 ≈ 8000, tier2 ≈ 2300, identical-state noise ≈ 420, baseline lit ≈ 15500.
  // The gate also bounds each tier's darkening from ABOVE and requires the production
  // blend to retain lit pixels — an all-0s aSunlit (or an always-dark shadow factor) is
  // the design's named "uniformly black wall" failure and would otherwise MAXIMIZE the
  // darkened counts and pass vacuously (fresh-context review finding).
  summary.stage = "shadow-gate";
  const lumGrid = (png) => {
    const decoded = PNG.sync.read(png);
    const lums = [];
    const step = 8;
    for (let y = 0; y < decoded.height; y += step) {
      for (let x = 0; x < decoded.width; x += step) {
        const o = (y * decoded.width + x) * 4;
        lums.push(
          0.2126 * decoded.data[o] + 0.7152 * decoded.data[o + 1] + 0.0722 * decoded.data[o + 2],
        );
      }
    }
    return lums;
  };
  const darkened = (base, shot) => {
    let n = 0;
    for (let i = 0; i < Math.min(base.length, shot.length); i += 1) {
      if (base[i] > 90 && shot[i] < 18) n += 1;
    }
    return n;
  };
  // Down-sun = -sunDirection (lighting.ts: normalize(0.55, 0.62, -0.56)).
  const sunLen = Math.hypot(0.55, 0.62, -0.56);
  const downSun = { x: -0.55 / sunLen, y: -0.62 / sunLen, z: 0.56 / sunLen };
  const shadowShot = async (tier1, tier2, name) => {
    await page.evaluate(
      ([d, t1, t2]) => {
        const dbg = window.__HAYSTACK_RENDER_DEBUG__;
        dbg.lookDir(d);
        dbg.shadowTiers(t1, t2);
        // Froxel fog OFF for the shadow A/B: the gate isolates the two SHADOW tiers, and
        // the volumetric medium (extinction dims lit faces below the 90-lum baseline cut,
        // in-scatter lifts blacks above 18) would otherwise swamp both thresholds — the
        // post-froxel baseline collapsed 15k -> 470 lit samples. The froxel pass has its
        // own device gate (verify:gpu verifyFroxels).
        dbg.froxel({ mix: 0 });
      },
      [downSun, tier1, tier2],
    );
    await new Promise((r) => setTimeout(r, 400));
    const bytes = await page.screenshot({ scale: "device", fullPage: false });
    writeFileSync(resolve(SHOTS_DIR, `gpu-live-${stamp}.shadow-${name}.png`), bytes);
    return lumGrid(bytes);
  };
  let shadowGate = {
    noise: -1,
    tier1Darkened: -1,
    tier2Darkened: -1,
    baselineLit: -1,
    blendLit: -1,
    pass: false,
  };
  try {
    const litCount = (g) => g.filter((v) => v > 90).length;
    const litA = await shadowShot(false, false, "off");
    const litB = await shadowShot(false, false, "off2"); // noise floor: identical state
    const t2 = await shadowShot(false, true, "tier2");
    const t1 = await shadowShot(true, false, "tier1");
    const on = await shadowShot(true, true, "on"); // production blend
    shadowGate = {
      noise: darkened(litA, litB),
      tier2Darkened: darkened(litA, t2),
      tier1Darkened: darkened(litA, t1),
      baselineLit: litCount(litA),
      blendLit: litCount(on),
      pass: false,
    };
    shadowGate.pass =
      shadowGate.noise < 600 &&
      // The scene must hold a meaningful lit field at all (legacy hash ≈ 15500 lit
      // samples; belt-bake band ≈ 7800 when first calibrated). RECALIBRATED 2026-06-10:
      // the same default bake on the SAME code (verified against a pristine origin/main
      // worktree) now measures baseLit ≈ 3500-3750 in this environment — absolute lit
      // pixel counts halved (Chrome/Metal rendering drift), while the tier/baseLit
      // ratios stayed exactly at the documented healthy 0.22/0.13. The floor therefore
      // drops to 2200: still far above an empty/black scene (≈ 0) but tolerant of
      // environment-level brightness statistics. The RATIO checks below are the real
      // dead-tier detectors.
      shadowGate.baselineLit > 2200 &&
      // Each tier darkens (alive) but not everything (not a black wall). The FLOORS are
      // noise-relative only: a dead tier darkens ≈ 1.0× the identical-state noise count,
      // alive tiers measure 2.5-4.7× (default bake) and 2.6-4.3× (saturn bake) across
      // environments. Ratio-to-baselineLit floors (0.21/0.13 on the default bake) were
      // dropped 2026-06-10: at Saturn scale the down-sun frame contains the PLANET — a
      // huge lit object rock shadows can never darken — so baselineLit quadruples while
      // tier counts stay constant and any ratio floor becomes scene-dependent. The
      // all-dark UPPER bounds below stay ratio-based on purpose (a black wall darkens
      // nearly everything regardless of scene).
      shadowGate.tier1Darkened > 2.5 * shadowGate.noise &&
      shadowGate.tier1Darkened < 0.8 * shadowGate.baselineLit &&
      shadowGate.tier2Darkened > 2.0 * shadowGate.noise &&
      shadowGate.tier2Darkened < 0.4 * shadowGate.baselineLit &&
      // The production blend keeps individually lit rocks (varied, not a black wall).
      shadowGate.blendLit > 0.4 * shadowGate.baselineLit;
  } catch (e) {
    record(`[shadow-gate] failed: ${e?.message ?? e}`);
  }
  summary.shadowGate = shadowGate;
  // Restore normal play state for anything after.
  await page.evaluate(() => {
    const dbg = window.__HAYSTACK_RENDER_DEBUG__;
    dbg.lookDir(null);
    dbg.shadowTiers(true, true);
    dbg.froxel(null);
  });

  // --- Write all artifacts ---
  writeFileSync(consolePath, consoleLines.join("\n") + "\n", "utf8");
  writeFileSync(tracePath, JSON.stringify({ traceEvents: traceChunks }), "utf8");

  const sorted = [...frameDeltas].filter((d) => d > 0).sort((a, b) => a - b);
  const pct = (p) =>
    sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0;
  const mean = sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : 0;
  const longTasks = sorted.filter((d) => d > 50).length;
  const frameSummary = {
    sampleCount: frameDeltas.length,
    meanMs: Number(mean.toFixed(3)),
    medianMs: Number(pct(0.5).toFixed(3)),
    p95Ms: Number(pct(0.95).toFixed(3)),
    p99Ms: Number(pct(0.99).toFixed(3)),
    maxMs: Number((sorted[sorted.length - 1] ?? 0).toFixed(3)),
    framesOver50ms: longTasks,
    approxFps: mean > 0 ? Number((1000 / mean).toFixed(1)) : 0,
    deltasMs: frameDeltas.map((d) => Number(d.toFixed(2))),
  };
  writeFileSync(framesPath, JSON.stringify(frameSummary, null, 2), "utf8");

  // Measure the actual produced screenshot pixel dimensions from the PNG header, and verify
  // the rendered image is non-uniform (real field pixels, not a single blank clear color).
  const pngBytes = readFileSync(screenshotPath);
  const shotW = pngBytes.readUInt32BE(16);
  const shotH = pngBytes.readUInt32BE(20);
  const traceBytes = statSync(tracePath).size;
  let uniqueColors = 0;
  let nonBackgroundSamples = 0;
  try {
    const decoded = PNG.sync.read(pngBytes);
    const colors = new Set();
    const step = 32;
    for (let y = 0; y < decoded.height; y += step) {
      for (let x = 0; x < decoded.width; x += step) {
        const o = (y * decoded.width + x) * 4;
        const r = decoded.data[o],
          g = decoded.data[o + 1],
          b = decoded.data[o + 2];
        colors.add(`${r >> 3},${g >> 3},${b >> 3}`);
        // Background clear is #03040a; count pixels brighter than that as field content.
        if (r > 12 || g > 12 || b > 18) nonBackgroundSamples += 1;
      }
    }
    uniqueColors = colors.size;
  } catch (e) {
    record(`[content-check] PNG decode failed: ${e?.message ?? e}`);
  }
  summary.pixels = { uniqueColors, nonBackgroundSamples };

  summary.stage = "done";
  summary.ok =
    shotW >= 2560 &&
    shotH >= 1440 &&
    traceChunks.length > 0 &&
    consoleLines.length > 0 &&
    statsEnd &&
    statsEnd.derivedAsteroidCount > 1000 &&
    statsEnd.drawCalls > 0 &&
    statsEnd.renderedTriangles > 0 &&
    uniqueColors >= 4 &&
    nonBackgroundSamples > 0 &&
    scanGate.pass &&
    shadowGate.pass;
  summary.pilotId = pilotId;
  summary.screenshot = { path: screenshotPath, width: shotW, height: shotH };
  summary.console = { path: consolePath, lines: consoleLines.length };
  summary.trace = { path: tracePath, events: traceChunks.length, bytes: traceBytes };
  summary.frames = { path: framesPath, ...frameSummary, deltasMs: undefined };
  summary.renderStatsEnd = statsEnd;
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2), "utf8");

  console.log(JSON.stringify(summary, null, 2));
  console.log(`SCREENSHOT ${shotW}x${shotH} -> ${screenshotPath}`);
  console.log(`CONSOLE ${consoleLines.length} lines -> ${consolePath}`);
  console.log(`TRACE ${traceChunks.length} events (${traceBytes} bytes) -> ${tracePath}`);
  console.log(
    `FRAMES p95=${frameSummary.p95Ms}ms max=${frameSummary.maxMs}ms fps~${frameSummary.approxFps} -> ${framesPath}`,
  );
  console.log(
    `SCAN idleTeal=${scanGate.idleTeal} pulseTeal=${scanGate.pulseTeal} ${scanGate.pass ? "PASS" : "FAIL"} -> ${scanShotPath}`,
  );
  console.log(
    `SHADOW tier1=${shadowGate.tier1Darkened} tier2=${shadowGate.tier2Darkened} noise=${shadowGate.noise} baseLit=${shadowGate.baselineLit} blendLit=${shadowGate.blendLit} ${shadowGate.pass ? "PASS" : "FAIL"}`,
  );
  console.log(summary.ok ? "GPU_LIVE_RESULT=PASS" : "GPU_LIVE_RESULT=FAIL");
  exitCode = summary.ok ? 0 : 1;
} catch (e) {
  summary.error = e?.message ?? String(e);
  try {
    writeFileSync(summaryPath, JSON.stringify(summary, null, 2), "utf8");
  } catch {}
  console.error("RUNNER_ERROR:", summary.error);
  console.log("GPU_LIVE_RESULT=FAIL");
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
