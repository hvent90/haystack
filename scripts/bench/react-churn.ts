// React-churn benchmark — the scoreboard for prompt.md's "decouple the 30 Hz data
// stream from React render cadence" goal.
//
// The Chrome trace showed the GPU idle and ~5 FPS caused by per-delta React work:
// every 30 Hz world delta calls setSnapshot, which rebuilds + re-sorts the EVE
// overview (one row per discovered asteroid — ~50k at HAYSTACK_RENDERED_LIMIT=50000)
// and makes react-dom deep-diff ~50k <tr> nodes. This harness MEASURES that cost,
// deterministically, with NO app instrumentation:
//
//   * overviewRowDomNodes  — document.querySelectorAll('[data-testid=overview-row]')
//                            (~50k before virtualization, ~tens after).
//   * scriptMsPerSec       — Chrome CDP Performance.getMetrics ScriptDuration delta
//                            over the window / wall seconds (main-thread JS time/sec).
//   * layoutMsPerSec, recalcStyleMsPerSec, taskMsPerSec — same, other main-thread work.
//   * longTaskCount/Ms     — PerformanceObserver('longtask') over the window (the
//                            >50 ms blocks that freeze rendering; TBT proxy).
//   * fps                  — requestAnimationFrame callbacks / wall seconds.
//   * derivedAsteroidCount, medianFrameMs — from window.__HAYSTACK_RENDER_STATS__.
//
// To reproduce the 30 Hz churn the server must actually emit deltas — it only
// broadcasts a ship when it CHANGED (realtime.ts). So we spawn a second "mover"
// pilot and keep it moving; the measured client then receives the mover's position
// every tick => setSnapshot fires ~30x/s => the real churn.
//
// Usage:
//   CHURN_MODE=dev  bun scripts/bench/react-churn.ts
//   CHURN_MODE=prod bun scripts/bench/react-churn.ts        # vite build + preview
// Env: CHURN_MODE (dev|prod), HAYSTACK_RENDERED_LIMIT (default 50000),
//      CHURN_MEASURE_MS (default 7000), BENCH_HEADFUL=1.

import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { chromium, type Page } from "playwright";

const MODE = (process.env["CHURN_MODE"] ?? "dev") as "dev" | "prod";
const LIMIT = Number(process.env["HAYSTACK_RENDERED_LIMIT"] ?? "50000");
const MEASURE_MS = Number(process.env["CHURN_MEASURE_MS"] ?? "7000");
const WARMUP_MS = Number(process.env["CHURN_WARMUP_MS"] ?? "3000");
const HEADFUL = process.env["BENCH_HEADFUL"] === "1";

const serverPort = Number(process.env["CHURN_SERVER_PORT"] ?? "8830");
const clientPort = Number(process.env["CHURN_CLIENT_PORT"] ?? (MODE === "prod" ? "4230" : "5230"));
const serverUrl = `http://127.0.0.1:${serverPort}`;
const clientUrl = `http://127.0.0.1:${clientPort}`;
const dbPath = resolve(tmpdir(), `haystack-react-churn-${MODE}-${serverPort}.sqlite`);

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

