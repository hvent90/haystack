// Visual evidence harness for replicated ship lights (nav lights + flashlight beam).
//
// Boots the real server + vite client, opens ONE real-Chrome viewer (pilot A), and
// drives a second pilot (B) entirely over the wire: REST thrust for motion, raw world-
// stream input frames for the navLights/flashlight toggles — the exact replication path
// a second player's client uses. The viewer camera is aimed at B with the render debug
// lookDir override, and screenshots land in screenshots/lights-*.png:
//
//   lights-close-off.png  — B ~150 m away, lights off (control)
//   lights-close-on.png   — same range, nav lights + flashlight on
//   lights-far-on.png     — B ~10 km away, lights on (findability claim)
//   lights-far-off.png    — same range, lights off (control)
//
// Usage: bun scripts/bench/lights-visual.ts   (CHROME_PATH overrides Chrome detection)

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { chromium, type Browser, type Page } from "playwright";

import type { Pilot, Ship, WorldSnapshot } from "../../src/shared/types";

const serverPort = 8817;
const clientPort = 5217;
const dbPath = resolve(tmpdir(), `haystack-lights-visual-${Date.now()}.sqlite`);
const serverUrl = `http://127.0.0.1:${serverPort}`;
const clientUrl = `http://127.0.0.1:${clientPort}`;
const shotsDir = resolve(import.meta.dirname, "..", "..", "screenshots");
mkdirSync(shotsDir, { recursive: true });

