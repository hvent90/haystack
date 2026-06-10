import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { chromium, type Browser, type Page } from "playwright";

import type { Pilot, Ship, WorldSnapshot } from "../../src/shared/types";
import { webgpuLaunchOptions } from "./helpers";

const serverPort = 8799;
const clientPort = 5199;
const dbPath = resolve(tmpdir(), `haystack-multiplayer-${Date.now()}.sqlite`);
const externalAppUrl = process.env["HAYSTACK_MULTIPLAYER_APP_URL"]?.replace(/\/$/, "") ?? null;
const serverUrl = externalAppUrl ?? `http://127.0.0.1:${serverPort}`;
const clientUrl = externalAppUrl ?? `http://127.0.0.1:${clientPort}`;
const runId = String(Date.now()).slice(-6);
const scoutCallsign = `E2E-Scout-${runId}`;
const haulerCallsign = `E2E-Hauler-${runId}`;
const inactiveCallsign = `E2E-Inactive-${runId}`;

const server =
  externalAppUrl === null
    ? Bun.spawn(["bun", "src/server/main.ts"], {
        env: {
          ...process.env,
          PORT: String(serverPort),
          HAYSTACK_DB: dbPath,
        },
        stdout: "pipe",
        stderr: "pipe",
      })
    : null;