async function waitForHttp(url: string, timeoutMs = 60000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok || response.status === 426 /* WS upgrade route */) {
        return;
      }
    } catch {
      // not up yet
    }
    await Bun.sleep(250);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${serverUrl}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!response.ok) {
    throw new Error(`${path} -> ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as T;
}

async function createPilot(callsign: string): Promise<{ id: string; callsign: string }> {
  const session = await apiJson<{ pilot: { id: string; callsign: string } }>("/api/pilots", {
    method: "POST",
    body: JSON.stringify({ callsign }),
  });
  return session.pilot;
}

async function thrust(pilotId: string, x: number): Promise<void> {
  await apiJson(`/api/ships/${encodeURIComponent(pilotId)}/thrust`, {
    method: "POST",
    body: JSON.stringify({ impulse: { x, y: 0, z: 0 }, frame: "world" }),
  });
}

type RenderStats = {
  derivedAsteroidCount: number;
  medianFrameMs: number;
  frame: number;
  reactCommitCount?: number;
  overviewBuildCount?: number;
};

async function readRenderStats(page: Page): Promise<RenderStats | null> {
  return page.evaluate(
    () =>
      (window as unknown as { __HAYSTACK_RENDER_STATS__?: RenderStats })
        .__HAYSTACK_RENDER_STATS__ ?? null,
  );
}

type PerfMetrics = Record<string, number>;

async function readCdpMetrics(send: (m: string) => Promise<unknown>): Promise<PerfMetrics> {
  const result = (await send("Performance.getMetrics")) as {
    metrics: Array<{ name: string; value: number }>;
  };
  const out: PerfMetrics = {};
  for (const { name, value } of result.metrics) {
    out[name] = value;
  }
  return out;
}

async function main(): Promise<void> {
  rmSync(dbPath, { force: true });

  const server = Bun.spawn(["bun", "src/server/main.ts"], {
    env: {
      ...process.env,
      PORT: String(serverPort),
      HAYSTACK_DB: dbPath,
      HAYSTACK_RENDERED_LIMIT: String(LIMIT),
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  // The client talks DIRECTLY to the server (VITE_API_URL) — no proxy. For prod we
  // bake that URL into the build, then serve dist with `vite preview`.
  if (MODE === "prod") {
    const build = Bun.spawn(["bunx", "vite", "build"], {
      env: { ...process.env, VITE_API_URL: serverUrl },
      stdout: "pipe",
      stderr: "pipe",
    });
    if ((await build.exited) !== 0) {
      throw new Error(`vite build failed: ${await new Response(build.stderr).text()}`);
    }
  }

  const clientCmd =
    MODE === "prod"
      ? [
          "bunx",
          "vite",
          "preview",
          "--host",
          "127.0.0.1",
          "--port",
          String(clientPort),
          "--strictPort",
        ]
      : ["bunx", "vite", "--host", "127.0.0.1", "--port", String(clientPort), "--strictPort"];
  const client = Bun.spawn(clientCmd, {
    env: { ...process.env, VITE_API_URL: serverUrl },
    stdout: "pipe",
    stderr: "pipe",
  });

  const browser = await chromium.launch({ headless: !HEADFUL });
  let moverTimer: ReturnType<typeof setInterval> | null = null;
  try {
    await waitForHttp(`${serverUrl}/api/health`);
    await waitForHttp(clientUrl);

    const runId = String(serverPort);
    const main = await createPilot(`Churn-Main-${runId}`);
    const mover = await createPilot(`Churn-Mover-${runId}`);

    // Keep the mover moving for the whole run so the measured client receives a
    // position delta every server tick (~30 Hz) -> setSnapshot churn.
    await thrust(mover.id, 30);
    moverTimer = setInterval(() => {
      void thrust(mover.id, 30).catch(() => undefined);
    }, 1500);

    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Performance.enable");

    const url = new URL(clientUrl);
    url.searchParams.set("pilotId", main.id);
    await page.goto(url.toString(), { waitUntil: "domcontentloaded" });
    await page.waitForSelector("[data-testid='haystack-app']", { timeout: 30000 });
    await page.waitForSelector("[data-testid='overview-row']", { timeout: 60000 });

    // Install the rAF + longtask observers, then warm up so the field has derived
    // and the steady-state 30 Hz delta churn is running before we sample.
    await page.evaluate(() => {
      const w = window as unknown as {
        __churn: { frames: number; longtasks: number[] };
      };
      w.__churn = { frames: 0, longtasks: [] };
      const po = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          w.__churn.longtasks.push(entry.duration);
        }
      });
      po.observe({ entryTypes: ["longtask"] });
      const tick = (): void => {
        w.__churn.frames += 1;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

    await Bun.sleep(WARMUP_MS);

    // Reset counters and snapshot CDP metrics at the start of the measured window.
    await page.evaluate(() => {
      const w = window as unknown as { __churn: { frames: number; longtasks: number[] } };
      w.__churn.frames = 0;
      w.__churn.longtasks = [];
    });
    const before = await readCdpMetrics((m) => cdp.send(m as never));
    const statsBefore = await readRenderStats(page);
    const t0 = Date.now();

    await Bun.sleep(MEASURE_MS);

    const after = await readCdpMetrics((m) => cdp.send(m as never));
    const wallSec = (Date.now() - t0) / 1000;

    const churn = await page.evaluate(() => {
      const w = window as unknown as { __churn: { frames: number; longtasks: number[] } };
      const lt = w.__churn.longtasks;
      return {
        frames: w.__churn.frames,
        longTaskCount: lt.length,
        longTaskMs: lt.reduce((a, b) => a + b, 0),
        longTaskMaxMs: lt.reduce((a, b) => Math.max(a, b), 0),
      };
    });
    const overviewRowDomNodes = await page.evaluate(
      () => document.querySelectorAll("[data-testid='overview-row']").length,
    );
    const stats = await readRenderStats(page);

    const scriptMsPerSec =
      ((after["ScriptDuration"]! - before["ScriptDuration"]!) * 1000) / wallSec;
    const layoutMsPerSec =
      ((after["LayoutDuration"]! - before["LayoutDuration"]!) * 1000) / wallSec;
    const recalcStyleMsPerSec =
      ((after["RecalcStyleDuration"]! - before["RecalcStyleDuration"]!) * 1000) / wallSec;
    const taskMsPerSec = ((after["TaskDuration"]! - before["TaskDuration"]!) * 1000) / wallSec;

    const commitDelta = (stats?.reactCommitCount ?? 0) - (statsBefore?.reactCommitCount ?? 0);
    const buildDelta = (stats?.overviewBuildCount ?? 0) - (statsBefore?.overviewBuildCount ?? 0);

    const report = {
      mode: MODE,
      renderedLimit: LIMIT,
      measureSec: round(wallSec),
      derivedAsteroidCount: stats?.derivedAsteroidCount ?? null,
      overviewRowDomNodes,
      // ~30/s before coalescing (one React commit per delta), ~10/s after. null on
      // builds that predate the counters. The most direct proof the loop is broken.
      reactCommitsPerSec:
        stats?.reactCommitCount === undefined ? null : round(commitDelta / wallSec),
      overviewBuildsPerSec:
        stats?.overviewBuildCount === undefined ? null : round(buildDelta / wallSec),
      fps: round(churn.frames / wallSec),
      scriptMsPerSec: round(scriptMsPerSec),
      taskMsPerSec: round(taskMsPerSec),
      layoutMsPerSec: round(layoutMsPerSec),
      recalcStyleMsPerSec: round(recalcStyleMsPerSec),
      longTaskCount: churn.longTaskCount,
      longTaskMsPerSec: round(churn.longTaskMs / wallSec),
      longTaskMaxMs: round(churn.longTaskMaxMs),
      medianRenderFrameMs: stats?.medianFrameMs ?? null,
    };
    console.log(JSON.stringify(report, null, 2));
  } finally {
    if (moverTimer !== null) {
      clearInterval(moverTimer);
    }
    await browser.close().catch(() => undefined);
    server.kill();
    client.kill();
    await Bun.sleep(300);
    rmSync(dbPath, { force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
