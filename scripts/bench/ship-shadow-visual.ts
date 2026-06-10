// Visual + numeric proof that remote ships are sun-lit and react to asteroid shadows.
//
// Boots the real server + vite client, opens ONE real-Chrome viewer (pilot A), and
// autopilots a second pilot (B, driven over the wire via REST thrust) to two spots near
// a large derived rock:
//   1. the SUNLIT side  (rock.center + sunDir * (R + standoff))
//   2. inside the rock's SHADOW cone (rock.center - sunDir * (R + standoff))
// both laterally offset toward the viewer so the line of sight clears the rock. The
// viewer camera is aimed at B (render debug lookDir) and a center crop of each
// screenshot is luminance-measured: the sunlit hull must be clearly brighter than the
// shadowed hull (same overlays in both shots, so the delta isolates the lighting).
//
// Outputs screenshots/ship-shadow-sunlit.png, screenshots/ship-shadow-shaded.png and a
// JSON summary with the two mean-luminance numbers.
//
// Usage: bun scripts/bench/ship-shadow-visual.ts   (CHROME_PATH overrides detection)

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { chromium, type Browser, type Page } from "playwright";
import { PNG } from "pngjs";

import type { Pilot, Ship, Vector3, WorldSnapshot } from "../../src/shared/types";
import { SHIP_COLLISION_RADIUS } from "../../src/shared/collision";
import { deriveVirtualField } from "../../src/client/eve/field-core";
import { sunDirection } from "../../src/client/eve/lighting";

const serverPort = 8819;
const clientPort = 5219;
const dbPath = resolve(tmpdir(), `haystack-ship-shadow-${Date.now()}.sqlite`);
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

