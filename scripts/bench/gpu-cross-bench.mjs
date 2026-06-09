// Cell-cross hitch measurement — boots the real app on real WebGPU like gpu-live-loop.mjs,
// then uses the benchmark drift control (__HAYSTACK_RENDER_DEBUG__.drift) to force the ship
// across field cells and measures the TRUE recurring per-cross main-thread cost:
//   - renderStats: fieldDeriveMs (reconstruct), worstCellCrossFrameMs (per-cross bucket),
//     cellCrossCount
//   - rAF frame deltas during the drift window (max / p99 / frames>50ms)
// Usage: node scripts/bench/gpu-cross-bench.mjs   (CHROME_PATH for real Metal)
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "..", "..");
const SERVER_PORT = 8813;
const CLIENT_PORT = 5213;
const RENDERED_LIMIT = Number(process.env.GPU_LIVE_LIMIT ?? "50000");
const DRIFT_M_PER_DELTA = Number(process.env.CROSS_DRIFT ?? "150");
const DRIFT_SECONDS = Number(process.env.CROSS_SECONDS ?? "12");
const SERVER_URL = `http://127.0.0.1:${SERVER_PORT}`;
const CLIENT_URL = `http://127.0.0.1:${CLIENT_PORT}`;
const dbPath = resolve(tmpdir(), `haystack-cross-bench-${Date.now()}.sqlite`);

function detectChrome() {
  if (process.env.GPU_LIVE_BUNDLED === "1") return undefined;
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH))
    return process.env.CHROME_PATH;
  const c = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  return existsSync(c) ? c : undefined;
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

const server = spawn("bun", ["src/server/main.ts"], {
  cwd: REPO,
  env: {
    ...process.env,
    PORT: String(SERVER_PORT),
    HAYSTACK_DB: dbPath,
    HAYSTACK_RENDERED_LIMIT: String(RENDERED_LIMIT),
  },
  stdio: "ignore",
});

// GPU_LIVE_PROD=1: measure the PRODUCTION build via `vite build` + `vite preview` —
// dev-mode react-dom (performance-track props diffing over the 50k asteroid array) costs
// seconds per commit and completely distorts movement perf. apiBase falls back to relative
// /api in prod, which preview proxies via VITE_API_PROXY.
const PROD = process.env.GPU_LIVE_PROD === "1";
if (PROD) {
  console.log("building production bundle…");
  const build = spawn("./node_modules/.bin/vite", ["build"], { cwd: REPO, stdio: "ignore" });
  await new Promise((res, rej) =>
    build.on("exit", (c) => (c === 0 ? res() : rej(new Error(`vite build exit ${c}`)))),
  );
}
const client = PROD
  ? spawn(
      "./node_modules/.bin/vite",
      ["preview", "--host", "127.0.0.1", "--port", String(CLIENT_PORT), "--strictPort"],
      { cwd: REPO, env: { ...process.env, VITE_API_PROXY: SERVER_URL }, stdio: "ignore" },
    )
  : spawn(
      "./node_modules/.bin/vite",
      ["--host", "127.0.0.1", "--port", String(CLIENT_PORT), "--strictPort"],
      { cwd: REPO, env: { ...process.env, VITE_API_URL: SERVER_URL }, stdio: "ignore" },
    );

