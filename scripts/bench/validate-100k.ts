// P7 — functional + durability validation at HIGH DENSITY (100k visible field).
//
// The 100k-asteroid perf refactor (derive the static field client-side; build the
// shared world once per tick; O(1) field change-detection) must not regress any
// player-observable behavior. This harness boots the REAL server (createApp +
// WorldStream + ServerWorld) with the field driven to 100k via HAYSTACK_RENDERED_LIMIT
// and asserts, with checked expectations, that at high density:
//   - a player ends up with >=100,000 renderable asteroids for their location,
//   - mining, a pocket scan, and a surface scan still return results,
//   - asteroid / deposit / structure discovery flags still resolve,
//   - a remote ship's position replicates to another peer via the broadcast delta,
//   - chat round-trips into world snapshots,
//   - the server sustains the 30 Hz broadcast with headroom (publishAll < budget),
// then that ship / cargo / credits / structures / discoveries survive a server restart
// (close the SQLite file and reopen it).
//
// This is the "checked validation" for prd.json item P7. It is intentionally NOT part
// of `bun run verify` (100k field generation is slow); run it explicitly:
//   bun scripts/bench/validate-100k.ts
// It exits non-zero on the first failed check so it can gate the perf branch.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { WSContext } from "hono/ws";

import { createApp } from "../../src/server/app";
import { openDatabase, type HaystackDb } from "../../src/server/db";
import { streamedFieldAsteroids } from "../../src/server/field";
import { WorldStream } from "../../src/server/realtime";
import { getSnapshot } from "../../src/server/sim";
import { getServerWorld } from "../../src/server/world";
import type { Ship, WorldSnapshot, WorldStreamServerMessage } from "../../src/shared/types";

process.env["HAYSTACK_RENDERED_LIMIT"] = process.env["HAYSTACK_RENDERED_LIMIT"] ?? "100000";
const RENDERED_LIMIT = Number(process.env["HAYSTACK_RENDERED_LIMIT"]);

let checks = 0;
let failures = 0;

