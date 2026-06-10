// E2E: third-person view toggle + EVE-style orbit camera in cursor mode.
// Proves (via window.__probe): the C toggle switches first <-> third person, drag orbits
// yaw 360° with clamped pitch, the wheel zooms exponentially between clamps, and none of
// it touches ship orientation, flight input, or flightInputScale. Also proves UI drags
// don't engage the orbit, third-person flight steering still flies the ship, and the
// view mode + orbit distance persist across a reload.
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

import type { Pilot } from "../../src/shared/types";
import { assert, captureTraffic, count, pollUntil, webgpuLaunchOptions } from "./helpers";

const serverPort = 8807;
const clientPort = 5207;
const dbPath = resolve(tmpdir(), `haystack-camera-${Date.now()}.sqlite`);
const serverUrl = `http://127.0.0.1:${serverPort}`;
const clientUrl = `http://127.0.0.1:${clientPort}`;

// Mirrors cameraStore clamps (import avoided: this file runs under bun, the store is fine
// there too, but pinning the numbers also guards accidental clamp changes).
const minOrbitDistance = 0.18;
const maxOrbitDistance = 16;
const maxOrbitPitchRad = (80 * Math.PI) / 180;

// A stage point covered by no default window (scanner/cargo/comms/character/bases all
// sit left/top; 1500,250 is bare canvas on a 1920x1080 viewport).
const stageX = 1500;
const stageY = 250;

type Probe = {
  owned: { x: number; y: number; z: number };
  ownedQuat: { x: number; y: number; z: number; w: number };
  viewMode: "first" | "third";
  flightMode: "cursor" | "flight";
  camera: {
    position: { x: number; y: number; z: number };
    quaternion: { x: number; y: number; z: number; w: number };
  };
  orbit: { yawRad: number; pitchRad: number; distance: number };
};

