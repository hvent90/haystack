import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { chromium, type Browser, type Page } from "playwright";

import type { Pilot, Ship, WorldSnapshot } from "../../src/shared/types";

const serverPort = 8799;
const clientPort = 5199;
const dbPath = resolve(tmpdir(), `haystack-multiplayer-${Date.now()}.sqlite`);
const externalAppUrl = process.env["HAYSTACK_MULTIPLAYER_APP_URL"]?.replace(/\/$/, "") ?? null;
const serverUrl = externalAppUrl ?? `http://127.0.0.1:${serverPort}`;
const clientUrl = externalAppUrl ?? `http://127.0.0.1:${clientPort}`;
const runId = String(Date.now()).slice(-6);
const scoutCallsign = `E2E-Scout-${runId}`;
const haulerCallsign = `E2E-Hauler-${runId}`;

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

  browser = await chromium.launch();
  const scoutContext = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const haulerContext = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const scoutPage = await scoutContext.newPage();
  const haulerPage = await haulerContext.newPage();

  await Promise.all([openPilot(scoutPage, scout.id), openPilot(haulerPage, hauler.id)]);
  await Promise.all([
    waitForPilotCard(scoutPage, haulerCallsign),
    waitForPilotCard(haulerPage, scoutCallsign),
  ]);

  await api<{ ship: Ship }>(`/api/ships/${encodeURIComponent(hauler.id)}/thrust`, {
    method: "POST",
    body: JSON.stringify({ impulse: { x: 4, y: 0, z: 0 } }),
  });

  const movedShip = await waitForMovedShip(scout.id, hauler.id);
  await waitForPilotCardText(scoutPage, haulerCallsign, /4\.0m\/s/);

  await haulerPage.locator("[data-testid='haystack-app']").click();
  await haulerPage.keyboard.down("w");
  await Bun.sleep(800);
  await haulerPage.keyboard.up("w");

  const keyboardMovedShip = await waitForShipVelocity(
    scout.id,
    hauler.id,
    (ship) => ship.velocity.z <= -3,
  );

  console.log(
    JSON.stringify(
      {
        appUrl: clientUrl,
        external: externalAppUrl !== null,
        clients: [
          { pilotId: scout.id, callsign: scout.callsign },
          { pilotId: hauler.id, callsign: hauler.callsign },
        ],
        sharedWorld: {
          observerSaw: haulerCallsign,
          movedPilotId: movedShip.pilotId,
          velocity: movedShip.velocity,
          position: movedShip.position,
          keyboardInput: {
            velocity: keyboardMovedShip.velocity,
            position: keyboardMovedShip.position,
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

async function waitForMovedShip(observerPilotId: string, movedPilotId: string): Promise<Ship> {
  return await waitForShipVelocity(observerPilotId, movedPilotId, (ship) => ship.velocity.x >= 3.9);
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
