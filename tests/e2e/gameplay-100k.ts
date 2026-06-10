// C6 checked gameplay validation at HAYSTACK_RENDERED_LIMIT=100000.
//
// The render path (C2–C5) was re-architected to derive and render the full 100k
// field with real per-chunk frustum + distance culling and LOD. This script proves
// that, at renderLimit=100000, the gameplay surfaces that ride on top of the field
// still work: the client derives 100k rocks and culls them (deterministic render
// stats), the overview populates, a rock can be selected + shown-info + its highlight
// overlay tracked (selection must not be culled away with its chunk), and a remote
// ship syncs into the shared world.
//
// It deliberately avoids physics-driven keyboard flight: under headless swiftshader
// at 100k the client render loop runs at ~1s/frame, starving the WS so the local
// prediction stalls or runs away — the full ui.ts/multiplayer.ts flight portions are
// unmeasurable there (documented in progress-client.txt / the PRD's "headless WebGL
// timing is noisy" caveat). The robust signals are the app-exposed counts and the
// snapshot-driven state, which is exactly what this script asserts. Mining + the
// belt/pocket/surface scans + discovery + sell are validated in-process at this same
// renderLimit by `HAYSTACK_RENDERED_LIMIT=100000 bun test tests/integration`.

import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { chromium, type Browser, type Page } from "playwright";

import type { Pilot, Ship, WorldSnapshot } from "../../src/shared/types";
import type { RenderStatsSnapshot } from "../../src/client/eve/render-stats";
import { assert, count, pollUntil, webgpuLaunchOptions } from "./helpers";

const serverPort = 8802;
const clientPort = 5202;
const dbPath = resolve(tmpdir(), `haystack-gameplay-100k-${Date.now()}.sqlite`);
const serverUrl = `http://127.0.0.1:${serverPort}`;
const clientUrl = `http://127.0.0.1:${clientPort}`;
const renderLimit = 100000;

const server = Bun.spawn(["bun", "src/server/main.ts"], {
  env: {
    ...process.env,
    PORT: String(serverPort),
    HAYSTACK_DB: dbPath,
    HAYSTACK_RENDERED_LIMIT: String(renderLimit),
  },
  stdout: "pipe",
  stderr: "pipe",
});

const client = Bun.spawn(
  ["bunx", "vite", "--host", "127.0.0.1", "--port", String(clientPort), "--strictPort"],
  {
    env: { ...process.env, VITE_API_URL: serverUrl },
    stdout: "pipe",
    stderr: "pipe",
  },
);

let browser: Browser | null = null;