const server = Bun.spawn(["bun", "src/server/main.ts"], {
  env: { ...process.env, PORT: String(serverPort), HAYSTACK_DB: dbPath },
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

  const pilot = (
    await api<{ pilot: Pilot }>("/api/pilots", {
      method: "POST",
      body: JSON.stringify({ callsign: `Camera-Probe-${Date.now()}`, organization: "Camera QA" }),
    })
  ).pilot;

  browser = await chromium.launch(webgpuLaunchOptions);
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();
  const traffic = captureTraffic(page);
  const url = new URL(clientUrl);
  url.searchParams.set("pilotId", pilot.id);
  await page.goto(url.toString(), { waitUntil: "networkidle" });
  await page.waitForSelector("[data-testid='haystack-app']", { timeout: 15000 });
  await pollUntil(
    () => probe(page),
    (value) => value !== null,
    15000,
  );

  await verifyViewToggle(page);
  await verifyOrbitDrag(page, traffic);
  await verifyWheelZoom(page);
  await verifyUiDoesNotOrbit(page);
  await verifyThirdPersonFlight(page);
  await verifyPersistenceAcrossReload(context, page, pilot.id);

  console.log(JSON.stringify({ appUrl: clientUrl, pilotId: pilot.id, camera: "ok" }, null, 2));
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

async function verifyViewToggle(page: Page): Promise<void> {
  const initial = await probe(page);
  assert(initial !== null && initial.viewMode === "first", "boots in first person");
  assert((await count(page, "[data-testid='hud-reticle']")) === 1, "reticle visible in first");
  assert(
    (await count(page, "[data-testid='hud-keybind-camera']")) === 1,
    "camera keybind hint present",
  );
  assert(
    (await count(page, "[data-testid='hud-keybind-orbit']")) === 0,
    "orbit hint hidden in first person",
  );
  const cockpitDistance = Math.hypot(
    initial.camera.position.x,
    initial.camera.position.y,
    initial.camera.position.z,
  );
  assert(cockpitDistance < 0.2, `first-person camera sits at the cockpit (${cockpitDistance})`);

  await page.keyboard.press("c");
  const third = await pollUntil(
    () => probe(page),
    (value) => value !== null && value.viewMode === "third",
  );
  assert(third !== null, "C switches to third person");
  // Wait out the eased transition: camera ends up at the orbit distance from the ship.
  await pollUntil(
    () => probe(page),
    (value) => {
      if (value === null) {
        return false;
      }
      const distance = Math.hypot(
        value.camera.position.x,
        value.camera.position.y,
        value.camera.position.z,
      );
      return Math.abs(distance - value.orbit.distance) < 0.05;
    },
  );
  assert((await count(page, "[data-testid='hud-reticle']")) === 0, "reticle hidden in third");
  assert(
    (await count(page, "[data-testid='hud-keybind-orbit']")) === 1,
    "orbit hint shown in third + cursor",
  );
}

async function verifyOrbitDrag(
  page: Page,
  traffic: ReturnType<typeof captureTraffic>,
): Promise<void> {
  const before = await probe(page);
  assert(before !== null, "probe before orbit drag");
  const framesBefore = traffic.inputFrames().length;

  // Horizontal drag: > 2π worth of pixels proves full 360° yaw travel with wrapping.
  // y=760 is bare canvas across the viewport (windows end by y≈688, HUD sits at the
  // bottom edge), so the pointer-down lands on the stage and engages the orbit.
  await page.mouse.move(300, 760);
  await page.mouse.down();
  await page.mouse.move(1860, 760, { steps: 24 });
  await page.mouse.up();
  const afterYaw = await probe(page);
  assert(afterYaw !== null, "probe after yaw drag");
  assert(afterYaw.orbit.yawRad !== before.orbit.yawRad, "drag changed orbit yaw");
  assert(
    Math.abs(afterYaw.orbit.yawRad) <= Math.PI + 1e-6,
    `yaw wraps within [-pi, pi] after a 360°+ drag (${afterYaw.orbit.yawRad})`,
  );

  // Vertical drag far past the pole: pitch must clamp short of it.
  await page.mouse.move(stageX, 120);
  await page.mouse.down();
  await page.mouse.move(stageX, 1020, { steps: 24 });
  await page.mouse.up();
  const afterPitch = await probe(page);
  assert(afterPitch !== null, "probe after pitch drag");
  assert(
    Math.abs(Math.abs(afterPitch.orbit.pitchRad) - maxOrbitPitchRad) < 1e-6,
    `pitch clamps at the pole guard (${afterPitch.orbit.pitchRad})`,
  );

  // Decoupling: ship orientation untouched, and no flight input was emitted by orbiting.
  assertQuatEqual(before.ownedQuat, afterPitch.ownedQuat, "ship orientation while orbiting");
  const framesAfter = traffic.inputFrames().length;
  assert(
    framesAfter === framesBefore,
    `orbiting emitted no FlightInputCommand (${framesBefore} -> ${framesAfter})`,
  );
}

async function verifyWheelZoom(page: Page): Promise<void> {
  const before = await probe(page);
  assert(before !== null, "probe before zoom");
  const scaleBefore = await flightInputScaleAttr(page);

  await page.mouse.move(stageX, stageY);
  // One full divisor of wheel travel = exactly half the distance (2^-1), unless clamped.
  await page.mouse.wheel(0, -480);
  const zoomedIn = await probe(page);
  assert(zoomedIn !== null, "probe after zoom in");
  const expected = Math.max(before.orbit.distance / 2, minOrbitDistance);
  assert(
    Math.abs(zoomedIn.orbit.distance - expected) < 1e-6,
    `wheel zoom is exponential (${before.orbit.distance} -> ${zoomedIn.orbit.distance}, expected ${expected})`,
  );

  // Pile on zoom-out: clamps at the max, far inside the render distance.
  for (let i = 0; i < 12; i += 1) {
    await page.mouse.wheel(0, 480);
  }
  const zoomedOut = await pollUntil(
    () => probe(page),
    (value) => value !== null && value.orbit.distance === maxOrbitDistance,
  );
  assert(zoomedOut !== null, "wheel zoom clamps at max distance");

  // Zoom never bleeds into flightInputScale or ship state.
  assert(
    (await flightInputScaleAttr(page)) === scaleBefore,
    "flightInputScale untouched by orbit zoom",
  );
  assertQuatEqual(before.ownedQuat, zoomedOut.ownedQuat, "ship orientation while zooming");

  // Settle back to a mid distance for the remaining checks.
  for (let i = 0; i < 6; i += 1) {
    await page.mouse.wheel(0, -480);
  }
  await pollUntil(
    () => probe(page),
    (value) => value !== null && value.orbit.distance < 1,
  );
}

async function verifyUiDoesNotOrbit(page: Page): Promise<void> {
  const before = await probe(page);
  assert(before !== null, "probe before UI drag");
  // Drag the scanner window by its titlebar: the window must move (UI drags keep
  // working) and the orbit must not budge.
  const titlebar = page.getByTestId("window-scanner-titlebar");
  const box = await titlebar.boundingBox();
  assert(box !== null, "scanner titlebar visible");
  await page.mouse.move(box.x + 40, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + 140, box.y + 90, { steps: 6 });
  await page.mouse.up();
  const after = await probe(page);
  assert(after !== null, "probe after UI drag");
  assert(after.orbit.yawRad === before.orbit.yawRad, "UI drag does not orbit yaw");
  assert(after.orbit.pitchRad === before.orbit.pitchRad, "UI drag does not orbit pitch");
  const movedBox = await titlebar.boundingBox();
  assert(
    movedBox !== null && Math.abs(movedBox.x - box.x) > 50,
    "window drag still works in third person",
  );
}

async function verifyThirdPersonFlight(page: Page): Promise<void> {
  const before = await probe(page);
  assert(before !== null && before.viewMode === "third", "still third person");

  await page.getByTestId("flight-mode-toggle").click();
  await pollUntil(
    () => probe(page),
    (value) => value !== null && value.flightMode === "flight",
  );
  // Chase pose: camera settles at the orbit distance from the ship (behind/above it).
  await pollUntil(
    () => probe(page),
    (value) => {
      if (value === null) {
        return false;
      }
      const distance = Math.hypot(
        value.camera.position.x,
        value.camera.position.y,
        value.camera.position.z,
      );
      return Math.abs(distance - value.orbit.distance) < 0.05;
    },
  );

  // Unlock with the ship stationary: no camera snap. Unlocking seeds the orbit from
  // the chase pose at the same distance, so the camera position should stay put
  // through the whole eased blend — sample continuously and require it never to jump.
  const preUnlock = await probe(page);
  assert(preUnlock !== null, "probe before unlock");
  await page.keyboard.press("AltLeft");
  await pollUntil(
    () => probe(page),
    (value) => value !== null && value.flightMode === "cursor",
    20000,
  );
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    const sample = await probe(page);
    assert(sample !== null, "probe while blending after unlock");
    const drift = Math.hypot(
      sample.camera.position.x - preUnlock.camera.position.x,
      sample.camera.position.y - preUnlock.camera.position.y,
      sample.camera.position.z - preUnlock.camera.position.z,
    );
    assert(
      drift < 0.15 * preUnlock.orbit.distance,
      `camera stays continuous after unlock (drift ${drift})`,
    );
    await Bun.sleep(100);
  }

  // Re-lock and prove steering still flies the ship in third person (roll on Q avoids
  // relying on synthetic pointer-lock mouse deltas under headless).
  await page.getByTestId("flight-mode-toggle").click();
  await pollUntil(
    () => probe(page),
    (value) => value !== null && value.flightMode === "flight",
    20000,
  );
  await page.keyboard.down("q");
  await pollUntil(
    () => probe(page),
    (value) => value !== null && quatDelta(value.ownedQuat, before.ownedQuat) > 0.01,
    20000,
  );
  await page.keyboard.up("q");
  await page.keyboard.press("AltLeft");
  await pollUntil(
    () => probe(page),
    (value) => value !== null && value.flightMode === "cursor",
    20000,
  );
}

async function verifyPersistenceAcrossReload(
  context: BrowserContext,
  oldPage: Page,
  pilotId: string,
): Promise<void> {
  const before = await probe(oldPage);
  assert(before !== null, "probe before reload");
  // A fresh page in the same context (same localStorage origin) — reloading the live
  // WebGPU page in place is crash-prone under headless SwiftShader.
  await oldPage.close();
  const page = await context.newPage();
  const url = new URL(clientUrl);
  url.searchParams.set("pilotId", pilotId);
  await page.goto(url.toString(), { waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-testid='haystack-app']", { timeout: 30000 });
  const after = await pollUntil(
    () => probe(page),
    (value) => value !== null,
    15000,
  );
  assert(after !== null && after.viewMode === "third", "view mode persists across reload");
  assert(
    Math.abs(after.orbit.distance - before.orbit.distance) < 1e-6,
    `orbit distance persists across reload (${before.orbit.distance} -> ${after.orbit.distance})`,
  );

  // And back to first person: reticle returns, camera returns to the cockpit.
  await page.keyboard.press("c");
  await pollUntil(
    () => probe(page),
    (value) => value !== null && value.viewMode === "first",
  );
  await pollUntil(
    () => probe(page),
    (value) =>
      value !== null &&
      Math.hypot(value.camera.position.x, value.camera.position.y, value.camera.position.z) < 0.2,
  );
  assert((await count(page, "[data-testid='hud-reticle']")) === 1, "reticle back in first person");
}

async function probe(page: Page): Promise<Probe | null> {
  return page.evaluate(() => {
    const candidate = (window as unknown as { __probe?: unknown }).__probe;
    return candidate === undefined ? null : (candidate as Probe);
  });
}

async function flightInputScaleAttr(page: Page): Promise<string | null> {
  return page.evaluate(
    () =>
      document
        .querySelector("[data-testid='haystack-app']")
        ?.getAttribute("data-flight-input-scale") ?? null,
  );
}

function quatDelta(
  a: { x: number; y: number; z: number; w: number },
  b: { x: number; y: number; z: number; w: number },
): number {
  return Math.max(
    Math.abs(a.x - b.x),
    Math.abs(a.y - b.y),
    Math.abs(a.z - b.z),
    Math.abs(a.w - b.w),
  );
}

function assertQuatEqual(
  a: { x: number; y: number; z: number; w: number },
  b: { x: number; y: number; z: number; w: number },
  label: string,
): void {
  assert(quatDelta(a, b) < 1e-6, `${label} unchanged (delta ${quatDelta(a, b)})`);
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
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
  if (!response.ok) {
    throw new Error(`${path} failed: ${response.status}`);
  }
  return (await response.json()) as T;
}
