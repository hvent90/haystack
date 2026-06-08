// Headless client-render benchmark — the scoreboard for the 100k-asteroid render goal.
//
// For each HAYSTACK_RENDERED_LIMIT it boots the real server (bun src/server/main.ts),
// boots vite, loads the client in headless chromium, joins a pilot, waits for the
// client to derive the virtual field, then reads the app-exposed render telemetry
// (window.__HAYSTACK_RENDER_STATS__, populated from the render loop) across three
// camera/movement phases and prints JSON metrics per limit.
//
// The headless WebGL clock (swiftshader) is noisy, so the PRIMARY pass signals are the
// deterministic app-exposed COUNTS — submitted instances after culling, asteroid draw
// calls, triangles — NOT wall-clock FPS. Frame-time numbers are reported but secondary.
//
// It also runs a fast in-process (no browser) micro-bench of deriveVirtualField at the
// 100k render limit so the field-derivation cost is visible without GPU noise.
//
// Usage:
//   bun scripts/bench/client-render.ts                       # limits 2000 + 100000
//   BENCH_LIMIT_GRID=100000 bun scripts/bench/client-render.ts
//
// Env knobs: BENCH_LIMIT_GRID (csv), BENCH_PORT, BENCH_CLIENT_PORT, BENCH_HEADFUL.

import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { chromium, type Page } from "playwright";

import { deriveVirtualField } from "../../src/client/eve/field-derivation";
import type { FieldSummary } from "../../src/shared/types";

type RenderStatsSnapshot = {
  frame: number;
  derivedAsteroidCount: number;
  submittedInstanceCount: number;
  asteroidDrawCalls: number;
  asteroidTriangles: number;
  drawCalls: number;
  renderedTriangles: number;
  fieldDeriveMs: number;
  lastFrameMs: number;
  medianFrameMs: number;
  worstCellCrossFrameMs: number;
  cellCrossCount: number;
};

type LimitMetrics = {
  renderLimit: number;
  derivedAsteroidCount: number;
  submittedInstanceCount: number;
  cameraFacingEmptySubmittedInstanceCount: number;
  asteroidDrawCalls: number;
  drawCalls: number;
  asteroidTriangles: number;
  renderedTriangles: number;
  fieldDeriveMs: number;
  worstCellCrossFrameMs: number;
  medianFrameMs: number;
  cellCrossCount: number;
};

const LIMITS = (process.env["BENCH_LIMIT_GRID"] ?? "2000,100000").split(",").map(Number);
const SERVER_PORT_BASE = Number(process.env["BENCH_PORT"] ?? "8810");
const CLIENT_PORT_BASE = Number(process.env["BENCH_CLIENT_PORT"] ?? "5210");
const HEADFUL = process.env["BENCH_HEADFUL"] === "1";

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

async function waitForHttp(url: string, timeoutMs = 30000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // not up yet
    }
    await Bun.sleep(250);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function runJoin(serverUrl: string, statePath: string): Promise<string> {
  const proc = Bun.spawn(
    ["bun", "src/cli/main.ts", "join", "Bench-Render", "--server", serverUrl],
    {
      env: { ...process.env, HAYSTACK_CLI_STATE: statePath },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`join failed: ${stderr}`);
  }
  const state = JSON.parse(readFileSync(statePath, "utf8")) as { pilotId: string };
  return state.pilotId;
}

async function readStats(page: Page): Promise<RenderStatsSnapshot | null> {
  return page.evaluate(() => {
    return (
      (window as unknown as { __HAYSTACK_RENDER_STATS__?: RenderStatsSnapshot })
        .__HAYSTACK_RENDER_STATS__ ?? null
    );
  });
}

async function waitForField(page: Page, timeoutMs = 30000): Promise<RenderStatsSnapshot> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const stats = await readStats(page);
    if (stats !== null && stats.derivedAsteroidCount > 0 && stats.frame > 5) {
      return stats;
    }
    await Bun.sleep(150);
  }
  throw new Error("Timed out waiting for the client to derive the asteroid field.");
}

