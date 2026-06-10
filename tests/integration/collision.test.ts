import { describe, expect, test } from "bun:test";

import { openDatabase } from "../../src/server/db";
import { getServerWorld } from "../../src/server/world";

import {
  makeShipCollisionEnvironment,
  resolveShipCollision,
  resolveShipPairCollision,
  SHIP_COLLISION_RADIUS,
  type CollisionSphere,
} from "../../src/shared/collision";
import { deriveVirtualField } from "../../src/client/eve/field-core";
import { fieldSummary, serverBeltField } from "../../src/server/field";
import { loadBeltBakeSync } from "../../src/server/belt-bake";
import { setActiveBeltBake } from "../../src/client/eve/field-core";
import {
  applyShipCommandForPrediction,
  integrateShipTick,
  shipFixedDt,
} from "../../src/shared/ship-motion";
import type { FlightInputCommand, Ship, Vector3 } from "../../src/shared/types";

const field = fieldSummary();
// Belt mode: client-side derives (deriveVirtualField) need the bake registered, the
// same artifacts the server loaded from public/belt/.
if (field.belt !== undefined) {
  const bake = loadBeltBakeSync(field.belt.preset, field.cellSize);
  if (bake === null) throw new Error("belt bake artifacts missing");
  setActiveBeltBake(bake, field);
}

function emptyEnvironment() {
  return makeShipCollisionEnvironment(null, []);
}

function baseShip(position: Vector3, velocity: Vector3): Ship {
  return {
    pilotId: "pilot-collision",
    name: "Collider",
    position,
    velocity,
    orientation: { x: 0, y: 0, z: 0, w: 1 },
    angularVelocity: { x: 0, y: 0, z: 0 },
    throttle: 0,
    cruiseLock: false,
    navLightsOn: false,
    flashlightOn: false,
    heat: 0,
    cargoMass: 0,
    cargoCapacity: 180,
    scanPower: 1,
    miningPower: 22,
    stabilizerEfficiency: 0.42,
  };
}

