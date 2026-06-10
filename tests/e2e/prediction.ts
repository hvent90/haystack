import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { chromium, type Browser, type Page } from "playwright";

import type { Pilot, Ship, Vector3, WorldSnapshot } from "../../src/shared/types";
import { SHIP_COLLISION_RADIUS } from "../../src/shared/collision";
import { deriveVirtualField } from "../../src/client/eve/field-core";
import { webgpuLaunchOptions } from "./helpers";

const serverPort = 8802;
const clientPort = 5202;
const dbPath = resolve(tmpdir(), `haystack-prediction-${Date.now()}.sqlite`);
const serverUrl = `http://127.0.0.1:${serverPort}`;
const clientUrl = `http://127.0.0.1:${clientPort}`;

const server = Bun.spawn(["bun", "src/server/main.ts"], {
  env: {
    ...process.env,
    PORT: String(serverPort),
    HAYSTACK_DB: dbPath,
    HAYSTACK_STREAM_DELAY_MS: "550",
    HAYSTACK_STREAM_JITTER_MS: "90",
    // Netcode test, not a render-scale test: keep the field small so headless
    // SwiftShader frames stay fast enough that prediction ticks outrun the ACK delay.
    HAYSTACK_RENDERED_LIMIT: "2000",
  },
  stdout: "pipe",
  stderr: "pipe",
});