function detectChrome(): string | undefined {
  if (process.env["CHROME_PATH"] && existsSync(process.env["CHROME_PATH"])) {
    return process.env["CHROME_PATH"];
  }
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

const server = Bun.spawn(["bun", "src/server/main.ts"], {
  env: {
    ...process.env,
    PORT: String(serverPort),
    HAYSTACK_DB: dbPath,
    HAYSTACK_RENDERED_LIMIT: "2000",
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
let subjectSocket: WebSocket | null = null;
let clientTick = 1000;

try {
  await waitFor(`${serverUrl}/api/health`);
  await waitFor(clientUrl);

  const viewer = (
    await api<{ pilot: Pilot }>("/api/pilots", {
      method: "POST",
      body: JSON.stringify({ callsign: `Lights-Viewer-${Date.now() % 1e6}` }),
    })
  ).pilot;
  const subject = (
    await api<{ pilot: Pilot }>("/api/pilots", {
      method: "POST",
      body: JSON.stringify({ callsign: `Lights-Subject-${Date.now() % 1e6}` }),
    })
  ).pilot;

  subjectSocket = await openSubjectStream(subject.id);

  const executablePath = detectChrome();
  browser = await chromium.launch({
    args: ["--enable-unsafe-webgpu", "--enable-unsafe-swiftshader"],
    ...(executablePath === undefined ? {} : { executablePath }),
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  const url = new URL(clientUrl);
  url.searchParams.set("pilotId", viewer.id);
  await page.goto(url.toString(), { waitUntil: "networkidle" });
  await page.waitForSelector("[data-testid='haystack-app']", { timeout: 30000 });
  // Close every open window so the screenshots show the 3D scene, not the UI layout.
  await page.evaluate(() => {
    for (const button of document.querySelectorAll<HTMLButtonElement>("[data-testid$='-close']")) {
      button.click();
    }
  });
  // Let the field derive + first frames settle.
  await Bun.sleep(3000);

  // Nudge B away from the shared spawn point so the viewer is not inside B's hull,
  // then bleed the velocity off for a stable close-range shot.
  await thrust(subject.id, { x: 12, y: 0, z: 0 });
  await Bun.sleep(12000);
  for (let i = 0; i < 10; i += 1) {
    await thrust(subject.id, { x: 0, y: 0, z: 0 }, true);
  }

  await aimAt(page, viewer.id, subject.id);
  await shoot(page, "lights-close-off");

  setLights(subject.id, true, true);
  await waitForLights(viewer.id, subject.id, true);
  await Bun.sleep(1200);
  await aimAt(page, viewer.id, subject.id);
  await shoot(page, "lights-close-on");

  // Send B far away: stack impulses (~12 m/s each) and let it coast to ~10 km.
  for (let i = 0; i < 40; i += 1) {
    await thrust(subject.id, { x: 12, y: 0, z: 0 });
  }
  const farRange = await waitForRange(viewer.id, subject.id, 10000);
  for (let i = 0; i < 12; i += 1) {
    await thrust(subject.id, { x: 0, y: 0, z: 0 }, true);
  }
  await aimAt(page, viewer.id, subject.id);
  await Bun.sleep(1500);
  await aimAt(page, viewer.id, subject.id);
  await shoot(page, "lights-far-on");

  setLights(subject.id, false, false);
  await waitForLights(viewer.id, subject.id, false);
  await Bun.sleep(1200);
  await aimAt(page, viewer.id, subject.id);
  await shoot(page, "lights-far-off");

  console.log(
    JSON.stringify(
      {
        lightsVisual: "ok",
        farRangeMeters: Math.round(farRange),
        screenshots: ["close-off", "close-on", "far-on", "far-off"].map(
          (label) => `screenshots/lights-${label}.png`,
        ),
      },
      null,
      2,
    ),
  );
} finally {
  subjectSocket?.close();
  if (browser !== null) {
    await browser.close();
  }
  server.kill();
  client.kill();
  if (existsSync(dbPath)) {
    rmSync(dbPath);
  }
}

async function openSubjectStream(pilotId: string): Promise<WebSocket> {
  const socket = new WebSocket(
    `ws://127.0.0.1:${serverPort}/api/world/stream?pilotId=${encodeURIComponent(pilotId)}`,
  );
  await new Promise<void>((resolvePromise, rejectPromise) => {
    socket.addEventListener("open", () => resolvePromise(), { once: true });
    socket.addEventListener("error", () => rejectPromise(new Error("subject stream failed")), {
      once: true,
    });
  });
  return socket;
}

function setLights(pilotId: string, navLights: boolean, flashlight: boolean): void {
  if (subjectSocket === null) {
    throw new Error("subject stream not open");
  }
  clientTick += 1;
  subjectSocket.send(
    JSON.stringify({
      type: "input",
      pilotId,
      clientTick,
      command: {
        kind: "flight",
        throttle: 0,
        active: false,
        navLights,
        flashlight,
        strafe: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
      },
    }),
  );
}

async function thrust(
  pilotId: string,
  impulse: { x: number; y: number; z: number },
  stabilize = false,
): Promise<void> {
  await api(`/api/ships/${encodeURIComponent(pilotId)}/thrust`, {
    method: "POST",
    body: JSON.stringify(stabilize ? { impulse, stabilize } : { impulse }),
  });
}

async function snapshotFor(pilotId: string): Promise<WorldSnapshot> {
  const query = new URLSearchParams({ pilotId });
  return api<WorldSnapshot>(`/api/world?${query.toString()}`);
}

function shipOf(snapshot: WorldSnapshot, pilotId: string): Ship {
  const ship = snapshot.ships.find((candidate) => candidate.pilotId === pilotId);
  if (ship === undefined) {
    throw new Error(`ship missing for ${pilotId}`);
  }
  return ship;
}

async function aimAt(page: Page, viewerId: string, subjectId: string): Promise<void> {
  const snapshot = await snapshotFor(viewerId);
  const viewerShip = shipOf(snapshot, viewerId);
  const subjectShip = shipOf(snapshot, subjectId);
  const dx = subjectShip.position.x - viewerShip.position.x;
  // The viewer camera sits at the cockpit, 0.12 scene units (120 m) above the ship
  // position — account for it or close-range subjects land below the frame.
  const dy = subjectShip.position.y - (viewerShip.position.y + 120);
  const dz = subjectShip.position.z - viewerShip.position.z;
  const magnitude = Math.hypot(dx, dy, dz) || 1;
  await page.evaluate(
    (dir) =>
      (
        window as unknown as {
          __HAYSTACK_RENDER_DEBUG__?: {
            lookDir: (value: { x: number; y: number; z: number } | null) => void;
          };
        }
      ).__HAYSTACK_RENDER_DEBUG__?.lookDir(dir),
    { x: dx / magnitude, y: dy / magnitude, z: dz / magnitude },
  );
}

async function shoot(page: Page, label: string): Promise<void> {
  await page.screenshot({ path: resolve(shotsDir, `${label}.png`) });
  console.log(`saved screenshots/${label}.png`);
}

async function waitForLights(viewerId: string, subjectId: string, on: boolean): Promise<void> {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const ship = shipOf(await snapshotFor(viewerId), subjectId);
    if (ship.navLightsOn === on && ship.flashlightOn === on) {
      return;
    }
    await Bun.sleep(200);
  }
  throw new Error(`timed out waiting for lights ${on ? "on" : "off"}`);
}

async function waitForRange(viewerId: string, subjectId: string, meters: number): Promise<number> {
  const deadline = Date.now() + 60000;
  for (;;) {
    const snapshot = await snapshotFor(viewerId);
    const viewerShip = shipOf(snapshot, viewerId);
    const subjectShip = shipOf(snapshot, subjectId);
    const range = Math.hypot(
      subjectShip.position.x - viewerShip.position.x,
      subjectShip.position.y - viewerShip.position.y,
      subjectShip.position.z - viewerShip.position.z,
    );
    if (range >= meters) {
      return range;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for range >= ${meters} (at ${Math.round(range)} m)`);
    }
    await Bun.sleep(500);
  }
}

async function waitFor(url: string): Promise<void> {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // retry
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