function distance(a: Vector3, b: Vector3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

// A virtual rock near the default spawn, taken from the client derivation so the test
// places the ship relative to the exact gameplay (base) rock position.
function nearestDerivedRock(origin: Vector3): { position: Vector3; radius: number; id: string } {
  const derived = deriveVirtualField(origin, { ...field, renderedLimit: 32 });
  const rock = derived[0];
  if (rock === undefined) {
    throw new Error("expected a derived rock");
  }
  return rock;
}

describe("shared ship collision", () => {
  test("virtual obstacle derivation matches the parity-gated field math exactly", () => {
    // Sample heights sit INSIDE the ED-thin slab (BELT_VERTICAL_SQUASH compresses the
    // belt to ~±4 km, with most mass within ~±2 km): the old y=16000/-3200 samples are
    // legitimately empty space now. The test pins obstacle≡derive parity, so samples
    // must be where rocks exist.
    const samples: Vector3[] = [
      { x: 1264900, y: 20, z: 250 },
      { x: 1250000, y: 1200, z: 8000 },
      { x: 1348000, y: -1500, z: -22000 },
      { x: 1454000, y: 800, z: 24000 },
    ];
    for (const origin of samples) {
      const env = makeShipCollisionEnvironment(field, [], serverBeltField());
      const obstacles = env.obstaclesForSegment(origin, origin);
      expect(obstacles.length).toBeGreaterThan(0);
      // The obstacle sweep reaches maxHeroRadius (+ship) ≈ ±2.2 km of the segment; the
      // cross-check set must cover that whole box. At the ED-ring density (BELT_CELL_SIZE
      // 530 m, ~4-6 rocks/km³) a 200-rock ball spans only ~2 km, so the limit that made
      // the box ⊂ ball at the old 1130 m grid now has to be 2500.
      const derived = deriveVirtualField(origin, { ...field, renderedLimit: 2500 });
      const derivedById = new Map(derived.map((rock) => [rock.id, rock]));
      for (const obstacle of obstacles) {
        const rock = derivedById.get(obstacle.id);
        // Every obstacle the collision env derives must be the SAME rock (bit-identical
        // base position + radius) the client field derivation produces for that cell.
        expect(rock).toBeDefined();
        expect(obstacle.position.x).toBe(rock!.position.x);
        expect(obstacle.position.y).toBe(rock!.position.y);
        expect(obstacle.position.z).toBe(rock!.position.z);
        expect(obstacle.radius).toBe(rock!.radius);
      }
      // And no touchable rock may be missing: any derived rock close enough to overlap
      // a ship at `origin` must be in the obstacle set.
      for (const rock of derived) {
        if (distance(rock.position, origin) <= rock.radius + SHIP_COLLISION_RADIUS) {
          expect(obstacles.some((obstacle) => obstacle.id === rock.id)).toBe(true);
        }
      }
    }
  });

  test("pushes an overlapping ship out to the contact distance and kills inward velocity", () => {
    const rock: CollisionSphere = { id: "r", position: { x: 0, y: 0, z: 0 }, radius: 200 };
    const env = makeShipCollisionEnvironment(null, [rock]);
    // Ship inside the combined radius, flying inward.
    const previous: Vector3 = { x: 300, y: 0, z: 0 };
    const ship = baseShip({ x: 230, y: 0, z: 0 }, { x: -120, y: 0, z: 30 });
    const resolved = resolveShipCollision(previous, ship, env);

    expect(distance(resolved.position, rock.position)).toBeGreaterThanOrEqual(
      rock.radius + SHIP_COLLISION_RADIUS - 0.001,
    );
    // Inward (−x) component removed (small outward bounce allowed); tangential kept.
    expect(resolved.velocity.x).toBeGreaterThanOrEqual(0);
    expect(resolved.velocity.z).toBeCloseTo(30, 6);
  });

  test("does not tunnel through a rock at extreme speed in one fixed step", () => {
    const rock: CollisionSphere = { id: "r", position: { x: 0, y: 0, z: 0 }, radius: 100 };
    const env = makeShipCollisionEnvironment(null, [rock]);
    const speed = 120000; // 2 km per 1/60 step — far beyond any reachable speed
    const previous: Vector3 = { x: 1000, y: 0, z: 0 };
    const moved = baseShip(
      { x: 1000 - speed * shipFixedDt, y: 0, z: 0 },
      { x: -speed, y: 0, z: 0 },
    );
    const resolved = resolveShipCollision(previous, moved, env);

    // The swept test must stop the ship at the near side of the rock, not let it pass.
    expect(resolved.position.x).toBeGreaterThanOrEqual(rock.radius + SHIP_COLLISION_RADIUS - 0.001);
    expect(resolved.velocity.x).toBeGreaterThanOrEqual(0);
  });

  test("integrateShipTick with a collision environment stops a ship flying into a virtual rock", () => {
    const origin: Vector3 = { x: 1264900, y: 20, z: 250 };
    const rock = nearestDerivedRock(origin);
    const env = makeShipCollisionEnvironment(field, [], serverBeltField());

    // Start outside the rock and fly straight at its center at 200 m/s.
    const startDistance = rock.radius + SHIP_COLLISION_RADIUS + 400;
    const direction = {
      x: (rock.position.x - origin.x) / distance(rock.position, origin),
      y: (rock.position.y - origin.y) / distance(rock.position, origin),
      z: (rock.position.z - origin.z) / distance(rock.position, origin),
    };
    const start: Vector3 = {
      x: rock.position.x - direction.x * startDistance,
      y: rock.position.y - direction.y * startDistance,
      z: rock.position.z - direction.z * startDistance,
    };
    let ship = baseShip(start, {
      x: direction.x * 200,
      y: direction.y * 200,
      z: direction.z * 200,
    });

    let closest = Number.POSITIVE_INFINITY;
    for (let tick = 0; tick < 60 * 6; tick += 1) {
      ship = integrateShipTick(ship, shipFixedDt, null, env);
      closest = Math.min(closest, distance(ship.position, rock.position));
      // Invariant: never inside the rock.
      expect(distance(ship.position, rock.position)).toBeGreaterThanOrEqual(
        rock.radius + SHIP_COLLISION_RADIUS - 0.001,
      );
    }
    // It reached the rock surface (contact happened)...
    expect(closest).toBeLessThanOrEqual(rock.radius + SHIP_COLLISION_RADIUS + 0.001);
    // ...and bounced off gently: outward speed is the restitution fraction of the
    // 200 m/s approach, not a dead stop and not a violent eject.
    const speed = Math.hypot(ship.velocity.x, ship.velocity.y, ship.velocity.z);
    expect(speed).toBeLessThanOrEqual(45);
    expect(
      ship.velocity.x * direction.x + ship.velocity.y * direction.y + ship.velocity.z * direction.z,
    ).toBeLessThanOrEqual(0);
  });

  test("prediction and server integrate identically through a collision", () => {
    const origin: Vector3 = { x: 1264900, y: 20, z: 250 };
    const rock = nearestDerivedRock(origin);
    const env = makeShipCollisionEnvironment(field, [], serverBeltField());
    const command: FlightInputCommand = {
      kind: "flight",
      throttle: 1,
      active: true,
      strafe: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
    };

    const startDistance = rock.radius + SHIP_COLLISION_RADIUS + 250;
    const start: Vector3 = {
      x: rock.position.x,
      y: rock.position.y,
      z: rock.position.z + startDistance,
    };
    // Both sides start from the same state and apply the same per-tick command
    // (forward is -z for the identity orientation, straight at the rock).
    let predicted = baseShip(start, { x: 0, y: 0, z: 0 });
    let server = baseShip(start, { x: 0, y: 0, z: 0 });

    for (let tick = 0; tick < 60 * 4; tick += 1) {
      predicted = applyShipCommandForPrediction(predicted, command, shipFixedDt, env);
      server = applyShipCommandForPrediction(server, command, shipFixedDt, env);
      expect(predicted.position).toEqual(server.position);
      expect(predicted.velocity).toEqual(server.velocity);
    }
    // Sanity: the run actually hit the rock (rests within a bounce amplitude of the
    // contact distance — continuous thrust + restitution oscillates a few meters).
    expect(distance(predicted.position, rock.position)).toBeLessThanOrEqual(
      rock.radius + SHIP_COLLISION_RADIUS + 6,
    );
  });

  test("ship pair response separates symmetrically and bumps only when approaching", () => {
    // Approaching pair: equal-mass bump, symmetric.
    const a = { position: { x: -40, y: 0, z: 0 }, velocity: { x: 30, y: 0, z: 0 } };
    const b = { position: { x: 40, y: 0, z: 0 }, velocity: { x: -30, y: 0, z: 0 } };
    const bumped = resolveShipPairCollision(a, b);
    expect(bumped).not.toBeNull();
    // Pushed apart by equal amounts.
    expect(bumped!.a.position.x).toBeCloseTo(-bumped!.b.position.x, 9);
    // Velocities reversed symmetrically along the normal (with restitution <= 1).
    expect(bumped!.a.velocity.x).toBeLessThanOrEqual(0);
    expect(bumped!.b.velocity.x).toBeGreaterThanOrEqual(0);
    expect(bumped!.a.velocity.x).toBeCloseTo(-bumped!.b.velocity.x, 9);

    // Resting overlapped pair (e.g. shared spawn): separates positionally without
    // gaining a violent impulse.
    const restingA = { position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 } };
    const restingB = { position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 } };
    const separated = resolveShipPairCollision(restingA, restingB);
    expect(separated).not.toBeNull();
    expect(distance(separated!.a.position, separated!.b.position)).toBeGreaterThan(0);
    expect(
      Math.hypot(separated!.a.velocity.x, separated!.a.velocity.y, separated!.a.velocity.z),
    ).toBeLessThan(1);

    // Distant pair: untouched.
    const farA = { position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 } };
    const farB = { position: { x: 500, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 } };
    expect(resolveShipPairCollision(farA, farB)).toBeNull();
  });

  test("server world separates two overlapping ships and resolves an approaching pair", async () => {
    const db = openDatabase(":memory:");
    try {
      const app = (await import("../../src/server/app")).createApp({ db });
      for (const callsign of ["Collide A", "Collide B"]) {
        const response = await app.request("/api/pilots", {
          method: "POST",
          body: JSON.stringify({ callsign }),
          headers: { "Content-Type": "application/json" },
        });
        expect(response.status).toBe(201);
      }
      const rows = db.query("SELECT pilot_id FROM ships ORDER BY pilot_id").all() as Array<{
        pilot_id: string;
      }>;
      expect(rows).toHaveLength(2);
      const [a, b] = rows as [{ pilot_id: string }, { pilot_id: string }];

      // Place the pair approaching head-on in empty space (far from any rock is not
      // guaranteed in the virtual field, so pick a spot verified empty: the test below
      // asserts the pre-collision gap shrinks then resolves, which a rock would break).
      db.query(
        "UPDATE ships SET x = -400, y = 0, z = 0, vx = 60, vy = 0, vz = 0, qx=0,qy=0,qz=0,qw=1, wx=0,wy=0,wz=0, throttle=0 WHERE pilot_id = ?",
      ).run(a.pilot_id);
      db.query(
        "UPDATE ships SET x = 400, y = 0, z = 0, vx = -60, vy = 0, vz = 0, qx=0,qy=0,qz=0,qw=1, wx=0,wy=0,wz=0, throttle=0 WHERE pilot_id = ?",
      ).run(b.pilot_id);

      const world = getServerWorld(db);
      let now = 9_000_000;
      world.advanceToNow(now);
      // 12 simulated seconds: they meet at the middle and must bump, never interpenetrate.
      for (let step = 0; step < 720; step += 1) {
        now += 1000 / 60;
        world.advanceToNow(now);
        const ships = db
          .query("SELECT pilot_id, x, y, z FROM ships ORDER BY pilot_id")
          .all() as Array<{ pilot_id: string; x: number; y: number; z: number }>;
        const [shipA, shipB] = ships as unknown as [
          { x: number; y: number; z: number },
          { x: number; y: number; z: number },
        ];
        const gap = Math.hypot(shipA.x - shipB.x, shipA.y - shipB.y, shipA.z - shipB.z);
        expect(gap).toBeGreaterThanOrEqual(SHIP_COLLISION_RADIUS * 2 - 0.01);
      }
      const final = db.query("SELECT pilot_id, x, vx FROM ships ORDER BY pilot_id").all() as Array<{
        pilot_id: string;
        x: number;
        vx: number;
      }>;
      const [finalA, finalB] = final as unknown as [
        { x: number; vx: number },
        { x: number; vx: number },
      ];
      // They bounced: A ends on the left moving left (or stopped), B mirrored.
      expect(finalA.x).toBeLessThan(finalB.x);
      expect(finalA.vx).toBeLessThanOrEqual(0);
      expect(finalB.vx).toBeGreaterThanOrEqual(0);

      // Shared-spawn case: stack both ships on the same point at rest — they must
      // separate without violent velocity.
      for (const id of [a.pilot_id, b.pilot_id]) {
        db.query(
          "UPDATE ships SET x = 1500, y = 1500, z = 1500, vx = 0, vy = 0, vz = 0 WHERE pilot_id = ?",
        ).run(id);
      }
      for (let step = 0; step < 120; step += 1) {
        now += 1000 / 60;
        world.advanceToNow(now);
      }
      const separated = db
        .query("SELECT x, y, z, vx, vy, vz FROM ships ORDER BY pilot_id")
        .all() as Array<{ x: number; y: number; z: number; vx: number; vy: number; vz: number }>;
      const [sepA, sepB] = separated as [
        { x: number; y: number; z: number; vx: number; vy: number; vz: number },
        { x: number; y: number; z: number; vx: number; vy: number; vz: number },
      ];
      const gap = Math.hypot(sepA.x - sepB.x, sepA.y - sepB.y, sepA.z - sepB.z);
      expect(gap).toBeGreaterThanOrEqual(SHIP_COLLISION_RADIUS * 2 - 0.01);
      expect(Math.hypot(sepA.vx, sepA.vy, sepA.vz)).toBeLessThan(5);
    } finally {
      db.close();
    }
  });

  test("server world stops a ship flying into a virtual rock (actor wiring)", async () => {
    const db = openDatabase(":memory:");
    try {
      const app = (await import("../../src/server/app")).createApp({ db });
      const response = await app.request("/api/pilots", {
        method: "POST",
        body: JSON.stringify({ callsign: "Rock Rammer" }),
        headers: { "Content-Type": "application/json" },
      });
      expect(response.status).toBe(201);
      const row = db.query("SELECT pilot_id FROM ships").get() as { pilot_id: string };

      const origin: Vector3 = { x: 1264900, y: 20, z: 250 };
      const rock = nearestDerivedRock(origin);
      const approach = rock.radius + SHIP_COLLISION_RADIUS + 600;
      const direction = {
        x: (rock.position.x - origin.x) / distance(rock.position, origin),
        y: (rock.position.y - origin.y) / distance(rock.position, origin),
        z: (rock.position.z - origin.z) / distance(rock.position, origin),
      };
      db.query(
        "UPDATE ships SET x = ?, y = ?, z = ?, vx = ?, vy = ?, vz = ?, throttle = 0 WHERE pilot_id = ?",
      ).run(
        rock.position.x - direction.x * approach,
        rock.position.y - direction.y * approach,
        rock.position.z - direction.z * approach,
        direction.x * 250,
        direction.y * 250,
        direction.z * 250,
        row.pilot_id,
      );

      const world = getServerWorld(db);
      let now = 11_000_000;
      world.advanceToNow(now);
      let closest = Number.POSITIVE_INFINITY;
      for (let step = 0; step < 600; step += 1) {
        now += 1000 / 60;
        world.advanceToNow(now);
        const ship = db.query("SELECT x, y, z FROM ships").get() as {
          x: number;
          y: number;
          z: number;
        };
        const range = distance({ x: ship.x, y: ship.y, z: ship.z }, rock.position);
        closest = Math.min(closest, range);
        expect(range).toBeGreaterThanOrEqual(rock.radius + SHIP_COLLISION_RADIUS - 0.01);
      }
      expect(closest).toBeLessThanOrEqual(rock.radius + SHIP_COLLISION_RADIUS + 0.01);
    } finally {
      db.close();
    }
  });

  test("owned-ship prediction respects the collision environment in predict and replay", async () => {
    const { OwnedShipPrediction } = await import("../../src/client/eve/prediction");
    const rock: CollisionSphere = { id: "r", position: { x: 0, y: 0, z: -1000 }, radius: 300 };
    const env = makeShipCollisionEnvironment(null, [rock]);
    const command: FlightInputCommand = {
      kind: "flight",
      throttle: 1,
      active: true,
      strafe: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
    };

    const prediction = new OwnedShipPrediction();
    prediction.setCollisionEnvironment(env);
    prediction.reset(baseShip({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }));

    // Predict straight into the rock (forward is -z): the predicted ship must stop at
    // the contact distance instead of passing through.
    let last: Ship | null = null;
    for (let tick = 0; tick < 60 * 8; tick += 1) {
      const predicted = prediction.predict(command);
      expect(predicted).not.toBeNull();
      last = predicted!.ship;
      expect(distance(last.position, rock.position)).toBeGreaterThanOrEqual(
        rock.radius + SHIP_COLLISION_RADIUS - 0.001,
      );
    }
    expect(last).not.toBeNull();

    // Replay path: reconcile against a deliberately mismatched authoritative state so
    // the buffered inputs replay — the replay must also respect the rock.
    const replayBase = baseShip({ x: 0, y: 0, z: -200 }, { x: 0, y: 0, z: -180 });
    const outcome = prediction.reconcile(60, replayBase);
    expect(outcome.corrected).toBe(true);
    expect(distance(outcome.ship.position, rock.position)).toBeGreaterThanOrEqual(
      rock.radius + SHIP_COLLISION_RADIUS - 0.001,
    );
  });

  test("new pilots spawn spread out, not stacked inside each other", async () => {
    const db = openDatabase(":memory:");
    try {
      const app = (await import("../../src/server/app")).createApp({ db });
      for (const callsign of ["Spawn One", "Spawn Two", "Spawn Three"]) {
        const response = await app.request("/api/pilots", {
          method: "POST",
          body: JSON.stringify({ callsign }),
          headers: { "Content-Type": "application/json" },
        });
        expect(response.status).toBe(201);
      }
      const ships = db.query("SELECT x, y, z FROM ships").all() as Array<{
        x: number;
        y: number;
        z: number;
      }>;
      expect(ships).toHaveLength(3);
      const spawnCenter: Vector3 = { x: 1264900, y: 20, z: 250 };
      for (let i = 0; i < ships.length; i += 1) {
        const ship = ships[i]!;
        // Near the station spawn (mining/scan distances unaffected)...
        expect(distance({ x: ship.x, y: ship.y, z: ship.z }, spawnCenter)).toBeLessThanOrEqual(450);
        // ...but never inside another freshly spawned ship.
        for (let j = i + 1; j < ships.length; j += 1) {
          const other = ships[j]!;
          const gap = Math.hypot(ship.x - other.x, ship.y - other.y, ship.z - other.z);
          expect(gap).toBeGreaterThanOrEqual(SHIP_COLLISION_RADIUS * 2);
        }
      }
    } finally {
      db.close();
    }
  });

  test("a ship with no nearby obstacles integrates exactly as before (no behavior change)", () => {
    const ship = baseShip({ x: 5000, y: 5000, z: 5000 }, { x: 10, y: -4, z: 7 });
    const withEnv = integrateShipTick(ship, shipFixedDt, null, emptyEnvironment());
    const withoutEnv = integrateShipTick(ship, shipFixedDt, null);
    expect(withEnv.position).toEqual(withoutEnv.position);
    expect(withEnv.velocity).toEqual(withoutEnv.velocity);
  });
});