try {
  await waitFor(`${serverUrl}/api/health`);
  await waitFor(clientUrl);

  const viewer = (
    await api<{ pilot: Pilot }>("/api/pilots", {
      method: "POST",
      body: JSON.stringify({ callsign: `Shadow-Viewer-${Date.now() % 1e6}` }),
    })
  ).pilot;
  const subject = (
    await api<{ pilot: Pilot }>("/api/pilots", {
      method: "POST",
      body: JSON.stringify({ callsign: `Shadow-Subject-${Date.now() % 1e6}` }),
    })
  ).pilot;

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
  await page.evaluate(() => {
    for (const button of document.querySelectorAll<HTMLButtonElement>("[data-testid$='-close']")) {
      button.click();
    }
  });
  await Bun.sleep(3000);

  const viewerShip = await shipOf(viewer.id);

  // Pick a large rock near the spawn: big radius => a deep, wide shadow cone that the
  // autopilot's ±40 m positioning error cannot fall out of.
  const field = {
    totalAsteroids: 1_000_000,
    seed: 424242,
    cellSize: 1130,
    indexKind: "cubicCellHierarchy" as const,
    renderedLimit: 200,
  };
  const rock = deriveVirtualField(viewerShip.position, field)
    .filter((candidate) => candidate.radius >= 220)
    .sort(
      (left, right) =>
        vectorDistance(viewerShip.position, left.position) -
        vectorDistance(viewerShip.position, right.position),
    )[0];
  if (rock === undefined) {
    throw new Error("No large derived rock near spawn.");
  }

  // Lateral direction (perpendicular to the sun axis, toward the viewer) so the camera
  // line of sight clears the rock at both spots.
  const toViewer = subtract(viewerShip.position, rock.position);
  const lateral = normalize(rejectAlong(toViewer, sunDirection));
  const standoff = rock.radius + 170;

  // The field is dense enough that a random spot near spawn often sits in SOME rock's
  // shadow — the sunlit spot must have a verified-clear ray to the sun through every
  // rendered rock (base position ± the ≤70 m cosmetic wobble).
  const allRocks = deriveVirtualField(viewerShip.position, {
    ...field,
    renderedLimit: 2000,
  });
  let sunlitSpot: Vector3 | null = null;
  for (let attempt = 0; attempt < 24 && sunlitSpot === null; attempt += 1) {
    const along = standoff + attempt * 120;
    const candidate = add(
      add(rock.position, scale(sunDirection, along)),
      scale(lateral, rock.radius * 0.35 + attempt * 40),
    );
    if (!sunRayBlocked(candidate, allRocks)) {
      sunlitSpot = candidate;
    }
  }
  if (sunlitSpot === null) {
    throw new Error("Could not find a spot with a clear ray to the sun near the rock.");
  }
  // Shadow spot: anti-sun side, lateral offset well inside the shadow cylinder even
  // under the rendered rock's ±70 m wobble (lateral 0.35 R + ship 50 m << R - 70 m).
  const shadedSpot = add(
    add(rock.position, scale(sunDirection, -standoff)),
    scale(lateral, rock.radius * 0.35),
  );

  // The viewer flies too: a ~260 m vantage perpendicular to the sun axis at each spot,
  // so the hull fills enough pixels for the luminance comparison to mean something.
  const sunlitShot = resolve(shotsDir, "ship-shadow-sunlit.png");
  await flyTo(subject.id, sunlitSpot, rock);
  await flyTo(viewer.id, add(sunlitSpot, scale(lateral, 260)), rock);
  await aimAt(page, viewer.id, subject.id);
  await Bun.sleep(1500);
  await aimAt(page, viewer.id, subject.id);
  await page.screenshot({ path: sunlitShot });

  const shadedShot = resolve(shotsDir, "ship-shadow-shaded.png");
  await flyTo(subject.id, shadedSpot, rock);
  await flyTo(viewer.id, add(shadedSpot, scale(lateral, 260)), rock);
  await aimAt(page, viewer.id, subject.id);
  await Bun.sleep(1500);
  await aimAt(page, viewer.id, subject.id);
  await page.screenshot({ path: shadedShot });

  const sunlitLuma = centerLuminance(sunlitShot);
  const shadedLuma = centerLuminance(shadedShot);

  console.log(
    JSON.stringify(
      {
        shipShadow: sunlitLuma > shadedLuma * 1.5 ? "ok" : "WEAK-CONTRAST",
        rock: { id: rock.id, radius: Number(rock.radius.toFixed(1)) },
        sunlitMeanLuma: Number(sunlitLuma.toFixed(2)),
        shadedMeanLuma: Number(shadedLuma.toFixed(2)),
        screenshots: ["screenshots/ship-shadow-sunlit.png", "screenshots/ship-shadow-shaded.png"],
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

// Mean luminance of the central 360x360 actual-pixel crop (the camera is aimed at the
// subject, so the hull dominates the center; overlays are identical between shots).
function centerLuminance(path: string): number {
  const png = PNG.sync.read(readFileSync(path));
  const size = 280;
  const x0 = Math.floor(png.width / 2 - size / 2);
  const y0 = Math.floor(png.height / 2 - size / 2);
  let total = 0;
  for (let y = y0; y < y0 + size; y += 1) {
    for (let x = x0; x < x0 + size; x += 1) {
      const index = (y * png.width + x) * 4;
      total +=
        0.2126 * png.data[index]! + 0.7152 * png.data[index + 1]! + 0.0722 * png.data[index + 2]!;
    }
  }
  return total / (size * size);
}

// Minimal REST-thrust autopilot: route around the rock when the direct segment grazes
// it, fly legs at a modest speed, then bleed velocity at the target.
async function flyTo(
  pilotId: string,
  target: Vector3,
  rock: { position: Vector3; radius: number },
): Promise<void> {
  const deadline = Date.now() + 180000;
  for (;;) {
    if (Date.now() > deadline) {
      throw new Error("flyTo timed out");
    }
    const ship = await shipOf(pilotId);
    const remaining = vectorDistance(ship.position, target);
    if (remaining < 40) {
      for (let i = 0; i < 10; i += 1) {
        await thrust(pilotId, { x: 0, y: 0, z: 0 }, true);
      }
      const settled = await shipOf(pilotId);
      if (vectorDistance(settled.position, target) < 60) {
        return;
      }
      continue;
    }

    // Waypoint: if the direct segment passes through the rock's collision sphere,
    // steer for a point pushed out beside the rock first.
    let leg = target;
    const blocked = segmentNearSphere(
      ship.position,
      target,
      rock.position,
      rock.radius + SHIP_COLLISION_RADIUS + 80,
    );
    if (blocked !== null && vectorDistance(ship.position, target) > 120) {
      const out = normalize(subtract(blocked, rock.position));
      leg = add(rock.position, scale(out, rock.radius + SHIP_COLLISION_RADIUS + 220));
    }

    const direction = normalize(subtract(leg, ship.position));
    const speed = Math.max(25, Math.min(140, remaining / 3));
    const desired = scale(direction, speed);
    const dv = subtract(desired, ship.velocity);
    const dvMagnitude = Math.hypot(dv.x, dv.y, dv.z);
    if (dvMagnitude > 3) {
      const steps = Math.min(4, Math.ceil(dvMagnitude / 12));
      const per = Math.min(12, dvMagnitude / steps);
      const unit = scale(dv, 1 / dvMagnitude);
      for (let i = 0; i < steps; i += 1) {
        await thrust(pilotId, scale(unit, per));
      }
    }
    await Bun.sleep(400);
  }
}

// True when the ray from `point` toward the sun passes within (radius + wobble + ship)
// of any rendered rock — i.e. the point sits in some rock's (possibly wobbling) shadow.
function sunRayBlocked(
  point: Vector3,
  rocks: ReadonlyArray<{ position: Vector3; radius: number }>,
): boolean {
  const margin = 70 + SHIP_COLLISION_RADIUS + 30;
  for (const rock of rocks) {
    const toRock = subtract(rock.position, point);
    const along = toRock.x * sunDirection.x + toRock.y * sunDirection.y + toRock.z * sunDirection.z;
    if (along <= 0 || along > 24000) {
      continue;
    }
    const lateralOffset = subtract(toRock, scale(sunDirection, along));
    if (Math.hypot(lateralOffset.x, lateralOffset.y, lateralOffset.z) < rock.radius + margin) {
      return true;
    }
  }
  return false;
}

// Closest point of segment [a,b] to the sphere center if the segment passes within
// `radius`, else null.
function segmentNearSphere(
  a: Vector3,
  b: Vector3,
  center: Vector3,
  radius: number,
): Vector3 | null {
  const ab = subtract(b, a);
  const lengthSquared = ab.x * ab.x + ab.y * ab.y + ab.z * ab.z;
  if (lengthSquared <= 1e-9) {
    return null;
  }
  const ac = subtract(center, a);
  const t = Math.max(0, Math.min(1, (ac.x * ab.x + ac.y * ab.y + ac.z * ab.z) / lengthSquared));
  const closest = add(a, scale(ab, t));
  if (vectorDistance(closest, center) >= radius) {
    return null;
  }
  return closest;
}

async function aimAt(page: Page, viewerId: string, subjectId: string): Promise<void> {
  const snapshot = await snapshotFor(viewerId);
  const viewerShip = requireShip(snapshot, viewerId);
  const subjectShip = requireShip(snapshot, subjectId);
  const dx = subjectShip.position.x - viewerShip.position.x;
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

async function thrust(pilotId: string, impulse: Vector3, stabilize = false): Promise<void> {
  await api(`/api/ships/${encodeURIComponent(pilotId)}/thrust`, {
    method: "POST",
    body: JSON.stringify(stabilize ? { impulse, stabilize } : { impulse }),
  });
}

async function snapshotFor(pilotId: string): Promise<WorldSnapshot> {
  const query = new URLSearchParams({ pilotId });
  return api<WorldSnapshot>(`/api/world?${query.toString()}`);
}

function requireShip(snapshot: WorldSnapshot, pilotId: string): Ship {
  const ship = snapshot.ships.find((candidate) => candidate.pilotId === pilotId);
  if (ship === undefined) {
    throw new Error(`ship missing for ${pilotId}`);
  }
  return ship;
}

async function shipOf(pilotId: string): Promise<Ship> {
  return requireShip(await snapshotFor(pilotId), pilotId);
}

function subtract(a: Vector3, b: Vector3): Vector3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function add(a: Vector3, b: Vector3): Vector3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function scale(v: Vector3, s: number): Vector3 {
  return { x: v.x * s, y: v.y * s, z: v.z * s };
}

function normalize(v: Vector3): Vector3 {
  const magnitude = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / magnitude, y: v.y / magnitude, z: v.z / magnitude };
}

// Component of v perpendicular to axis (axis must be unit length).
function rejectAlong(v: Vector3, axis: Vector3): Vector3 {
  const along = v.x * axis.x + v.y * axis.y + v.z * axis.z;
  return subtract(v, scale(axis, along));
}

function vectorDistance(a: Vector3, b: Vector3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
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