async function resetStatsWindow(page: Page): Promise<void> {
  await page.evaluate(() => {
    (
      window as unknown as { __HAYSTACK_RENDER_DEBUG__?: { reset: () => void } }
    ).__HAYSTACK_RENDER_DEBUG__?.reset();
  });
}

async function setFaceAway(page: Page, on: boolean): Promise<void> {
  await page.evaluate((value) => {
    (
      window as unknown as { __HAYSTACK_RENDER_DEBUG__?: { faceAway: (on: boolean) => void } }
    ).__HAYSTACK_RENDER_DEBUG__?.faceAway(value);
  }, on);
}

// Push the ship hard enough to keep crossing field cells (1130 m each) for a few
// seconds, so worstCellCrossFrameMs samples the rebuild/upload cost on a real crossing.
async function thrustBurst(serverUrl: string, pilotId: string, count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await fetch(`${serverUrl}/api/ships/${encodeURIComponent(pilotId)}/thrust`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ impulse: { x: 12, y: 0, z: 0 } }),
    }).catch(() => undefined);
  }
}

async function measureLimit(limit: number, index: number): Promise<LimitMetrics> {
  const serverPort = SERVER_PORT_BASE + index;
  const clientPort = CLIENT_PORT_BASE + index;
  const serverUrl = `http://127.0.0.1:${serverPort}`;
  const dbPath = resolve(tmpdir(), `haystack-client-render-${limit}-${index}.sqlite`);
  const statePath = resolve(tmpdir(), `haystack-client-render-${limit}-${index}.json`);

  const server = Bun.spawn(["bun", "src/server/main.ts"], {
    env: {
      ...process.env,
      PORT: String(serverPort),
      HAYSTACK_DB: dbPath,
      HAYSTACK_RENDERED_LIMIT: String(limit),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const client = Bun.spawn(["bunx", "vite", "--host", "127.0.0.1", "--port", String(clientPort)], {
    env: { ...process.env, VITE_API_URL: serverUrl },
    stdout: "pipe",
    stderr: "pipe",
  });

  const browser = await chromium.launch({ headless: !HEADFUL });
  try {
    await waitForHttp(`${serverUrl}/api/health`);
    await waitForHttp(`http://127.0.0.1:${clientPort}`);

    const pilotId = await runJoin(serverUrl, statePath);

    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    const appUrl = new URL(`http://127.0.0.1:${clientPort}`);
    appUrl.searchParams.set("pilotId", pilotId);
    await page.goto(appUrl.toString(), { waitUntil: "networkidle" });
    await page.waitForSelector("[data-testid='haystack-app']", { timeout: 20000 });
    await page.locator("canvas").first().waitFor({ timeout: 20000 });

    await waitForField(page);

    // Phase 1: steady state, camera facing into the field.
    await setFaceAway(page, false);
    await resetStatsWindow(page);
    await Bun.sleep(2500);
    const steady = await readStats(page);

    // Phase 2: camera rotated 180° toward the empty hemisphere behind the ship.
    await setFaceAway(page, true);
    await resetStatsWindow(page);
    await Bun.sleep(1500);
    const empty = await readStats(page);

    // Phase 3: fly across field cells and capture the worst cell-cross frame.
    await setFaceAway(page, false);
    await resetStatsWindow(page);
    await thrustBurst(serverUrl, pilotId, 160);
    await Bun.sleep(4000);
    const moving = await readStats(page);

    if (steady === null || empty === null || moving === null) {
      throw new Error("Render stats were never published by the client.");
    }

    return {
      renderLimit: limit,
      derivedAsteroidCount: Math.max(steady.derivedAsteroidCount, moving.derivedAsteroidCount),
      submittedInstanceCount: steady.submittedInstanceCount,
      cameraFacingEmptySubmittedInstanceCount: empty.submittedInstanceCount,
      asteroidDrawCalls: steady.asteroidDrawCalls,
      drawCalls: steady.drawCalls,
      asteroidTriangles: steady.asteroidTriangles,
      renderedTriangles: steady.renderedTriangles,
      fieldDeriveMs: round(Math.max(steady.fieldDeriveMs, moving.fieldDeriveMs)),
      worstCellCrossFrameMs: round(moving.worstCellCrossFrameMs),
      medianFrameMs: round(steady.medianFrameMs),
      cellCrossCount: moving.cellCrossCount,
    };
  } finally {
    await browser.close();
    server.kill();
    client.kill();
    await server.exited.catch(() => undefined);
    await client.exited.catch(() => undefined);
    if (existsSync(dbPath)) {
      rmSync(dbPath);
    }
    if (existsSync(statePath)) {
      rmSync(statePath);
    }
  }
}

// In-process micro-bench of deriveVirtualField at the 100k render limit — measures the
// pure field-derivation cost (a cell-cross does this once) with no browser/GPU noise.
function microBenchDerive(): {
  renderLimit: number;
  derivedCount: number;
  iterations: number;
  medianMs: number;
  minMs: number;
  maxMs: number;
} {
  const cellSize = 1130;
  const field: FieldSummary = {
    totalAsteroids: 1_000_000,
    seed: 424242,
    cellSize,
    indexKind: "cubicCellHierarchy",
    renderedLimit: 100_000,
  };
  const iterations = 16;
  const warmup = 3;
  let derivedCount = 0;
  const samples: number[] = [];
  for (let i = 0; i < warmup + iterations; i += 1) {
    // Vary the query cell each iteration so caching/JIT can't trivialize the cost.
    const position = { x: (i - warmup) * cellSize * 3, y: 0, z: 0 };
    const start = performance.now();
    const result = deriveVirtualField(position, field);
    const elapsed = performance.now() - start;
    if (i >= warmup) {
      samples.push(elapsed);
      derivedCount = result.length;
    }
  }
  samples.sort((a, b) => a - b);
  return {
    renderLimit: 100_000,
    derivedCount,
    iterations,
    medianMs: round(samples[Math.floor(samples.length / 2)] ?? 0),
    minMs: round(samples[0] ?? 0),
    maxMs: round(samples[samples.length - 1] ?? 0),
  };
}

async function main(): Promise<void> {
  const microBench = microBenchDerive();
  process.stderr.write(
    `[bench] deriveVirtualField @100k: derived=${microBench.derivedCount} ` +
      `median=${microBench.medianMs}ms min=${microBench.minMs}ms max=${microBench.maxMs}ms\n`,
  );

  const results: LimitMetrics[] = [];
  for (let i = 0; i < LIMITS.length; i += 1) {
    const limit = LIMITS[i]!;
    process.stderr.write(`[bench] measuring renderLimit=${limit}...\n`);
    const metrics = await measureLimit(limit, i);
    results.push(metrics);
    process.stderr.write(
      `[bench] limit=${metrics.renderLimit} derived=${metrics.derivedAsteroidCount} ` +
        `submitted=${metrics.submittedInstanceCount} emptySubmitted=${metrics.cameraFacingEmptySubmittedInstanceCount} ` +
        `astDraws=${metrics.asteroidDrawCalls} drawCalls=${metrics.drawCalls} ` +
        `astTris=${metrics.asteroidTriangles} tris=${metrics.renderedTriangles} ` +
        `deriveMs=${metrics.fieldDeriveMs} worstCrossMs=${metrics.worstCellCrossFrameMs} ` +
        `medianMs=${metrics.medianFrameMs} crosses=${metrics.cellCrossCount}\n`,
    );
  }

  process.stdout.write(`${JSON.stringify({ microBench, results }, null, 2)}\n`);
}

await main();