const client =
  externalAppUrl === null
    ? Bun.spawn(
        ["bunx", "vite", "--host", "127.0.0.1", "--port", String(clientPort), "--strictPort"],
        {
          env: {
            ...process.env,
            VITE_API_URL: serverUrl,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      )
    : null;

let browser: Browser | null = null;

try {
  await waitFor(`${serverUrl}/api/health`);
  if (externalAppUrl === null) {
    await waitFor(clientUrl);
  }

  const scout = (
    await api<{ pilot: Pilot }>("/api/pilots", {
      method: "POST",
      body: JSON.stringify({ callsign: scoutCallsign, organization: "Needle Testers" }),
    })
  ).pilot;
  const hauler = (
    await api<{ pilot: Pilot }>("/api/pilots", {
      method: "POST",
      body: JSON.stringify({ callsign: haulerCallsign, organization: "Needle Testers" }),
    })
  ).pilot;
  const inactive = (
    await api<{ pilot: Pilot }>("/api/pilots", {
      method: "POST",
      body: JSON.stringify({ callsign: inactiveCallsign, organization: "Needle Testers" }),
    })
  ).pilot;

  browser = await chromium.launch(webgpuLaunchOptions);
  const scoutContext = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const haulerContext = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const scoutPage = await scoutContext.newPage();
  const haulerPage = await haulerContext.newPage();

  await Promise.all([openPilot(scoutPage, scout.id), openPilot(haulerPage, hauler.id)]);
  await Promise.all([
    waitForPilotCard(scoutPage, haulerCallsign),
    waitForPilotCard(haulerPage, scoutCallsign),
  ]);
  await Promise.all([waitForCommsLocalCount(scoutPage, 2), waitForCommsLocalCount(haulerPage, 2)]);
  await Promise.all([
    assertNoCommsLocal(scoutPage, inactive.id),
    assertNoCommsLocal(haulerPage, inactive.id),
  ]);

  await api<{ ship: Ship }>(`/api/ships/${encodeURIComponent(hauler.id)}/thrust`, {
    method: "POST",
    body: JSON.stringify({ impulse: { x: 4, y: 0, z: 0 } }),
  });

  const movedShip = await waitForMovedShip(scout.id, hauler.id);
  await waitForPilotCardText(scoutPage, haulerCallsign, /4\.0m\/s/);

  await haulerPage.getByTestId("flight-mode-toggle").click();
  await haulerPage.waitForFunction(
    () =>
      document.querySelector("[data-testid='haystack-app']")?.getAttribute("data-flight-mode") ===
      "flight",
  );
  await haulerPage.keyboard.down("w");
  await haulerPage.waitForFunction(
    () =>
      Number(
        document.querySelector("[data-testid='haystack-app']")?.getAttribute("data-throttle"),
      ) > 0,
  );
  await Bun.sleep(800);
  await haulerPage.keyboard.up("w");
  await haulerPage.waitForFunction(
    () =>
      Number(
        document.querySelector("[data-testid='haystack-app']")?.getAttribute("data-throttle"),
      ) === 0,
  );

  const keyboardMovedShip = await waitForShipVelocity(
    scout.id,
    hauler.id,
    (ship) => ship.velocity.z <= -3,
  );
  await Bun.sleep(700);
  const releasedShip = await findShip(scout.id, hauler.id);
  if (releasedShip.velocity.z < keyboardMovedShip.velocity.z - 0.75) {
    throw new Error(
      `W continued accelerating after keyup: ${JSON.stringify({
        before: keyboardMovedShip.velocity,
        after: releasedShip.velocity,
      })}`,
    );
  }

  // Light toggles: hauler presses F (flashlight) and L (nav lights); the scout's view of
  // the world (same delta stream every remote client consumes) must flip both flags on,
  // then back off. The hauler's own HUD hint must reflect the local state immediately.
  await haulerPage.keyboard.press("f");
  await haulerPage.keyboard.press("l");
  await haulerPage.waitForFunction(() => {
    const app = document.querySelector("[data-testid='haystack-app']");
    return (
      app?.getAttribute("data-owned-flashlight") === "true" &&
      app?.getAttribute("data-owned-nav-lights") === "true"
    );
  });
  await haulerPage.waitForFunction(
    () =>
      document.querySelector("[data-testid='hud-keybind-nav-lights']")?.getAttribute("data-on") ===
        "true" &&
      document.querySelector("[data-testid='hud-keybind-flashlight']")?.getAttribute("data-on") ===
        "true",
  );
  await waitForShipState(
    scout.id,
    hauler.id,
    (ship) => ship.navLightsOn && ship.flashlightOn,
    "remote ship lights on",
  );
  await waitForRemoteShipLights(scoutPage, hauler.id, true);

  await haulerPage.keyboard.press("f");
  await haulerPage.keyboard.press("l");
  await waitForShipState(
    scout.id,
    hauler.id,
    (ship) => !ship.navLightsOn && !ship.flashlightOn,
    "remote ship lights off",
  );
  await waitForRemoteShipLights(scoutPage, hauler.id, false);

  // Ship-ship collision: drive the hauler straight at the scout. The two must bump and
  // separate — never interpenetrate (gap stays >= 2 x 50 m ship radius), and the
  // stationary scout must pick up momentum from the hit.
  for (let i = 0; i < 12; i += 1) {
    await api(`/api/ships/${encodeURIComponent(hauler.id)}/thrust`, {
      method: "POST",
      body: JSON.stringify({ impulse: { x: 0, y: 0, z: 0 }, stabilize: true }),
    });
  }
  const beforeRam = await shipPair(scout.id, hauler.id);
  const ramRange = vectorDistance(beforeRam.hauler.position, beforeRam.scout.position);
  const ramDirection = {
    x: (beforeRam.scout.position.x - beforeRam.hauler.position.x) / ramRange,
    y: (beforeRam.scout.position.y - beforeRam.hauler.position.y) / ramRange,
    z: (beforeRam.scout.position.z - beforeRam.hauler.position.z) / ramRange,
  };
  for (let i = 0; i < 3; i += 1) {
    await api(`/api/ships/${encodeURIComponent(hauler.id)}/thrust`, {
      method: "POST",
      body: JSON.stringify({
        impulse: { x: ramDirection.x * 12, y: ramDirection.y * 12, z: ramDirection.z * 12 },
      }),
    });
  }

  let minGap = ramRange;
  let scoutPeakSpeed = 0;
  const ramDeadline = Date.now() + Math.ceil((ramRange / 36) * 1000) + 20000;
  let bumped = false;
  while (Date.now() < ramDeadline) {
    const pair = await shipPair(scout.id, hauler.id);
    const gap = vectorDistance(pair.hauler.position, pair.scout.position);
    minGap = Math.min(minGap, gap);
    const scoutSpeed = Math.hypot(
      pair.scout.velocity.x,
      pair.scout.velocity.y,
      pair.scout.velocity.z,
    );
    scoutPeakSpeed = Math.max(scoutPeakSpeed, scoutSpeed);
    if (scoutSpeed > 5 && gap >= 100) {
      bumped = true;
      break;
    }
    await Bun.sleep(50);
  }
  if (!bumped) {
    throw new Error(
      `Ships never collided: minGap=${minGap.toFixed(1)} scoutPeakSpeed=${scoutPeakSpeed.toFixed(1)}`,
    );
  }
  if (minGap < 94) {
    throw new Error(`Ships interpenetrated: minGap=${minGap.toFixed(1)} < 94 m`);
  }
  // After the bump they must end separated, not overlapping.
  await Bun.sleep(1000);
  const afterRam = await shipPair(scout.id, hauler.id);
  const finalGap = vectorDistance(afterRam.hauler.position, afterRam.scout.position);
  if (finalGap < 100) {
    throw new Error(`Ships still overlapping after bump: gap=${finalGap.toFixed(1)}`);
  }

  console.log(
    JSON.stringify(
      {
        appUrl: clientUrl,
        external: externalAppUrl !== null,
        shipCollision: {
          approachRange: Number(ramRange.toFixed(1)),
          minGap: Number(minGap.toFixed(1)),
          scoutPeakSpeed: Number(scoutPeakSpeed.toFixed(1)),
          finalGap: Number(finalGap.toFixed(1)),
        },
        clients: [
          { pilotId: scout.id, callsign: scout.callsign },
          { pilotId: hauler.id, callsign: hauler.callsign },
        ],
        inactivePilotId: inactive.id,
        sharedWorld: {
          observerSaw: haulerCallsign,
          movedPilotId: movedShip.pilotId,
          velocity: movedShip.velocity,
          position: movedShip.position,
          keyboardInput: {
            velocity: keyboardMovedShip.velocity,
            position: keyboardMovedShip.position,
            releasedVelocity: releasedShip.velocity,
          },
        },
      },
      null,
      2,
    ),
  );
} finally {
  if (browser !== null) {
    await browser.close();
  }
  server?.kill();
  client?.kill();
  if (externalAppUrl === null && existsSync(dbPath)) {
    rmSync(dbPath);
  }
}

async function openPilot(page: Page, pilotId: string): Promise<void> {
  const url = new URL(clientUrl);
  url.searchParams.set("pilotId", pilotId);
  await page.goto(url.toString(), { waitUntil: "networkidle" });
  await page.waitForSelector("[data-testid='haystack-app']", { timeout: 15000 });
}

async function waitForPilotCard(page: Page, callsign: string): Promise<void> {
  await page.locator(".pilot-card", { hasText: callsign }).waitFor({ timeout: 15000 });
}

async function waitForPilotCardText(page: Page, callsign: string, text: RegExp): Promise<void> {
  await page
    .locator(".pilot-card", { hasText: callsign })
    .filter({ hasText: text })
    .waitFor({ timeout: 20000 });
}

async function waitForCommsLocalCount(page: Page, expected: number): Promise<void> {
  await page.waitForFunction(
    (count) =>
      document.querySelector("[data-testid='comms-local-count']")?.textContent?.trim() ===
      `${count} local`,
    expected,
    { timeout: 15000 },
  );
}

async function assertNoCommsLocal(page: Page, pilotId: string): Promise<void> {
  const count = await page.locator(`[data-testid='comms-local-${pilotId}']`).count();
  if (count !== 0) {
    throw new Error(`Inactive pilot appeared in Comms Local: ${pilotId}`);
  }
}

async function waitForMovedShip(observerPilotId: string, movedPilotId: string): Promise<Ship> {
  return await waitForShipVelocity(observerPilotId, movedPilotId, (ship) => ship.velocity.x >= 3.9);
}

async function shipPair(
  scoutPilotId: string,
  haulerPilotId: string,
): Promise<{ scout: Ship; hauler: Ship }> {
  const query = new URLSearchParams({ pilotId: scoutPilotId });
  const snapshot = await api<WorldSnapshot>(`/api/world?${query.toString()}`);
  const scoutShip = snapshot.ships.find((ship) => ship.pilotId === scoutPilotId);
  const haulerShip = snapshot.ships.find((ship) => ship.pilotId === haulerPilotId);
  if (scoutShip === undefined || haulerShip === undefined) {
    throw new Error("Expected both ships in the world snapshot.");
  }
  return { scout: scoutShip, hauler: haulerShip };
}

function vectorDistance(
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

async function waitForShipState(
  observerPilotId: string,
  targetPilotId: string,
  predicate: (ship: Ship) => boolean,
  label: string,
): Promise<Ship> {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const query = new URLSearchParams({ pilotId: observerPilotId });
    const snapshot = await api<WorldSnapshot>(`/api/world?${query.toString()}`);
    const targetShip = snapshot.ships.find((ship) => ship.pilotId === targetPilotId);
    if (targetShip !== undefined && predicate(targetShip)) {
      return targetShip;
    }
    await Bun.sleep(250);
  }
  throw new Error(`Timed out waiting for ${label} in shared world snapshot.`);
}

// The observer page's OtherShipMesh writes the light state it renders for each remote
// ship to window.__probeRemoteLights — proving the flags rode the delta stream into the
// remote client's scene gates, not just the server snapshot.
async function waitForRemoteShipLights(page: Page, pilotId: string, on: boolean): Promise<void> {
  await page.waitForFunction(
    ({ targetPilotId, expected }) => {
      const probe = (
        window as unknown as {
          __probeRemoteLights?: Record<string, { nav: boolean; flash: boolean }>;
        }
      ).__probeRemoteLights?.[targetPilotId];
      return probe !== undefined && probe.nav === expected && probe.flash === expected;
    },
    { targetPilotId: pilotId, expected: on },
    { timeout: 20000 },
  );
}

async function waitForShipVelocity(
  observerPilotId: string,
  movedPilotId: string,
  predicate: (ship: Ship) => boolean,
): Promise<Ship> {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const query = new URLSearchParams({ pilotId: observerPilotId });
    const snapshot = await api<WorldSnapshot>(`/api/world?${query.toString()}`);
    const movedShip = snapshot.ships.find((ship) => ship.pilotId === movedPilotId);
    if (movedShip !== undefined && predicate(movedShip)) {
      return movedShip;
    }
    await Bun.sleep(250);
  }
  throw new Error("Timed out waiting for expected ship velocity in shared world snapshot.");
}

async function findShip(observerPilotId: string, movedPilotId: string): Promise<Ship> {
  const query = new URLSearchParams({ pilotId: observerPilotId });
  const snapshot = await api<WorldSnapshot>(`/api/world?${query.toString()}`);
  const movedShip = snapshot.ships.find((ship) => ship.pilotId === movedPilotId);
  if (movedShip === undefined) {
    throw new Error(`Could not find ship ${movedPilotId} in world snapshot.`);
  }
  return movedShip;
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
    headers: {
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return (await response.json()) as T;
}