function check(name: string, condition: boolean, detail = ""): void {
  checks += 1;
  if (condition) {
    console.log(`  ✓ ${name}${detail ? ` (${detail})` : ""}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

type Hono = ReturnType<typeof createApp>;

async function postJson<T>(app: Hono, path: string, body: unknown): Promise<T> {
  const response = await app.request(path, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
  return (await response.json()) as T;
}

async function getJson<T>(app: Hono, path: string): Promise<T> {
  const response = await app.request(path);
  return (await response.json()) as T;
}

type AsteroidSeed = { id: string; x: number; y: number; z: number; radius: number };

function seededAsteroid(db: HaystackDb, pocket: string): AsteroidSeed {
  const row = db
    .query("SELECT id, x, y, z, radius FROM asteroids WHERE pocket = ? ORDER BY id ASC LIMIT 1")
    .get(pocket) as AsteroidSeed | null;
  if (row === null) {
    throw new Error(`Expected a seeded asteroid in pocket ${pocket}.`);
  }
  return row;
}

function firstDepositId(db: HaystackDb, asteroidId: string): string {
  const row = db
    .query("SELECT id FROM deposits WHERE asteroid_id = ? ORDER BY id ASC LIMIT 1")
    .get(asteroidId) as { id: string } | null;
  if (row === null) {
    throw new Error(`Expected a seeded deposit on ${asteroidId}.`);
  }
  return row.id;
}

function placeShip(
  db: HaystackDb,
  pilotId: string,
  position: { x: number; y: number; z: number },
): void {
  db.query("UPDATE ships SET x = ?, y = ?, z = ?, vx = 0, vy = 0, vz = 0 WHERE pilot_id = ?").run(
    position.x,
    position.y,
    position.z,
    pilotId,
  );
}

function placeNear(db: HaystackDb, pilotId: string, asteroid: AsteroidSeed): void {
  placeShip(db, pilotId, { x: asteroid.x + asteroid.radius + 40, y: asteroid.y, z: asteroid.z });
}

// Stub peer that records the JSON messages the world stream sends it, so we can drive
// the REAL publishAll() broadcast path in-process (no sockets) and inspect deltas.
type CapturingPeer = { pilotId: string; messages: WorldStreamServerMessage[]; ws: WSContext };

function makeCapturingPeer(pilotId: string): CapturingPeer {
  const peer: CapturingPeer = {
    pilotId,
    messages: [],
    ws: {
      readyState: 1,
      send(data: string | ArrayBufferLike) {
        if (typeof data === "string") {
          peer.messages.push(JSON.parse(data) as WorldStreamServerMessage);
        }
      },
      close() {},
    } as unknown as WSContext,
  };
  return peer;
}

function percentile(sortedAscending: number[], p: number): number {
  if (sortedAscending.length === 0) {
    return 0;
  }
  const index = Math.min(
    sortedAscending.length - 1,
    Math.max(0, Math.ceil((p / 100) * sortedAscending.length) - 1),
  );
  return sortedAscending[index] ?? 0;
}

async function validateHighDensity(): Promise<void> {
  console.log(`\n[1/2] High-density world (HAYSTACK_RENDERED_LIMIT=${RENDERED_LIMIT})`);
  const db = openDatabase(":memory:");
  const world = getServerWorld(db);
  const stream = new WorldStream(world);
  const app = createApp({ db, world, worldStream: stream });

  try {
    const alice = (
      await postJson<{ pilot: { id: string } }>(app, "/api/pilots", {
        callsign: "P7 Alice",
      })
    ).pilot;
    const bob = (
      await postJson<{ pilot: { id: string } }>(app, "/api/pilots", {
        callsign: "P7 Bob",
      })
    ).pilot;

    const asteroid = seededAsteroid(db, "inner-drift");
    const depositId = firstDepositId(db, asteroid.id);
    placeNear(db, alice.id, asteroid);

    // Capacity: effective client-visible count = streamed seeded set + the deterministic
    // virtual field the client derives locally (the SAME generator the bench counts).
    const probe = getSnapshot(db, alice.id, [alice.id, bob.id]);
    const aliceShip = probe.ships.find((ship) => ship.pilotId === alice.id);
    const derived = aliceShip === undefined ? 0 : streamedFieldAsteroids(aliceShip.position).length;
    const effective = probe.asteroids.length + derived;
    check(
      "capacity: >=100,000 renderable asteroids for the player's location",
      effective >= 100000,
      `effective=${effective}`,
    );
    check(
      "field summary advertises the 1,000,000-rock universe + 100k rendered limit",
      probe.field.totalAsteroids === 1_000_000 && probe.field.renderedLimit === RENDERED_LIMIT,
      `total=${probe.field.totalAsteroids} limit=${probe.field.renderedLimit}`,
    );

    // Pocket scan (surfaces seeded rocks, the virtual field, and structures).
    const pocket = await postJson<{ report: { hits: Array<{ kind: string }> } }>(
      app,
      `/api/ships/${alice.id}/scan`,
      { mode: "pocket" },
    );
    check(
      "pocket scan returns asteroid/structure hits",
      pocket.report.hits.some((hit) => hit.kind === "asteroid" || hit.kind === "structure"),
      `hits=${pocket.report.hits.length}`,
    );

    // Surface scan against the targeted rock -> its deposits.
    const surface = await postJson<{ report: { hits: Array<{ kind: string }> } }>(
      app,
      `/api/ships/${alice.id}/scan`,
      { mode: "surface", targetAsteroidId: asteroid.id },
    );
    check(
      "surface scan returns deposit hits",
      surface.report.hits.some((hit) => hit.kind === "deposit"),
      `hits=${surface.report.hits.length}`,
    );

    // Mining extracts mass into cargo.
    const mine = await postJson<{ result: { minedMass: number } }>(
      app,
      `/api/ships/${alice.id}/mine`,
      {
        asteroidId: asteroid.id,
        depositId,
      },
    );
    check(
      "mining extracts deposit mass",
      mine.result.minedMass > 0,
      `minedMass=${mine.result.minedMass}`,
    );

    const aliceWorld = await getJson<WorldSnapshot>(app, `/api/world?pilotId=${alice.id}`);
    check("mined cargo appears in the snapshot", aliceWorld.cargo.length > 0);

    // Discovery flags (distance-gated; the field move did not change this path).
    const nearAsteroid = aliceWorld.asteroids.find((entry) => entry.id === asteroid.id);
    check("asteroid discovery: the nearby rock is discovered", nearAsteroid?.discovered === true);
    check(
      "asteroid discovery: distant rocks stay undiscovered (gate is live, not all-true)",
      aliceWorld.asteroids.some((entry) => !entry.discovered),
    );
    const nearDeposit = aliceWorld.deposits.find((entry) => entry.id === depositId);
    check(
      "deposit discovery: the nearest rock's deposit is discovered",
      nearDeposit?.discovered === true,
    );

    // Chat round-trips into another pilot's snapshot.
    await postJson(app, "/api/chat", {
      channel: "global",
      fromPilotId: alice.id,
      body: "p7 needle online",
    });
    const bobWorld = await getJson<WorldSnapshot>(app, `/api/world?pilotId=${bob.id}`);
    check(
      "chat: a global message reaches another pilot's snapshot",
      bobWorld.chat.some((message) => message.body === "p7 needle online"),
    );

    // Multiplayer remote-position sync over the real broadcast path (stub peers).
    const peerA = makeCapturingPeer(alice.id);
    const peerB = makeCapturingPeer(bob.id);
    stream.open(peerA.ws, alice.id);
    stream.open(peerB.ws, bob.id);
    peerA.messages.length = 0;
    world.applyCommand(bob.id, { impulse: { x: 6, y: 0, z: 0 } });
    stream.publishAll();
    let replicated = false;
    for (const message of peerA.messages) {
      if (message.type !== "delta" || !message.changed.includes("ships")) {
        continue;
      }
      const ships = (message.patch.ships ?? []) as Ship[];
      if (ships.some((ship) => ship.pilotId === bob.id && ship.velocity.x > 0)) {
        replicated = true;
        break;
      }
    }
    check(
      "multiplayer: a remote ship's motion replicates to another peer via the broadcast delta",
      replicated,
    );

    // 30 Hz sustainability at 100k: per-tick publishAll cost under the 33.3ms budget while
    // both players fly at 5 km/s (re-paging cells). Warm a few ticks, then time steady state.
    for (let i = 0; i < 5; i += 1) {
      stream.publishAll();
    }
    const metersPerTick = 5000 / 30;
    const nudge = db.query("UPDATE ships SET x = x + ? WHERE pilot_id = ?");
    const samples: number[] = [];
    for (let i = 0; i < 30; i += 1) {
      nudge.run(metersPerTick, alice.id);
      nudge.run(metersPerTick, bob.id);
      const start = performance.now();
      stream.publishAll();
      samples.push(performance.now() - start);
    }
    samples.sort((left, right) => left - right);
    const p95 = percentile(samples, 95);
    check(
      "30 Hz: server sustains the broadcast at 100k (p95 publishAll < 33.3ms budget)",
      p95 < 33.3,
      `p95=${p95.toFixed(3)}ms`,
    );
  } finally {
    world.stop();
    db.close();
  }
}

async function validateRestartDurability(): Promise<void> {
  console.log("\n[2/2] Restart durability (close + reopen the SQLite file)");
  const directory = mkdtempSync(join(tmpdir(), "haystack-p7-"));
  const path = join(directory, "world.sqlite");

  try {
    // --- first boot: accrue durable state ---
    const db1 = openDatabase(path);
    const app1 = createApp({ db: db1 });
    const pilot = (
      await postJson<{ pilot: { id: string } }>(app1, "/api/pilots", {
        callsign: "P7 Durable",
      })
    ).pilot;

    // Deploy a hidden HAB away from station traffic (spends 500 of the starting 1000).
    placeShip(db1, pilot.id, { x: 76000, y: -3200, z: -41000 });
    const build = await postJson<{ result: { structure: { id: string } } }>(
      app1,
      `/api/ships/${pilot.id}/bases`,
      { name: "P7 Cache", hidden: true },
    );
    const structureId = build.result.structure.id;

    // Move next to a rock and mine, so cargo + the final ship position are non-trivial.
    const asteroid = seededAsteroid(db1, "inner-drift");
    const depositId = firstDepositId(db1, asteroid.id);
    placeNear(db1, pilot.id, asteroid);
    await postJson(app1, `/api/ships/${pilot.id}/mine`, { asteroidId: asteroid.id, depositId });
    await postJson(app1, "/api/chat", {
      channel: "global",
      fromPilotId: pilot.id,
      body: "p7 persist",
    });

    const before = await getJson<WorldSnapshot>(app1, `/api/world?pilotId=${pilot.id}`);
    const beforeShip = before.ships.find((ship) => ship.pilotId === pilot.id);
    getServerWorld(db1).stop();
    db1.close();

    // --- restart: reopen the same file, recompute the snapshot ---
    const db2 = openDatabase(path);
    const app2 = createApp({ db: db2 });
    const after = await getJson<WorldSnapshot>(app2, `/api/world?pilotId=${pilot.id}`);
    const afterShip = after.ships.find((ship) => ship.pilotId === pilot.id);

    check(
      "restart: ship position persists",
      beforeShip !== undefined &&
        afterShip !== undefined &&
        Math.abs(afterShip.position.x - beforeShip.position.x) < 1 &&
        Math.abs(afterShip.position.y - beforeShip.position.y) < 1 &&
        Math.abs(afterShip.position.z - beforeShip.position.z) < 1,
      `before=${beforeShip ? `${beforeShip.position.x},${beforeShip.position.z}` : "?"} after=${afterShip ? `${afterShip.position.x},${afterShip.position.z}` : "?"}`,
    );
    check(
      "restart: credits persist (1000 start - 500 HAB = 500)",
      after.me?.credits === 500,
      `credits=${after.me?.credits}`,
    );
    check(
      "restart: cargo persists",
      after.cargo.length > 0 && after.cargo.some((item) => item.mass > 0),
      `cargo=${after.cargo.length}`,
    );
    check(
      "restart: structure persists + owner discovery recomputes",
      after.structures.some((structure) => structure.id === structureId && structure.discovered),
    );
    check(
      "restart: asteroid discovery recomputes from persisted position",
      after.asteroids.some((entry) => entry.id === asteroid.id && entry.discovered),
    );
    check(
      "restart: deposit discovery recomputes from persisted position",
      after.deposits.some((entry) => entry.id === depositId && entry.discovered),
    );
    check(
      "restart: chat persists",
      after.chat.some((message) => message.body === "p7 persist"),
    );

    getServerWorld(db2).stop();
    db2.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  console.log("P7 validation — 100k visible asteroids, multiplayer, 5 km/s");
  await validateHighDensity();
  await validateRestartDurability();

  console.log(`\nP7 VALIDATION: ${checks - failures}/${checks} checks passed`);
  if (failures > 0) {
    console.error(`FAILED: ${failures} check(s) did not pass.`);
    process.exit(1);
  }
  console.log("PASSED: all functional + durability checks green at high density.");
  process.exit(0);
}

void main();
