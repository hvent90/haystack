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
import { packField, unpackField } from "../../src/client/eve/field-core";
import { partitionIntoChunks, reconcileChunks } from "../../src/client/eve/field-chunks";
import type { Asteroid, FieldSummary } from "../../src/shared/types";

type RenderStatsSnapshot = {
  frame: number;
  derivedAsteroidCount: number;
  submittedInstanceCount: number;
  asteroidDrawCalls: number;
  asteroidTriangles: number;
  drawCalls: number;
  renderedTriangles: number;
  fieldDeriveMs: number;
  lastFieldWorkMs: number;
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
  steadyFieldWorkMs: number;
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

async function setDrift(page: Page, metersPerDelta: number): Promise<void> {
  await page.evaluate((value) => {
    (
      window as unknown as { __HAYSTACK_RENDER_DEBUG__?: { drift: (m: number) => void } }
    ).__HAYSTACK_RENDER_DEBUG__?.drift(value);
  }, metersPerDelta);
}

// Drive the owned ship across field cells at a controlled rate (the drift debug control,
// see RenderDebugControls.drift) and poll until enough crossings have been observed, then
// stop drifting. Each crossing exercises the real derive→worker→reconstruct→partition→
// reconcile→build pipeline; worstCellCrossFrameMs (per-cross main-thread work) is what C4
// gates. We drive deterministically rather than with thrust because the client prediction
// is unusable at 100k under headless swiftshader — it stalls or runs away past the field.
async function flyAndSampleCrossings(page: Page): Promise<RenderStatsSnapshot> {
  const deadline = Date.now() + 22000;
  let worst = 0;
  let last: RenderStatsSnapshot | null = null;
  // ~1180 m per drift tick ≈ one 1130 m cell, so each tick that fires re-pages roughly a
  // single cell — the realistic "constant re-paging" crossing C4 targets — while the ship
  // stays inside the ±56 km field for the whole window (~47 cells to the edge).
  await setDrift(page, 1180);
  while (Date.now() < deadline) {
    await Bun.sleep(1000);
    const stats = await readStats(page);
    if (stats !== null) {
      worst = Math.max(worst, stats.worstCellCrossFrameMs);
      last = stats;
      if (stats.cellCrossCount >= 8) {
        break;
      }
    }
  }
  await setDrift(page, 0);
  const final = (await readStats(page)) ?? last;
  if (final === null) {
    throw new Error("Render stats were never published during the drift phase.");
  }
  return { ...final, worstCellCrossFrameMs: Math.max(worst, final.worstCellCrossFrameMs) };
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

    // Phase 2: camera lifted far above the field and aimed up into empty space, so a
    // correctly chunk-culled field submits ~0 instances (the ship spawns at the field
    // center, so a mere 180° yaw would still face the surrounding derived ball).
    await setFaceAway(page, true);
    await resetStatsWindow(page);
    await Bun.sleep(1500);
    const empty = await readStats(page);

    // Phase 3: fly across field cells and capture the worst per-cross main-thread field
    // work (derive/reconstruct + partition + instance build). The derive is offloaded to a
    // worker, so this samples only the main-thread cost a crossing imposes.
    await setFaceAway(page, false);
    await resetStatsWindow(page);
    const moving = await flyAndSampleCrossings(page);

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
      steadyFieldWorkMs: round(steady.lastFieldWorkMs),
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

// In-process micro-bench of the MAIN-THREAD work a cell crossing imposes at 100k, with no
// browser/GPU/GC-under-swiftshader noise (the same reason microBenchDerive runs in-process).
// On a crossing the worker derives the new cell OFF the main thread; the main thread then
// only (a) reconstructs the Asteroid[] reusing the previous cross's objects and (b) re-
// partitions + reconciles the chunks, reusing unchanged ones. THAT — not the off-thread
// derive — is what must stay under the frame budget (item C4). We measure a realistic
// single-cell crossing (97%+ objects/chunks unchanged); the chunk matrix BUILD that follows
// touches only the few changed chunks (it needs a GL context, so it is excluded here — it is
// small and bounded by the changed-chunk count, never the full 100k set).
function microBenchCrossWork(): {
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
  const seedFromCell = (cell: number): Asteroid[] =>
    deriveVirtualField({ x: cell * cellSize, y: 0, z: 0 }, field);
  // Seed the reuse state from cell 0 (this is the boot/first-paint cost, not a crossing).
  let prevUnpacked = unpackField(packField(seedFromCell(0)), null);
  let prevChunks = partitionIntoChunks(prevUnpacked.asteroids);
  const iterations = 12;
  const warmup = 3;
  let derivedCount = 0;
  const samples: number[] = [];
  for (let i = 1; i <= warmup + iterations; i += 1) {
    // The worker's off-thread work (derive + pack) — NOT part of the main-thread cost.
    const packed = packField(seedFromCell(i));
    const start = performance.now();
    // Main-thread crossing work: reconstruct (reusing prior objects) + partition + reconcile.
    const unpacked = unpackField(packed, prevUnpacked.byCell);
    const chunks = reconcileChunks(prevChunks, unpacked.asteroids);
    const elapsed = performance.now() - start;
    prevUnpacked = unpacked;
    prevChunks = chunks;
    derivedCount = unpacked.asteroids.length;
    if (i > warmup) {
      samples.push(elapsed);
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
  const crossWorkBench = microBenchCrossWork();
  process.stderr.write(
    `[bench] per-cross main-thread work @100k: derived=${crossWorkBench.derivedCount} ` +
      `median=${crossWorkBench.medianMs}ms min=${crossWorkBench.minMs}ms max=${crossWorkBench.maxMs}ms\n`,
  );
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
        `deriveMs=${metrics.fieldDeriveMs} steadyFieldWorkMs=${metrics.steadyFieldWorkMs} ` +
        `worstCrossMs=${metrics.worstCellCrossFrameMs} ` +
        `medianMs=${metrics.medianFrameMs} crosses=${metrics.cellCrossCount}\n`,
    );
  }

  process.stdout.write(`${JSON.stringify({ microBench, crossWorkBench, results }, null, 2)}\n`);
}

await main();