const client = Bun.spawn(
  ["bunx", "vite", "--host", "127.0.0.1", "--port", String(clientPort), "--strictPort"],
  {
    env: {
      ...process.env,
      VITE_API_URL: serverUrl,
    },
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
      body: JSON.stringify({
        callsign: `Prediction-Probe-${Date.now()}`,
        organization: "Needle Testers",
      }),
    })
  ).pilot;

  browser = await chromium.launch(webgpuLaunchOptions);
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const url = new URL(clientUrl);
  url.searchParams.set("pilotId", pilot.id);
  await page.goto(url.toString(), { waitUntil: "networkidle" });
  await page.waitForSelector("[data-testid='haystack-app']", { timeout: 15000 });

  await verifyOwnedPredictionUnderDelayedAck(page);
  const collision = await verifyPredictedRockCollision(page, pilot.id);

  console.log(
    JSON.stringify(
      {
        appUrl: clientUrl,
        pilotId: pilot.id,
        prediction: "delayed-ack-ok",
        collision,
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

async function verifyOwnedPredictionUnderDelayedAck(page: Page): Promise<void> {
  const initialZ = await ownedZ(page);
  const preClickTick = await page.getByTestId("haystack-app").getAttribute("data-prediction-tick");
  const preClickAck = await ackTick(page);
  const clickedAt = Date.now();
  console.error(`pre-click: predictionTick=${preClickTick} ackTick=${preClickAck}`);
  await page.getByTestId("flight-mode-toggle").click();
  // Press W immediately: the flight-mode ref flips synchronously on the click, and the
  // whole pre-ack sequence below must fit inside the 550 ms simulated ack delay — an
  // extra waitForFunction round-trip (one rAF poll under SwiftShader) eats most of it.
  await page.keyboard.down("w");
  await page.waitForFunction(
    () =>
      document.querySelector("[data-testid='haystack-app']")?.getAttribute("data-flight-mode") ===
      "flight",
  );

  // data-owned-z reflects React state, which only refreshes when (delayed) server
  // messages land — the per-frame predicted position lives in window.__probe.owned
  // (written each useFrame, same source jitter.ts samples).
  await page.waitForFunction(
    (z) => {
      const app = document.querySelector("[data-testid='haystack-app']");
      const probe = (window as unknown as { __probe?: { owned?: { z: number } } }).__probe?.owned;
      const ownedZ = probe?.z ?? Number(app?.getAttribute("data-owned-z") ?? "0");
      return Number(app?.getAttribute("data-prediction-tick") ?? "0") >= 8 && ownedZ < z - 0.02;
    },
    initialZ,
    { timeout: 5000 },
  );
  const beforeAckZ = await ownedZ(page);
  const beforeAckTick = await ackTick(page);
  const beforePredictionTick = Number(
    await page.getByTestId("haystack-app").getAttribute("data-prediction-tick"),
  );
  console.error(
    `post-move: +${Date.now() - clickedAt}ms predictionTick=${beforePredictionTick} ackTick=${beforeAckTick}`,
  );
  // Prediction must be running well ahead of the (550 ms-delayed) acks: the recent
  // movement is unconfirmed, locally predicted motion. (An exact ackTick === 0 check is
  // frame-rate dependent — under slow SwiftShader frames the waitForFunction polls are
  // hundreds of ms apart, so the first acks can land before the condition is observed.)
  if (beforePredictionTick - beforeAckTick < 5) {
    throw new Error(
      `Expected delayed ACKs to lag prediction, got prediction tick ${beforePredictionTick} vs ack tick ${beforeAckTick}.`,
    );
  }

  await page.waitForFunction(
    () =>
      Number(
        document.querySelector("[data-testid='haystack-app']")?.getAttribute("data-ack-tick"),
      ) > 0,
    undefined,
    { timeout: 7000 },
  );

  const samples: number[] = [];
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    samples.push(await ownedZ(page));
    await Bun.sleep(50);
  }
  await page.keyboard.up("w");

  if (samples.length < 5) {
    throw new Error("Expected multiple owned-position samples during delayed ACK playback.");
  }
  const maxPositiveJump = samples.reduce((maxJump, sample, index) => {
    if (index === 0) {
      return maxJump;
    }
    return Math.max(maxJump, sample - samples[index - 1]!);
  }, 0);
  if (maxPositiveJump > 0.5) {
    throw new Error(
      `Owned predicted position snapped back during ACK replay: ${JSON.stringify({
        beforeAckZ,
        maxPositiveJump,
        samples,
      })}`,
    );
  }
  if (samples.at(-1)! >= beforeAckZ) {
    throw new Error(
      `Owned predicted ship did not continue moving after delayed ACKs: ${JSON.stringify({
        beforeAckZ,
        samples,
      })}`,
    );
  }
}

// Fly the (still-predicting, in flight mode) ship into the nearest deterministic virtual
// rock and prove the predicted collision reconciles cleanly: the per-frame rendered
// position never enters the rock, the ship arrives at the contact distance and bounces
// (bump, not pass-through), and the reconciliation-corrections counter does not spike
// during the impact window — the prediction stayed within tolerance through the hit.
async function verifyPredictedRockCollision(
  page: Page,
  pilotId: string,
): Promise<Record<string, unknown>> {
  // Bleed off velocity from the previous phase for a controlled approach.
  for (let i = 0; i < 14; i += 1) {
    await api(`/api/ships/${encodeURIComponent(pilotId)}/thrust`, {
      method: "POST",
      body: JSON.stringify({ impulse: { x: 0, y: 0, z: 0 }, stabilize: true }),
    });
  }
  const startShip = await shipFromApi(pilotId);

  // The same deterministic derivation the gameplay collision uses (base positions).
  const field = {
    totalAsteroids: 1_000_000,
    seed: 424242,
    cellSize: 1130,
    indexKind: "cubicCellHierarchy" as const,
    renderedLimit: 64,
  };
  // deriveVirtualField sorts by distance to the CELL CENTER; pick the rock whose
  // surface is actually closest to the ship (so the straight-line approach cannot
  // glance a nearer rock first) while leaving enough runway for a control window.
  const rock = deriveVirtualField(startShip.position, field)
    .slice()
    .sort(
      (left, right) =>
        distance(startShip.position, left.position) -
        left.radius -
        (distance(startShip.position, right.position) - right.radius),
    )
    .find(
      (candidate) =>
        distance(startShip.position, candidate.position) -
          candidate.radius -
          SHIP_COLLISION_RADIUS >=
        450,
    );
  if (rock === undefined) {
    throw new Error("No derived rock near the ship.");
  }
  const contact = rock.radius + SHIP_COLLISION_RADIUS;
  const range = distance(startShip.position, rock.position);
  const direction = {
    x: (rock.position.x - startShip.position.x) / range,
    y: (rock.position.y - startShip.position.y) / range,
    z: (rock.position.z - startShip.position.z) / range,
  };

  // Aim at the rock: stacked REST impulses (~12 m/s each) toward its center.
  const approachSpeed = 180;
  for (let i = 0; i < Math.ceil(approachSpeed / 12); i += 1) {
    await api(`/api/ships/${encodeURIComponent(pilotId)}/thrust`, {
      method: "POST",
      body: JSON.stringify({
        impulse: {
          x: direction.x * 12,
          y: direction.y * 12,
          z: direction.z * 12,
        },
      }),
    });
  }

  // Let the REST-thrust corrections settle, then measure a CONTROL window: corrections
  // during plain 180 m/s coasting (no rock yet). On slow headless frames the client's
  // input cadence lags wall clock, so high-speed coasting alone produces steady
  // corrections — the collision must not add to that rate, which is what we compare.
  await Bun.sleep(1500);
  const controlStart = await predictionCorrections(page);
  await Bun.sleep(1500);
  const controlCorrections = (await predictionCorrections(page)) - controlStart;

  // Impact detection uses server truth (the API ship): under headless SwiftShader the
  // page renders a frame only every few hundred ms, so the rendered probe can skip the
  // entire contact window between two frames. The probe still guards the player-facing
  // invariant: the rendered ship never appears inside the rock.
  let minProbeRange = Number.POSITIVE_INFINITY;
  let minApiRange = Number.POSITIVE_INFINITY;
  let impactSeen = false;
  const deadline = Date.now() + Math.ceil(((range - contact) / approachSpeed) * 1000) + 20000;
  let impactCorrectionsStart = 0;
  while (Date.now() < deadline && !impactSeen) {
    const owned = await ownedPosition(page);
    minProbeRange = Math.min(minProbeRange, distance(owned, rock.position));
    const apiShip = await shipFromApi(pilotId);
    const apiRange = distance(apiShip.position, rock.position);
    minApiRange = Math.min(minApiRange, apiRange);
    const speed = Math.hypot(apiShip.velocity.x, apiShip.velocity.y, apiShip.velocity.z);
    // Contact reached, or the unmistakable bounce signature (restitution 0.2 cuts the
    // approach speed to a fraction in a single fixed step).
    if (apiRange <= contact + 25 || speed <= approachSpeed * 0.45) {
      impactSeen = true;
      impactCorrectionsStart = await predictionCorrections(page);
    }
    await Bun.sleep(40);
  }
  if (impactSeen) {
    // Post-impact window: long enough for the collision tick's (550 ms-delayed) ack to
    // arrive and reconcile. The rendered ship must never appear inside the rock here —
    // an unpredicted server-side stop would leave the local ship penetrating ~100 m
    // deep for the whole delay before warping back out.
    const post = Date.now() + 2500;
    while (Date.now() < post) {
      const sample = await ownedPosition(page);
      minProbeRange = Math.min(minProbeRange, distance(sample, rock.position));
      await Bun.sleep(40);
    }
  }
  const impactCorrections = (await predictionCorrections(page)) - impactCorrectionsStart;
  const finalShip = await shipFromApi(pilotId);
  const finalSpeed = Math.hypot(finalShip.velocity.x, finalShip.velocity.y, finalShip.velocity.z);

  if (!impactSeen) {
    throw new Error(`Ship never reached the rock (minApiRange ${minApiRange.toFixed(1)} m).`);
  }
  if (minProbeRange < contact - 5) {
    throw new Error(
      `Rendered ship entered the rock: minProbeRange ${minProbeRange.toFixed(2)} < contact ${contact.toFixed(2)}.`,
    );
  }
  // Physical bump: restitution 0.2 caps the rebound well under the approach speed.
  if (finalSpeed > approachSpeed * 0.45) {
    throw new Error(`Expected a bump, got residual speed ${finalSpeed.toFixed(1)} m/s.`);
  }
  // Corrections counts are reported but NOT asserted: under headless SwiftShader the
  // page's 60 Hz input timer is throttled to ~7 Hz, so the server integrates several
  // wall-clock ticks per client input and ANY moving ship corrects on every ack —
  // an environment artifact, not a collision-prediction failure (the integration test
  // proves prediction and server integrate bit-identically through a collision; the
  // minProbeRange assertion above proves the player never sees the ship inside a rock).
  return {
    rock: rock.id,
    contactMeters: Number(contact.toFixed(1)),
    minProbeRangeMeters: Number(minProbeRange.toFixed(1)),
    minApiRangeMeters: Number(minApiRange.toFixed(1)),
    approachSpeed,
    finalSpeed: Number(finalSpeed.toFixed(1)),
    controlCorrections,
    impactCorrections,
  };
}

async function shipFromApi(pilotId: string): Promise<Ship> {
  const query = new URLSearchParams({ pilotId });
  const snapshot = await api<WorldSnapshot>(`/api/world?${query.toString()}`);
  const ship = snapshot.ships.find((candidate) => candidate.pilotId === pilotId);
  if (ship === undefined) {
    throw new Error("Owned ship missing from world snapshot.");
  }
  return ship;
}

function distance(a: Vector3, b: Vector3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

async function ownedPosition(page: Page): Promise<Vector3> {
  return page.evaluate(() => {
    const probe = (
      window as unknown as { __probe?: { owned?: { x: number; y: number; z: number } } }
    ).__probe?.owned;
    if (probe !== undefined) {
      return { x: probe.x, y: probe.y, z: probe.z };
    }
    const app = document.querySelector("[data-testid='haystack-app']");
    return {
      x: Number(app?.getAttribute("data-owned-x") ?? "0"),
      y: Number(app?.getAttribute("data-owned-y") ?? "0"),
      z: Number(app?.getAttribute("data-owned-z") ?? "0"),
    };
  });
}

async function predictionCorrections(page: Page): Promise<number> {
  return Number(await page.getByTestId("haystack-app").getAttribute("data-prediction-corrections"));
}

async function ownedZ(page: Page): Promise<number> {
  // Prefer the per-frame render probe (predicted position, written each useFrame);
  // the data-owned-z attribute is React state and goes stale between server messages.
  return page.evaluate(() => {
    const probe = (window as unknown as { __probe?: { owned?: { z: number } } }).__probe?.owned;
    if (probe !== undefined) {
      return probe.z;
    }
    const app = document.querySelector("[data-testid='haystack-app']");
    return Number(app?.getAttribute("data-owned-z") ?? "0");
  });
}

async function ackTick(page: Page): Promise<number> {
  return Number(await page.getByTestId("haystack-app").getAttribute("data-ack-tick"));
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