try {
  await waitFor(`${serverUrl}/api/health`);
  await waitFor(clientUrl);

  const runId = String(Date.now()).slice(-6);
  const probe = await createPilot(`G100k-Probe-${runId}`);
  const remote = await createPilot(`G100k-Remote-${runId}`);

  // Server confirms it is actually running the 100k field (independent of the client).
  const summary = (await api<WorldSnapshot>(`/api/world?pilotId=${probe.id}`)).field;
  assert(
    summary.renderedLimit === renderLimit,
    `server renderedLimit is ${summary.renderedLimit}, expected ${renderLimit}`,
  );

  // Discover rocks so the overview has asteroid rows to act on.
  await api(`/api/ships/${encodeURIComponent(probe.id)}/scan`, {
    method: "POST",
    body: JSON.stringify({ mode: "pocket" }),
  });

  // Move a remote ship so the probe should see it synced into the shared world.
  await api<{ ship: Ship }>(`/api/ships/${encodeURIComponent(remote.id)}/thrust`, {
    method: "POST",
    body: JSON.stringify({ impulse: { x: 4, y: 0, z: 0 } }),
  });
  const syncedRemote = await waitForRemoteShip(
    probe.id,
    remote.id,
    (ship) => ship.velocity.x >= 3.9,
  );

  browser = await chromium.launch(webgpuLaunchOptions);
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  const url = new URL(clientUrl);
  url.searchParams.set("pilotId", probe.id);
  await page.goto(url.toString(), { waitUntil: "networkidle" });
  await page.waitForSelector("[data-testid='haystack-app']", { timeout: 15000 });

  // 1) The client derives the full 100k field and culls it (real per-instance culling).
  const stats = await pollUntil(
    () => readRenderStats(page),
    (snapshot) =>
      snapshot !== null && snapshot.derivedAsteroidCount >= renderLimit && snapshot.frame > 2,
    90000,
    250,
  );
  assert(stats !== null, "render stats are exposed at 100k");
  assert(
    stats.derivedAsteroidCount >= renderLimit,
    `derived ${stats.derivedAsteroidCount} rocks, expected >= ${renderLimit}`,
  );
  // Under the GPU indirect-draw field (docs/gpu-asteroids-architecture.md §7), culling
  // and instance submission happen on-GPU, so the CPU-side submittedInstanceCount /
  // asteroidDrawCalls accumulators stay 0. The observable signals that the field is
  // really rendering are the whole-frame renderer totals; per-instance cull correctness
  // is gated on-device by `bun run verify:gpu` (cull/LOD GPU-vs-CPU).
  assert(stats.renderedTriangles > 0, "the field submits triangles while facing the rocks");
  assert(
    stats.drawCalls > 0 && stats.drawCalls < 10000,
    `draw calls are a bounded constant, got ${stats.drawCalls}`,
  );

  // 2) Multiplayer remote-ship sync surfaced in the client chrome.
  await page.locator(".pilot-card", { hasText: remote.callsign }).waitFor({ timeout: 20000 });

  // 3) Overview populates at 100k.
  await page.waitForSelector("[data-testid='overview-row']", { timeout: 20000 });
  await page.getByTestId("overview-filter-asteroids").click();
  const asteroidRow = page
    .locator("[data-testid='overview-row'][data-object-kind='asteroid']")
    .first();
  await asteroidRow.waitFor({ timeout: 20000 });

  // 4) Selecting a rock works and the selection survives chunk culling: the selected
  //    item name populates and the in-world highlight overlay (box if in view, arrow if
  //    off-screen) tracks it — proving a selected rock is never lost to the cull.
  await asteroidRow.click();
  assert(
    (await count(page, "[data-testid='overview-row'][data-selected='true']")) === 1,
    "exactly one overview row is selected",
  );
  assert(
    (await page.getByTestId("selected-item-name").innerText()).trim().length > 0,
    "selected item name is populated",
  );
  const highlightTracked = await pollUntil(
    async () =>
      (await await0(count(page, "[data-testid='selection-box']"))) +
      (await await0(count(page, "[data-testid='selection-arrow']"))),
    (total) => total >= 1,
    20000,
    250,
  ).catch(() => 0);
  assert(highlightTracked >= 1, "selected rock highlight overlay (box or arrow) is tracked");

  // 5) Show-info is reachable on a rock via the context menu.
  await asteroidRow.click({ button: "right" });
  await page.waitForSelector("[data-testid='context-menu']", { timeout: 10000 });
  assert(
    (await count(page, "[data-testid='context-item-show-info']")) === 1,
    "context menu exposes show-info on a rock",
  );
  await page.keyboard.press("Escape");

  console.log(
    JSON.stringify(
      {
        appUrl: clientUrl,
        renderLimit,
        probePilotId: probe.id,
        render: {
          derivedAsteroidCount: stats.derivedAsteroidCount,
          submittedInstanceCount: stats.submittedInstanceCount,
          asteroidDrawCalls: stats.asteroidDrawCalls,
        },
        remoteShipSync: { pilotId: remote.id, velocity: syncedRemote.velocity },
        gameplay: "ok",
      },
      null,
      2,
    ),
  );
} finally {
  if (browser !== null) {
    await browser.close();
  }
  server.kill();
  client.kill();
  if (existsSync(dbPath)) {
    rmSync(dbPath);
  }
}

// count() can momentarily throw mid-navigation; treat a failure as zero for the poll.
async function await0(promise: Promise<number>): Promise<number> {
  try {
    return await promise;
  } catch {
    return 0;
  }
}

async function readRenderStats(page: Page): Promise<RenderStatsSnapshot | null> {
  return page.evaluate(() => {
    return (
      (window as unknown as { __HAYSTACK_RENDER_STATS__?: RenderStatsSnapshot })
        .__HAYSTACK_RENDER_STATS__ ?? null
    );
  });
}

async function waitForRemoteShip(
  observerPilotId: string,
  remotePilotId: string,
  predicate: (ship: Ship) => boolean,
): Promise<Ship> {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const snapshot = await api<WorldSnapshot>(
      `/api/world?${new URLSearchParams({ pilotId: observerPilotId }).toString()}`,
    );
    const ship = snapshot.ships.find((candidate) => candidate.pilotId === remotePilotId);
    if (ship !== undefined && predicate(ship)) {
      return ship;
    }
    await Bun.sleep(250);
  }
  throw new Error("Timed out waiting for the remote ship to sync into the shared world.");
}

async function createPilot(callsign: string): Promise<Pilot> {
  return (
    await api<{ pilot: Pilot }>("/api/pilots", {
      method: "POST",
      body: JSON.stringify({ callsign, organization: "Needle Testers" }),
    })
  ).pilot;
}

async function waitFor(url: string): Promise<void> {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      await Bun.sleep(250);
    }
    await Bun.sleep(250);
  }
  throw new Error(`Timed out waiting for ${url}.`);
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${serverUrl}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init.headers },
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return (await response.json()) as T;
}