let browser = null;
let exitCode = 1;
try {
  await waitForHttp(`${SERVER_URL}/api/health`);
  await waitForHttp(`${CLIENT_URL}/`);
  const joinRes = await fetch(`${SERVER_URL}/api/pilots`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callsign: `Cross-${String(Date.now()).slice(-5)}` }),
  });
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
  console.log(`chrome: ${executablePath ?? "bundled chromium"}`);
  browser = await chromium.launch(launchOpts);
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log(`[pageerror] ${e.message}`));

  const url = new URL(CLIENT_URL);
  url.searchParams.set("pilotId", pilot.id);
  await page.goto(url.toString(), { waitUntil: "networkidle" });
  await page.waitForFunction(
    () => {
      const s = window.__HAYSTACK_RENDER_STATS__;
      return s && s.derivedAsteroidCount > 1000 && s.drawCalls > 0 && s.frame > 5;
    },
    { timeout: 90000, polling: 250 },
  );
  // Let boot settle, then measure ONLY the drift window.
  await new Promise((r) => setTimeout(r, 2000));
  const boot = await page.evaluate(() => window.__HAYSTACK_RENDER_STATS__);
  console.log(
    `boot: fieldDeriveMs=${boot.fieldDeriveMs.toFixed(1)} worstCross=${boot.worstCellCrossFrameMs.toFixed(1)} crosses=${boot.cellCrossCount}`,
  );

  // CPU-profile the drift window (CROSS_PROFILE=1) — definitive main-thread attribution.
  const wantProfile = process.env.CROSS_PROFILE === "1";
  let profCdp = null;
  if (wantProfile) {
    profCdp = await context.newCDPSession(page);
    await profCdp.send("Profiler.enable");
    await profCdp.send("Profiler.setSamplingInterval", { interval: 200 });
    await profCdp.send("Profiler.start");
  }

  // Trace the drift window so 1s+ stalls can be attributed (written when CROSS_TRACE=1).
  const wantTrace = process.env.CROSS_TRACE === "1";
  let cdp = null;
  const traceChunks = [];
  let traceComplete = null;
  if (wantTrace) {
    cdp = await context.newCDPSession(page);
    cdp.on("Tracing.dataCollected", (e) => {
      for (const ev of e.value) traceChunks.push(ev);
    });
    traceComplete = new Promise((res) => cdp.once("Tracing.tracingComplete", res));
    await cdp.send("Tracing.start", {
      transferMode: "ReportEvents",
      traceConfig: {
        recordMode: "recordContinuously",
        includedCategories: [
          "devtools.timeline",
          "disabled-by-default-devtools.timeline",
          "blink.user_timing",
          "v8.execute",
          "disabled-by-default-v8.gc",
        ],
      },
    });
  }

  const result = await page.evaluate(
    ({ drift, seconds }) => {
      return new Promise((resolve) => {
        const dbg = window.__HAYSTACK_RENDER_DEBUG__;
        dbg.reset();
        dbg.drift(drift);
        const frames = [];
        const perCross = [];
        let lastCross = 0;
        let last = performance.now();
        const start = last;
        function tick(now) {
          frames.push(now - last);
          last = now;
          const s = window.__HAYSTACK_RENDER_STATS__;
          if (s.cellCrossCount > lastCross) {
            lastCross = s.cellCrossCount;
            perCross.push({
              cross: s.cellCrossCount,
              fieldDeriveMs: Number(s.fieldDeriveMs.toFixed(1)),
              lastFieldWorkMs: Number(s.lastFieldWorkMs.toFixed(1)),
              worst: Number(s.worstCellCrossFrameMs.toFixed(1)),
            });
          }
          if (now - start < seconds * 1000) requestAnimationFrame(tick);
          else {
            dbg.drift(0);
            const sorted = frames.filter((d) => d > 0).sort((a, b) => a - b);
            const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
            resolve({
              stats: window.__HAYSTACK_RENDER_STATS__,
              perCross,
              frame: {
                count: sorted.length,
                medianMs: Number(pct(0.5).toFixed(1)),
                p99Ms: Number(pct(0.99).toFixed(1)),
                maxMs: Number(sorted[sorted.length - 1].toFixed(1)),
                over50: sorted.filter((d) => d > 50).length,
                over33: sorted.filter((d) => d > 33.4).length,
              },
            });
          }
        }
        requestAnimationFrame(tick);
      });
    },
    { drift: DRIFT_M_PER_DELTA, seconds: DRIFT_SECONDS },
  );

  if (wantProfile) {
    const { profile } = await profCdp.send("Profiler.stop");
    // Aggregate self time per function (node selfHitCount * interval).
    const nodes = new Map(profile.nodes.map((n) => [n.id, n]));
    const selfUs = new Map();
    const hitOf = new Map();
    for (const n of profile.nodes) hitOf.set(n.id, 0);
    if (profile.samples) for (const id of profile.samples) hitOf.set(id, (hitOf.get(id) ?? 0) + 1);
    const total = profile.samples?.length ?? 0;
    const durUs = profile.endTime - profile.startTime;
    for (const [id, hits] of hitOf) {
      if (!hits) continue;
      const n = nodes.get(id);
      const f = n.callFrame;
      const key = `${f.functionName || "(anon)"} @ ${(f.url || "").split("/").slice(-2).join("/")}:${f.lineNumber}`;
      selfUs.set(key, (selfUs.get(key) ?? 0) + (hits / total) * durUs);
    }
    const top = [...selfUs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);
    console.log(`\n=== CPU profile self-time (window ${(durUs / 1000).toFixed(0)}ms) ===`);
    for (const [k, us] of top) console.log(`${(us / 1000).toFixed(1).padStart(8)}ms  ${k}`);
  }

  if (wantTrace) {
    await cdp.send("Tracing.end");
    await traceComplete;
    const tracePath = resolve(REPO, "trace-analysis", "cross-bench.trace.json");
    writeFileSync(tracePath, JSON.stringify({ traceEvents: traceChunks }), "utf8");
    console.log(`trace: ${traceChunks.length} events -> ${tracePath}`);
  }

  console.log(`\n=== drift window (${DRIFT_SECONDS}s @ ${DRIFT_M_PER_DELTA} m/delta) ===`);
  console.log(`frames: ${JSON.stringify(result.frame)}`);
  const s = result.stats;
  console.log(
    `stats: crosses=${s.cellCrossCount} fieldDeriveMs(last)=${s.fieldDeriveMs.toFixed(1)} worstCellCrossFrameMs=${s.worstCellCrossFrameMs.toFixed(1)} reactCommits=${s.reactCommitCount} overviewBuilds=${s.overviewBuildCount}`,
  );
  console.log(`perCross (first 20):`);
  for (const c of result.perCross.slice(0, 20)) console.log(`  ${JSON.stringify(c)}`);
  exitCode = 0;
} catch (e) {
  console.error("BENCH_ERROR:", e?.message ?? e);
} finally {
  if (browser) await browser.close().catch(() => {});
  server.kill("SIGTERM");
  client.kill("SIGTERM");
  if (existsSync(dbPath))
    try {
      rmSync(dbPath);
    } catch {}
}
process.exit(exitCode);
