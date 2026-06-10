import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { websocket } from "hono/bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createApp } from "../../src/server/app";
import { openDatabase, type HaystackDb } from "../../src/server/db";
import { WorldStream } from "../../src/server/realtime";
import type { WorldStreamServerMessage } from "../../src/shared/types";
import { getServerWorld } from "../../src/server/world";

type TestWorld = {
  db: HaystackDb;
  app: ReturnType<typeof createApp>;
};

type JsonResponse<T> = Response & {
  json(): Promise<T>;
};

type SnapshotProbe = {
  field: { totalAsteroids: number; renderedLimit: number; indexKind: string };
  me: { callsign: string; credits: number } | null;
  pilots: Array<{ id: string; callsign: string; credits: number }>;
  activePilotIds: string[];
  organizations: Array<{
    name: string;
    memberCount: number;
    activeShipCount: number;
    totalCargoMass: number;
    totalCredits: number;
  }>;
  ships: Array<{ pilotId: string }>;
  asteroids: unknown[];
  structures: Array<{ id: string; kind: string; ownerPilotId: string | null; discovered: boolean }>;
  cargo: unknown[];
  chat: Array<{ body: string; channel: string; toPilotId: string | null }>;
};

type MineProbe = {
  result: {
    minedMass: number;
    cargo: Array<{ mineral: string; mass: number }>;
  };
};

type EngineProbe = {
  engine: {
    fixedDt: number;
    currentTick: number;
    actorCount: number;
    authoritativeCount: number;
    actors: Array<{
      id: string;
      className: string;
      role: string;
      replicatedFields: string[];
    }>;
    lastCapture: Record<string, { pos?: unknown; vel?: { x: number }; heat?: number }>;
  };
};

type CliThrustProbe = {
  protocol: string;
  ship: {
    velocity: {
      x: number;
    };
  };
};

type CliWatchProbe = {
  pilotId: string;
  frames: Array<{
    type: string;
    callsign?: string | null;
    ships?: number;
  }>;
};

let world: TestWorld | null = null;

beforeEach(() => {
  const db = openDatabase(":memory:");
  world = {
    db,
    app: createApp({ db }),
  };
});

afterEach(() => {
  world?.db.close();
  world = null;
});

describe("haystack server", () => {
  test("creates a persistent pilot, ship, and seeded world snapshot", async () => {
    const pilot = await createPilot("Verifier One");
    const snapshotResponse = await requireWorld().app.request(`/api/world?pilotId=${pilot.id}`);
    const snapshot = (await snapshotResponse.json()) as SnapshotProbe;

    expect(snapshot.me?.callsign).toBe("Verifier One");
    expect(snapshot.ships).toHaveLength(1);
    expect(snapshot.asteroids.length).toBeGreaterThanOrEqual(30);
    expect(snapshot.structures.some((structure) => structure.kind === "station")).toBe(true);
  });

  test("applies no-flight-assist thrust and optional heat-cost stabilization", async () => {
    const pilot = await createPilot("Verifier Two");

    const thrustResponse = typed<{
      ship: { velocity: { x: number; y: number; z: number }; heat: number };
    }>(
      await requireWorld().app.request(`/api/ships/${pilot.id}/thrust`, {
        method: "POST",
        body: JSON.stringify({ impulse: { x: 8, y: 0, z: 0 } }),
        headers: { "Content-Type": "application/json" },
      }),
    );
    const thrustPayload = await thrustResponse.json();
    expect(thrustPayload.ship.velocity.x).toBeGreaterThan(0);

    const stabilizeResponse = typed<{ ship: { velocity: { x: number }; heat: number } }>(
      await requireWorld().app.request(`/api/ships/${pilot.id}/thrust`, {
        method: "POST",
        body: JSON.stringify({ impulse: { x: 0, y: 0, z: 0 }, stabilize: true }),
        headers: { "Content-Type": "application/json" },
      }),
    );
    const stabilizePayload = await stabilizeResponse.json();

    expect(stabilizePayload.ship.velocity.x).toBeLessThan(thrustPayload.ship.velocity.x);
    expect(stabilizePayload.ship.heat).toBeGreaterThan(thrustPayload.ship.heat);
  });

  test("does not add heat when stabilization performs no damping work", async () => {
    const pilot = await createPilot("Verifier Idle Stabilizer");

    const stabilizeResponse = typed<{ ship: { heat: number } }>(
      await requireWorld().app.request(`/api/ships/${pilot.id}/thrust`, {
        method: "POST",
        body: JSON.stringify({ impulse: { x: 0, y: 0, z: 0 }, stabilize: true }),
        headers: { "Content-Type": "application/json" },
      }),
    );
    const stabilizePayload = await stabilizeResponse.json();

    expect(stabilizePayload.ship.heat).toBe(0);
  });

  test("rotates local-frame thrust through the ship orientation", async () => {
    const pilot = await createPilot("Verifier Local Frame");
    const yawQuarterTurn = Math.SQRT1_2;
    requireWorld()
      .db.query("UPDATE ships SET qx = 0, qy = ?, qz = 0, qw = ? WHERE pilot_id = ?")
      .run(yawQuarterTurn, yawQuarterTurn, pilot.id);

    const thrustResponse = typed<{
      ship: { velocity: { x: number; y: number; z: number } };
    }>(
      await requireWorld().app.request(`/api/ships/${pilot.id}/thrust`, {
        method: "POST",
        body: JSON.stringify({ impulse: { x: 0, y: 0, z: -8 }, frame: "local" }),
        headers: { "Content-Type": "application/json" },
      }),
    );
    const thrustPayload = await thrustResponse.json();

    expect(Math.abs(thrustPayload.ship.velocity.x)).toBeGreaterThan(7);
    expect(Math.abs(thrustPayload.ship.velocity.z)).toBeLessThan(0.5);
  });

  test("applies heat-gated local boost without bypassing overheat lockout", async () => {
    const pilot = await createPilot("Verifier Boost");

    const boostResponse = typed<{ ship: { velocity: { z: number }; heat: number } }>(
      await requireWorld().app.request(`/api/ships/${pilot.id}/thrust`, {
        method: "POST",
        body: JSON.stringify({ impulse: { x: 0, y: 0, z: 0 }, frame: "local", boost: true }),
        headers: { "Content-Type": "application/json" },
      }),
    );
    const boostPayload = await boostResponse.json();
    expect(boostPayload.ship.velocity.z).toBeLessThan(-11);
    expect(boostPayload.ship.heat).toBeGreaterThan(1);
    expect(boostPayload.ship.heat).toBeLessThan(3);

    requireWorld().db.query("UPDATE ships SET vz = 0, heat = 100 WHERE pilot_id = ?").run(pilot.id);
    const lockedResponse = typed<{ ship: { velocity: { z: number }; heat: number } }>(
      await requireWorld().app.request(`/api/ships/${pilot.id}/thrust`, {
        method: "POST",
        body: JSON.stringify({ impulse: { x: 0, y: 0, z: 0 }, frame: "local", boost: true }),
        headers: { "Content-Type": "application/json" },
      }),
    );
    const lockedPayload = await lockedResponse.json();
    expect(lockedPayload.ship.velocity.z).toBe(0);
    expect(lockedPayload.ship.heat).toBeGreaterThanOrEqual(96);
  });

  test("recenters the ship at the origin and clears all movement", async () => {
    const pilot = await createPilot("Verifier Reset");
    requireWorld()
      .db.query(
        "UPDATE ships SET x = 500, y = -200, z = 300, vx = 12, vy = 3, vz = -7, " +
          "wx = 0.4, wy = 0.1, wz = -0.2, throttle = 0.8, cruise_lock = 1 WHERE pilot_id = ?",
      )
      .run(pilot.id);

    const resetResponse = typed<{
      ship: {
        position: { x: number; y: number; z: number };
        velocity: { x: number; y: number; z: number };
        angularVelocity: { x: number; y: number; z: number };
        throttle: number;
        cruiseLock: boolean;
      };
    }>(
      await requireWorld().app.request(`/api/ships/${pilot.id}/reset`, {
        method: "POST",
      }),
    );
    const { ship } = await resetResponse.json();

    expect(ship.position).toEqual({ x: 0, y: 0, z: 0 });
    expect(vectorMagnitude(ship.velocity)).toBe(0);
    expect(vectorMagnitude(ship.angularVelocity)).toBe(0);
    expect(ship.throttle).toBe(0);
    expect(ship.cruiseLock).toBe(false);

    const snapshotResponse = await requireWorld().app.request(`/api/world?pilotId=${pilot.id}`);
    const snapshot = (await snapshotResponse.json()) as {
      ships: Array<{ pilotId: string; position: { x: number; y: number; z: number } }>;
    };
    const persisted = snapshot.ships.find((candidate) => candidate.pilotId === pilot.id);
    expect(persisted?.position).toEqual({ x: 0, y: 0, z: 0 });
  });

  test("spends wallet credits on ship system upgrades", async () => {
    const pilot = await createPilot("Verifier Upgrade");

    const scannerResponse = typed<{
      result: {
        ship: { scanPower: number; cargoCapacity: number };
        system: string;
        cost: number;
        credits: number;
      };
    }>(
      await requireWorld().app.request(`/api/ships/${pilot.id}/upgrade`, {
        method: "POST",
        body: JSON.stringify({ system: "scanner" }),
        headers: { "Content-Type": "application/json" },
      }),
    );
    const scannerPayload = await scannerResponse.json();
    expect(scannerPayload.result.system).toBe("scanner");
    expect(scannerPayload.result.cost).toBe(420);
    expect(scannerPayload.result.credits).toBe(580);
    expect(scannerPayload.result.ship.scanPower).toBeGreaterThan(1);

    const cargoResponse = typed<{
      result: {
        ship: { cargoCapacity: number };
        system: string;
        cost: number;
        credits: number;
      };
    }>(
      await requireWorld().app.request(`/api/ships/${pilot.id}/upgrade`, {
        method: "POST",
        body: JSON.stringify({ system: "cargo" }),
        headers: { "Content-Type": "application/json" },
      }),
    );
    const cargoPayload = await cargoResponse.json();
    expect(cargoPayload.result.system).toBe("cargo");
    expect(cargoPayload.result.ship.cargoCapacity).toBe(240);
    expect(cargoPayload.result.credits).toBe(280);

    const snapshotResponse = await requireWorld().app.request(`/api/world?pilotId=${pilot.id}`);
    const snapshot = (await snapshotResponse.json()) as SnapshotProbe;
    expect(snapshot.me?.credits).toBe(280);
  });

  test("returns belt, pocket, and surface scan signals", async () => {
    const pilot = await createPilot("Verifier Three");
    const asteroid = firstAsteroid();

    const belt = await scan(pilot.id, { mode: "belt" });
    expect(belt.report.hits.some((hit) => hit.kind === "pocket")).toBe(true);

    const pocket = await scan(pilot.id, { mode: "pocket" });
    expect(
      pocket.report.hits.some((hit) => hit.kind === "asteroid" || hit.kind === "structure"),
    ).toBe(true);

    moveShipNear(pilot.id, asteroid.id);
    const surface = await scan(pilot.id, { mode: "surface", targetAsteroidId: asteroid.id });
    expect(surface.report.hits.some((hit) => hit.kind === "deposit")).toBe(true);
  });

  test("mines nearby cargo and sells it at the station", async () => {
    const pilot = await createPilot("Verifier Four");
    const asteroid = firstAsteroid();
    const deposit = firstDeposit(asteroid.id);
    moveShipNear(pilot.id, asteroid.id);

    const mineResponse = typed<{
      result: { minedMass: number; cargo: Array<{ mineral: string; mass: number }> };
    }>(
      await requireWorld().app.request(`/api/ships/${pilot.id}/mine`, {
        method: "POST",
        body: JSON.stringify({ asteroidId: asteroid.id, depositId: deposit.id }),
        headers: { "Content-Type": "application/json" },
      }),
    );
    const minePayload = (await mineResponse.json()) as MineProbe;

    expect(minePayload.result.minedMass).toBeGreaterThan(0);
    expect(minePayload.result.cargo.some((item) => item.mass > 0)).toBe(true);

    const snapshotResponse = await requireWorld().app.request(`/api/world?pilotId=${pilot.id}`);
    const snapshot = (await snapshotResponse.json()) as SnapshotProbe;
    expect(snapshot.cargo.length).toBeGreaterThan(0);

    moveShipToStation(pilot.id);
    const sellResponse = typed<{
      result: { soldMass: number; creditsEarned: number; credits: number; cargo: unknown[] };
    }>(
      await requireWorld().app.request(`/api/ships/${pilot.id}/sell`, {
        method: "POST",
        body: JSON.stringify({}),
        headers: { "Content-Type": "application/json" },
      }),
    );
    const sellPayload = await sellResponse.json();
    expect(sellPayload.result.soldMass).toBeGreaterThan(0);
    expect(sellPayload.result.creditsEarned).toBeGreaterThan(0);
    expect(sellPayload.result.credits).toBeGreaterThan(1000);
    expect(sellPayload.result.cargo).toHaveLength(0);
  });

  test("posts global chat and filters messages into world snapshots", async () => {
    const pilot = await createPilot("Verifier Five");
    const chatResponse = typed<{ message: { body: string; fromCallsign: string } }>(
      await requireWorld().app.request("/api/chat", {
        method: "POST",
        body: JSON.stringify({
          channel: "global",
          fromPilotId: pilot.id,
          body: "needle ping online",
        }),
        headers: { "Content-Type": "application/json" },
      }),
    );
    const chatPayload = await chatResponse.json();
    expect(chatPayload.message.fromCallsign).toBe("Verifier Five");

    const snapshotResponse = await requireWorld().app.request(`/api/world?pilotId=${pilot.id}`);
    const snapshot = (await snapshotResponse.json()) as SnapshotProbe;
    expect(snapshot.chat.some((message) => message.body === "needle ping online")).toBe(true);
  });

  test("summarizes player organizations in public world snapshots", async () => {
    const scout = await createPilot("Verifier Org Scout", "Helio Cartel");
    const hauler = await createPilot("Verifier Org Hauler", "Helio Cartel");

    const asteroid = firstAsteroid();
    const deposit = firstDeposit(asteroid.id);
    moveShipNear(hauler.id, asteroid.id);
    await requireWorld().app.request(`/api/ships/${hauler.id}/mine`, {
      method: "POST",
      body: JSON.stringify({ asteroidId: asteroid.id, depositId: deposit.id }),
      headers: { "Content-Type": "application/json" },
    });

    const snapshotResponse = await requireWorld().app.request(`/api/world?pilotId=${scout.id}`);
    const snapshot = (await snapshotResponse.json()) as SnapshotProbe;
    const organization = snapshot.organizations.find(
      (candidate) => candidate.name === "Helio Cartel",
    );

    expect(organization?.memberCount).toBe(2);
    expect(organization?.activeShipCount).toBe(2);
    expect(organization?.totalCredits).toBe(2000);
    expect(organization?.totalCargoMass).toBeGreaterThan(0);
  });

  test("supports two pilots in one shared world and direct messages", async () => {
    const scout = await createPilot("Verifier Scout");
    const hauler = await createPilot("Verifier Hauler");

    await requireWorld().app.request(`/api/ships/${hauler.id}/thrust`, {
      method: "POST",
      body: JSON.stringify({ impulse: { x: 4, y: 0, z: 0 } }),
      headers: { "Content-Type": "application/json" },
    });
    await requireWorld().app.request("/api/chat", {
      method: "POST",
      body: JSON.stringify({
        channel: "dm",
        fromPilotId: scout.id,
        toPilotId: hauler.id,
        body: "private relay test",
      }),
      headers: { "Content-Type": "application/json" },
    });

    const scoutSnapshotResponse = await requireWorld().app.request(
      `/api/world?pilotId=${scout.id}`,
    );
    const scoutSnapshot = (await scoutSnapshotResponse.json()) as SnapshotProbe;
    expect(scoutSnapshot.pilots.map((pilot) => pilot.callsign)).toContain("Verifier Hauler");
    expect(scoutSnapshot.ships.map((ship) => ship.pilotId)).toContain(hauler.id);
    expect(
      scoutSnapshot.chat.some(
        (message) => message.channel === "dm" && message.body === "private relay test",
      ),
    ).toBe(true);

    const dmResponse = typed<{ messages: Array<{ body: string; toPilotId: string | null }> }>(
      await requireWorld().app.request(`/api/chat?pilotId=${hauler.id}&channel=dm`),
    );
    const dmPayload = (await dmResponse.json()) as {
      messages: Array<{ body: string; toPilotId: string | null }>;
    };
    expect(dmPayload.messages.some((message) => message.body === "private relay test")).toBe(true);
  });

  test("replicates public websocket input and shared world deltas between two clients", async () => {
    const scout = await createPilot("Verifier WS Scout");
    const hauler = await createPilot("Verifier WS Hauler");
    const serverWorld = getServerWorld(requireWorld().db);
    const worldStream = new WorldStream(serverWorld);
    worldStream.start(30);
    const streamApp = createApp({ db: requireWorld().db, world: serverWorld, worldStream });
    const server = Bun.serve({
      port: 0,
      fetch: streamApp.fetch,
      websocket,
    });

    try {
      const baseUrl = `ws://127.0.0.1:${server.port}`;
      const scoutStream = await connectWorldSocket(
        `${baseUrl}/api/world/stream?pilotId=${scout.id}`,
      );
      const haulerStream = await connectWorldSocket(
        `${baseUrl}/api/world/stream?pilotId=${hauler.id}`,
      );

      try {
        const scoutHello = await scoutStream.waitFor((message) => message.type === "hello");
        if (scoutHello.type !== "hello") {
          throw new Error("Expected stream hello.");
        }
        expect(scoutHello.snapshot.pilots.map((pilot) => pilot.callsign)).toContain(
          "Verifier WS Hauler",
        );

        haulerStream.socket.send(
          JSON.stringify({
            type: "input",
            pilotId: hauler.id,
            clientTick: 17,
            command: { impulse: { x: 5, y: 0, z: 0 } },
          }),
        );

        const ack = await haulerStream.waitFor(
          (message) => message.type === "ack" && message.clientTick === 17,
        );
        if (ack.type !== "ack") {
          throw new Error("Expected stream acknowledgement.");
        }
        expect(ack.ackClientTick).toBe(17);
        expect(ack.ship.velocity.x).toBeGreaterThan(0);

        const scoutDelta = await scoutStream.waitFor(
          (message) =>
            message.type === "delta" &&
            message.changed.includes("ships") &&
            (message.patch.ships ?? []).some(
              (ship) => ship.pilotId === hauler.id && ship.velocity.x > 0,
            ),
        );
        expect(scoutDelta.type).toBe("delta");
      } finally {
        scoutStream.socket.close();
        haulerStream.socket.close();
      }
    } finally {
      worldStream.stop();
      server.stop(true);
    }
  });

  test("broadcasts timer deltas stamped with a monotonic server clock", async () => {
    const pilot = await createPilot("Verifier Clock");
    const serverWorld = getServerWorld(requireWorld().db);
    const worldStream = new WorldStream(serverWorld);
    worldStream.start(30);
    const streamApp = createApp({ db: requireWorld().db, world: serverWorld, worldStream });
    const server = Bun.serve({ port: 0, fetch: streamApp.fetch, websocket });

    try {
      const stream = await connectWorldSocket(
        `ws://127.0.0.1:${server.port}/api/world/stream?pilotId=${pilot.id}`,
      );
      try {
        const hello = await stream.waitFor((message) => message.type === "hello");
        if (hello.type !== "hello") {
          throw new Error("Expected stream hello.");
        }
        expect(typeof hello.serverTimeMs).toBe("number");

        stream.socket.send(
          JSON.stringify({
            type: "input",
            pilotId: pilot.id,
            clientTick: 5,
            command: {
              kind: "flight",
              throttle: 1,
              active: true,
              strafe: { x: 0, y: 0, z: 0 },
              rotation: { x: 0, y: 0, z: 0 },
            },
          }),
        );
        const ack = await stream.waitFor(
          (message) => message.type === "ack" && message.clientTick === 5,
        );
        if (ack.type !== "ack") {
          throw new Error("Expected stream acknowledgement.");
        }
        expect(typeof ack.serverTimeMs).toBe("number");

        // The delta is produced by the regular broadcast timer (no per-input
        // flush), and its clock advances past the hello clock so the client can
        // interpolate remote entities on a monotonic timeline.
        const delta = await stream.waitFor(
          (message) =>
            message.type === "delta" &&
            typeof message.serverTimeMs === "number" &&
            message.serverTimeMs > hello.serverTimeMs,
        );
        expect(delta.type).toBe("delta");
      } finally {
        stream.socket.close();
      }
    } finally {
      worldStream.stop();
      server.stop(true);
    }
  });

  test("tracks active websocket pilots separately from persisted pilots", async () => {
    const scout = await createPilot("Verifier Active Scout");
    const hauler = await createPilot("Verifier Active Hauler");
    const serverWorld = getServerWorld(requireWorld().db);
    const worldStream = new WorldStream(serverWorld);
    const streamApp = createApp({ db: requireWorld().db, world: serverWorld, worldStream });
    const server = Bun.serve({
      port: 0,
      fetch: streamApp.fetch,
      websocket,
    });

    try {
      const httpBaseUrl = `http://127.0.0.1:${server.port}`;
      const wsBaseUrl = `ws://127.0.0.1:${server.port}`;
      const persistedSnapshotResponse = await fetch(`${httpBaseUrl}/api/world?pilotId=${scout.id}`);
      const persistedSnapshot = (await persistedSnapshotResponse.json()) as SnapshotProbe;
      expect(persistedSnapshot.pilots.map((pilot) => pilot.id)).toContain(hauler.id);
      expect(persistedSnapshot.activePilotIds).toEqual([]);

      const scoutStream = await connectWorldSocket(
        `${wsBaseUrl}/api/world/stream?pilotId=${scout.id}`,
      );
      const haulerStream = await connectWorldSocket(
        `${wsBaseUrl}/api/world/stream?pilotId=${hauler.id}`,
      );

      try {
        const activeSnapshot = await scoutStream.waitFor(
          (message) =>
            message.type === "delta" &&
            message.changed.includes("activePilotIds") &&
            (message.patch.activePilotIds ?? []).includes(hauler.id),
        );
        if (activeSnapshot.type !== "delta") {
          throw new Error("Expected active-pilot delta.");
        }
        expect(activeSnapshot.patch.activePilotIds).toContain(scout.id);
        expect(activeSnapshot.patch.activePilotIds).toContain(hauler.id);

        haulerStream.socket.close();
        const inactiveSnapshot = await scoutStream.waitFor(
          (message) =>
            message.type === "delta" &&
            message.changed.includes("activePilotIds") &&
            !(message.patch.activePilotIds ?? []).includes(hauler.id),
        );
        if (inactiveSnapshot.type !== "delta") {
          throw new Error("Expected inactive-pilot delta.");
        }
        expect(inactiveSnapshot.patch.activePilotIds).toContain(scout.id);
      } finally {
        scoutStream.socket.close();
        haulerStream.socket.close();
      }
    } finally {
      server.stop(true);
    }
  });

  test("streams continuous flight input for throttle, rotation, cruise, and angular stabilization", async () => {
    const pilot = await createPilot("Verifier Flight Stream");
    const serverWorld = getServerWorld(requireWorld().db);
    const worldStream = new WorldStream(serverWorld);
    const streamApp = createApp({ db: requireWorld().db, world: serverWorld, worldStream });
    const server = Bun.serve({
      port: 0,
      fetch: streamApp.fetch,
      websocket,
    });

    try {
      const stream = await connectWorldSocket(
        `ws://127.0.0.1:${server.port}/api/world/stream?pilotId=${pilot.id}`,
      );

      try {
        await stream.waitFor((message) => message.type === "hello");
        stream.socket.send(
          JSON.stringify({
            type: "input",
            pilotId: pilot.id,
            clientTick: 40,
            command: {
              kind: "flight",
              throttle: 0,
              active: true,
              stabilize: true,
              strafe: { x: 0, y: 0, z: 0 },
              rotation: { x: 0, y: 0, z: 0 },
            },
          }),
        );
        const idleStabilizeAck = await stream.waitFor(
          (message) => message.type === "ack" && message.clientTick === 40,
        );
        if (idleStabilizeAck.type !== "ack") {
          throw new Error("Expected idle stabilizer acknowledgement.");
        }
        expect(idleStabilizeAck.ship.heat).toBe(0);

        stream.socket.send(
          JSON.stringify({
            type: "input",
            pilotId: pilot.id,
            clientTick: 41,
            command: {
              kind: "flight",
              throttle: 0.5,
              cruiseLock: true,
              strafe: { x: 0, y: 0, z: 0 },
              rotation: { x: 1, y: 0, z: 0 },
            },
          }),
        );

        await stream.waitFor((message) => message.type === "ack" && message.clientTick === 41);
        stream.socket.send(
          JSON.stringify({
            type: "input",
            pilotId: pilot.id,
            clientTick: 42,
            command: {
              kind: "flight",
              throttle: 0.5,
              cruiseLock: true,
              strafe: { x: 0, y: 0, z: 0 },
              rotation: { x: 1, y: 0, z: 0 },
            },
          }),
        );
        const flightAck = await stream.waitFor(
          (message) => message.type === "ack" && message.clientTick === 42,
        );
        if (flightAck.type !== "ack") {
          throw new Error("Expected flight stream acknowledgement.");
        }
        expect(flightAck.ackClientTick).toBe(42);
        expect(flightAck.ship.throttle).toBe(0.5);
        expect(flightAck.ship.cruiseLock).toBe(true);
        expect(flightAck.ship.angularVelocity.x).toBeGreaterThan(0);
        expect(Math.abs(flightAck.ship.orientation.x)).toBeGreaterThan(0);
        expect(flightAck.ship.velocity.z).toBeLessThan(0);

        stream.socket.send(
          JSON.stringify({
            type: "input",
            pilotId: pilot.id,
            clientTick: 43,
            command: {
              kind: "flight",
              throttle: 0.5,
              active: false,
              stabilize: true,
              strafe: { x: 0, y: 0, z: 0 },
              rotation: { x: 0, y: 0, z: 0 },
            },
          }),
        );
        const stabilizeAck = await stream.waitFor(
          (message) => message.type === "ack" && message.clientTick === 43,
        );
        if (stabilizeAck.type !== "ack") {
          throw new Error("Expected stabilizer acknowledgement.");
        }
        expect(stabilizeAck.ship.angularVelocity.x).toBeLessThan(flightAck.ship.angularVelocity.x);
        expect(vectorMagnitude(stabilizeAck.ship.velocity)).toBeLessThan(
          vectorMagnitude(flightAck.ship.velocity),
        );
        expect(stabilizeAck.ship.heat).toBeGreaterThan(flightAck.ship.heat);
      } finally {
        stream.socket.close();
      }
    } finally {
      server.stop(true);
    }
  });

  test("replicates nav-light and flashlight toggles to the sender and remote peers", async () => {
    const sender = await createPilot("Verifier Lights Sender");
    const observer = await createPilot("Verifier Lights Observer");
    const serverWorld = getServerWorld(requireWorld().db);
    const worldStream = new WorldStream(serverWorld);
    worldStream.start();
    const streamApp = createApp({ db: requireWorld().db, world: serverWorld, worldStream });
    const server = Bun.serve({
      port: 0,
      fetch: streamApp.fetch,
      websocket,
    });

    try {
      const senderStream = await connectWorldSocket(
        `ws://127.0.0.1:${server.port}/api/world/stream?pilotId=${sender.id}`,
      );
      const observerStream = await connectWorldSocket(
        `ws://127.0.0.1:${server.port}/api/world/stream?pilotId=${observer.id}`,
      );

      try {
        const hello = await senderStream.waitFor((message) => message.type === "hello");
        await observerStream.waitFor((message) => message.type === "hello");
        if (hello.type !== "hello") {
          throw new Error("Expected hello snapshot.");
        }
        const initialShip = hello.snapshot.ships.find((ship) => ship.pilotId === sender.id);
        expect(initialShip?.navLightsOn).toBe(false);
        expect(initialShip?.flashlightOn).toBe(false);

        senderStream.socket.send(
          JSON.stringify({
            type: "input",
            pilotId: sender.id,
            clientTick: 7,
            command: {
              kind: "flight",
              throttle: 0,
              active: false,
              navLights: true,
              flashlight: true,
              strafe: { x: 0, y: 0, z: 0 },
              rotation: { x: 0, y: 0, z: 0 },
            },
          }),
        );
        const onAck = await senderStream.waitFor(
          (message) => message.type === "ack" && message.clientTick === 7,
        );
        if (onAck.type !== "ack") {
          throw new Error("Expected lights-on acknowledgement.");
        }
        expect(onAck.ship.navLightsOn).toBe(true);
        expect(onAck.ship.flashlightOn).toBe(true);

        const observerSeesOn = await observerStream.waitFor(
          (message) =>
            message.type === "delta" &&
            (message.patch.ships ?? []).some(
              (ship) =>
                ship.pilotId === sender.id &&
                ship.navLightsOn === true &&
                ship.flashlightOn === true,
            ),
        );
        expect(observerSeesOn.type).toBe("delta");

        senderStream.socket.send(
          JSON.stringify({
            type: "input",
            pilotId: sender.id,
            clientTick: 8,
            command: {
              kind: "flight",
              throttle: 0,
              active: false,
              navLights: false,
              flashlight: false,
              strafe: { x: 0, y: 0, z: 0 },
              rotation: { x: 0, y: 0, z: 0 },
            },
          }),
        );
        const offAck = await senderStream.waitFor(
          (message) => message.type === "ack" && message.clientTick === 8,
        );
        if (offAck.type !== "ack") {
          throw new Error("Expected lights-off acknowledgement.");
        }
        expect(offAck.ship.navLightsOn).toBe(false);
        expect(offAck.ship.flashlightOn).toBe(false);

        const observerSeesOff = await observerStream.waitFor(
          (message) =>
            message.type === "delta" &&
            (message.patch.ships ?? []).some(
              (ship) =>
                ship.pilotId === sender.id &&
                ship.navLightsOn === false &&
                ship.flashlightOn === false,
            ),
        );
        expect(observerSeesOff.type).toBe("delta");

        // A flight input that omits the light fields must keep the current state
        // (same contract as cruiseLock), not reset it.
        senderStream.socket.send(
          JSON.stringify({
            type: "input",
            pilotId: sender.id,
            clientTick: 9,
            command: {
              kind: "flight",
              throttle: 0,
              active: false,
              navLights: true,
              strafe: { x: 0, y: 0, z: 0 },
              rotation: { x: 0, y: 0, z: 0 },
            },
          }),
        );
        await senderStream.waitFor((message) => message.type === "ack" && message.clientTick === 9);
        senderStream.socket.send(
          JSON.stringify({
            type: "input",
            pilotId: sender.id,
            clientTick: 10,
            command: {
              kind: "flight",
              throttle: 0.2,
              active: true,
              strafe: { x: 0, y: 0, z: 0 },
              rotation: { x: 0, y: 0, z: 0 },
            },
          }),
        );
        const keepAck = await senderStream.waitFor(
          (message) => message.type === "ack" && message.clientTick === 10,
        );
        if (keepAck.type !== "ack") {
          throw new Error("Expected state-keeping acknowledgement.");
        }
        expect(keepAck.ship.navLightsOn).toBe(true);
        expect(keepAck.ship.flashlightOn).toBe(false);
      } finally {
        senderStream.socket.close();
        observerStream.socket.close();
      }
    } finally {
      worldStream.stop();
      server.stop(true);
    }
  });

  test("stateful CLI joins, watches, and moves through the public world stream", async () => {
    const serverWorld = getServerWorld(requireWorld().db);
    const worldStream = new WorldStream(serverWorld);
    const streamApp = createApp({ db: requireWorld().db, world: serverWorld, worldStream });
    const server = Bun.serve({
      port: 0,
      fetch: streamApp.fetch,
      websocket,
    });
    const stateDirectory = mkdtempSync(join(tmpdir(), "haystack-cli-stream-"));
    const statePath = join(stateDirectory, "state.json");

    try {
      const serverUrl = `http://127.0.0.1:${server.port}`;
      await runCliCommand([
        "join",
        "Verifier CLI Stream",
        "--server",
        serverUrl,
        "--state",
        statePath,
      ]);
      const watch = (await runCliCommand([
        "watch",
        "--frames",
        "1",
        "--server",
        serverUrl,
        "--state",
        statePath,
      ])) as CliWatchProbe;
      const thrust = (await runCliCommand([
        "thrust",
        "--x",
        "6",
        "--y",
        "0",
        "--z",
        "0",
        "--server",
        serverUrl,
        "--state",
        statePath,
      ])) as CliThrustProbe;

      expect(watch.frames[0]?.type).toBe("hello");
      expect(watch.frames[0]?.callsign).toBe("Verifier CLI Stream");
      expect(watch.frames[0]?.ships).toBeGreaterThan(0);
      expect(thrust.protocol).toBe("world-stream");
      expect(thrust.ship.velocity.x).toBeGreaterThan(0);
    } finally {
      rmSync(stateDirectory, { recursive: true, force: true });
      server.stop(true);
    }
  });

  test("exposes fixed-step authoritative ship actors and replication capture diagnostics", async () => {
    const pilot = await createPilot("Verifier Engine");

    await requireWorld().app.request(`/api/ships/${pilot.id}/thrust`, {
      method: "POST",
      body: JSON.stringify({ impulse: { x: 3, y: 0, z: -2 } }),
      headers: { "Content-Type": "application/json" },
    });

    const response = typed<EngineProbe>(await requireWorld().app.request("/api/engine"));
    const payload = (await response.json()) as EngineProbe;
    const actor = payload.engine.actors.find((candidate) => candidate.id === pilot.id);

    expect(payload.engine.fixedDt).toBe(1 / 60);
    expect(payload.engine.currentTick).toBeGreaterThan(0);
    expect(payload.engine.actorCount).toBeGreaterThan(0);
    expect(payload.engine.authoritativeCount).toBe(payload.engine.actorCount);
    expect(actor?.className).toBe("ShipActor");
    expect(actor?.role).toBe("authoritative");
    expect(actor?.replicatedFields).toEqual([
      "pos",
      "vel",
      "orient",
      "angVel",
      "throttle",
      "cruiseLock",
      "navLights",
      "flashlight",
      "heat",
      "cargoMass",
    ]);
    expect(payload.engine.lastCapture[pilot.id]?.vel?.x).toBeGreaterThan(0);
  });

  test("integrates one fixed tick per frame when inputs and the sim loop overlap", async () => {
    const pilot = await createPilot("Verifier Tick Rate");
    const serverWorld = getServerWorld(requireWorld().db);
    const command = {
      kind: "flight" as const,
      throttle: 1,
      active: true,
      strafe: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
    };

    const frameMs = 1000 / 60;
    let now = 5_000_000;
    serverWorld.advanceToNow(now); // prime lastWallMs without integrating
    const startTick = serverWorld.currentTick;

    // Simulate one wall-clock second of a 60Hz sim timer interleaved with 60Hz
    // client input. Both the timer and applyCommand advance the same world, so a
    // naive forced tick per input double-integrates (~120 steps). A correct
    // fixed-step loop yields ~60 steps for one second of wall-clock.
    const frames = 60;
    for (let frame = 0; frame < frames; frame += 1) {
      now += frameMs / 2;
      serverWorld.advanceToNow(now); // 60Hz sim timer fire
      now += frameMs / 2;
      serverWorld.applyCommand(pilot.id, command, now); // 60Hz client input
    }

    const ticks = serverWorld.currentTick - startTick;
    expect(ticks).toBeGreaterThanOrEqual(54);
    expect(ticks).toBeLessThanOrEqual(72);
  });

  test("deploys a hidden player HAB that persists in shared world visibility", async () => {
    const owner = await createPilot("Verifier Builder");
    const observer = await createPilot("Verifier Observer");
    moveShipDeep(owner.id);

    const buildResponse = typed<{
      result: {
        structure: { id: string; ownerPilotId: string; hidden: boolean; discovered: boolean };
        credits: number;
      };
    }>(
      await requireWorld().app.request(`/api/ships/${owner.id}/bases`, {
        method: "POST",
        body: JSON.stringify({ name: "Verifier Cold HAB", hidden: true }),
        headers: { "Content-Type": "application/json" },
      }),
    );
    const buildPayload = await buildResponse.json();
    expect(buildPayload.result.structure.ownerPilotId).toBe(owner.id);
    expect(buildPayload.result.structure.hidden).toBe(true);
    expect(buildPayload.result.credits).toBe(500);

    const ownerSnapshotResponse = await requireWorld().app.request(
      `/api/world?pilotId=${owner.id}`,
    );
    const ownerSnapshot = (await ownerSnapshotResponse.json()) as SnapshotProbe;
    expect(
      ownerSnapshot.structures.some(
        (structure) => structure.id === buildPayload.result.structure.id && structure.discovered,
      ),
    ).toBe(true);

    const observerSnapshotResponse = await requireWorld().app.request(
      `/api/world?pilotId=${observer.id}`,
    );
    const observerSnapshot = (await observerSnapshotResponse.json()) as SnapshotProbe;
    const observerHab = observerSnapshot.structures.find(
      (structure) => structure.id === buildPayload.result.structure.id,
    );
    expect(observerHab?.discovered).toBe(false);
  });

  test("diagnoses million-scale virtual asteroid index without materializing the field", async () => {
    const pilot = await createPilot("Verifier Scale");
    const response = typed<{
      diagnostic: {
        totalAsteroids: number;
        indexKind: string;
        cellsVisited: number;
        materializedAsteroids: number;
        hits: unknown[];
      };
    }>(
      await requireWorld().app.request(
        `/api/ships/${pilot.id}/field-diagnostic?radius=52000&limit=16`,
      ),
    );
    const payload = await response.json();

    expect(payload.diagnostic.totalAsteroids).toBe(1_000_000);
    expect(payload.diagnostic.indexKind).toBe("cubicCellHierarchy");
    expect(payload.diagnostic.cellsVisited).toBeLessThan(1_000_000);
    expect(payload.diagnostic.materializedAsteroids).toBeLessThan(10_000);
    expect(payload.diagnostic.hits.length).toBeGreaterThan(0);

    const snapshotResponse = await requireWorld().app.request(`/api/world?pilotId=${pilot.id}`);
    const snapshot = (await snapshotResponse.json()) as SnapshotProbe;
    expect(snapshot.field.totalAsteroids).toBe(1_000_000);
    expect(snapshot.asteroids.length).toBeLessThanOrEqual(30 + snapshot.field.renderedLimit);
  });

  test("persists pilots, wallets, and chat after reopening sqlite storage", async () => {
    const directory = mkdtempSync(join(tmpdir(), "haystack-persist-"));
    const path = join(directory, "world.sqlite");
    try {
      const db = openDatabase(path);
      const app = createApp({ db });
      const response = typed<{ pilot: { id: string } }>(
        await app.request("/api/pilots", {
          method: "POST",
          body: JSON.stringify({ callsign: "Verifier Durable" }),
          headers: { "Content-Type": "application/json" },
        }),
      );
      const pilot = (await response.json()).pilot;
      await app.request("/api/chat", {
        method: "POST",
        body: JSON.stringify({
          channel: "global",
          fromPilotId: pilot.id,
          body: "persist me",
        }),
        headers: { "Content-Type": "application/json" },
      });
      db.close();

      const reopened = openDatabase(path);
      const reopenedApp = createApp({ db: reopened });
      const snapshotResponse = await reopenedApp.request(`/api/world?pilotId=${pilot.id}`);
      const snapshot = (await snapshotResponse.json()) as SnapshotProbe;
      expect(snapshot.me?.callsign).toBe("Verifier Durable");
      expect(snapshot.me?.credits).toBe(1000);
      expect(snapshot.chat.some((message) => message.body === "persist me")).toBe(true);
      reopened.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

async function createPilot(
  callsign: string,
  organization?: string,
): Promise<{ id: string; callsign: string }> {
  const body =
    organization === undefined
      ? { callsign }
      : {
          callsign,
          organization,
        };
  const response = typed<{ pilot: { id: string; callsign: string } }>(
    await requireWorld().app.request("/api/pilots", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    }),
  );
  const payload = await response.json();
  return payload.pilot;
}

async function scan(
  pilotId: string,
  request: { mode: string; targetAsteroidId?: string },
): Promise<{
  report: {
    hits: Array<{
      kind: string;
    }>;
  };
}> {
  const response = typed<{
    report: {
      hits: Array<{
        kind: string;
      }>;
    };
  }>(
    await requireWorld().app.request(`/api/ships/${pilotId}/scan`, {
      method: "POST",
      body: JSON.stringify(request),
      headers: { "Content-Type": "application/json" },
    }),
  );
  return response.json();
}

function firstAsteroid(): { id: string; x: number; y: number; z: number; radius: number } {
  const row = requireWorld()
    .db.query("SELECT id, x, y, z, radius FROM asteroids ORDER BY id ASC LIMIT 1")
    .get() as { id: string; x: number; y: number; z: number; radius: number } | null;
  if (row === null) {
    throw new Error("Expected seeded asteroid.");
  }
  return row;
}

function firstDeposit(asteroidId: string): { id: string } {
  const row = requireWorld()
    .db.query("SELECT id FROM deposits WHERE asteroid_id = ? ORDER BY id ASC LIMIT 1")
    .get(asteroidId) as { id: string } | null;
  if (row === null) {
    throw new Error("Expected seeded deposit.");
  }
  return row;
}

function moveShipNear(pilotId: string, asteroidId: string): void {
  const asteroid = requireWorld()
    .db.query("SELECT x, y, z, radius FROM asteroids WHERE id = ?")
    .get(asteroidId) as { x: number; y: number; z: number; radius: number } | null;
  if (asteroid === null) {
    throw new Error("Expected asteroid.");
  }
  requireWorld()
    .db.query("UPDATE ships SET x = ?, y = ?, z = ?, vx = 0, vy = 0, vz = 0 WHERE pilot_id = ?")
    .run(asteroid.x + asteroid.radius + 40, asteroid.y, asteroid.z, pilotId);
}

function moveShipToStation(pilotId: string): void {
  requireWorld()
    .db.query("UPDATE ships SET x = ?, y = ?, z = ?, vx = 0, vy = 0, vz = 0 WHERE pilot_id = ?")
    .run(-7100, 20, 250, pilotId);
}

function moveShipDeep(pilotId: string): void {
  requireWorld()
    .db.query("UPDATE ships SET x = ?, y = ?, z = ?, vx = 0, vy = 0, vz = 0 WHERE pilot_id = ?")
    .run(76000, -3200, -41000, pilotId);
}

function vectorMagnitude(vector: { x: number; y: number; z: number }): number {
  return Math.sqrt(vector.x * vector.x + vector.y * vector.y + vector.z * vector.z);
}

function requireWorld(): TestWorld {
  if (world === null) {
    throw new Error("Test world was not initialized.");
  }
  return world;
}

function typed<T>(response: Response): JsonResponse<T> {
  return response as JsonResponse<T>;
}

async function runCliCommand(argv: string[]): Promise<unknown> {
  const proc = Bun.spawn(["bun", "src/cli/main.ts", ...argv], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`CLI failed: bun src/cli/main.ts ${argv.join(" ")}\n${stdout}\n${stderr}`);
  }
  return JSON.parse(stdout) as unknown;
}

type StreamProbe = {
  socket: WebSocket;
  waitFor: (
    predicate: (message: WorldStreamServerMessage) => boolean,
  ) => Promise<WorldStreamServerMessage>;
};

async function connectWorldSocket(url: string): Promise<StreamProbe> {
  const socket = new WebSocket(url);
  const messages: WorldStreamServerMessage[] = [];
  const waiters: Array<{
    predicate: (message: WorldStreamServerMessage) => boolean;
    resolve: (message: WorldStreamServerMessage) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }> = [];

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as WorldStreamServerMessage;
    messages.push(message);
    for (const waiter of [...waiters]) {
      if (waiter.predicate(message)) {
        clearTimeout(waiter.timeout);
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(message);
      }
    }
  });
  socket.addEventListener("error", () => {
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timeout);
      waiter.reject(new Error("WebSocket stream failed."));
    }
  });

  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("WebSocket failed to open.")), {
      once: true,
    });
  });

  return {
    socket,
    waitFor: (predicate: (message: WorldStreamServerMessage) => boolean) => {
      const existing = messages.find(predicate);
      if (existing !== undefined) {
        return Promise.resolve(existing);
      }
      return new Promise<WorldStreamServerMessage>((resolve, reject) => {
        const timeout = setTimeout(() => {
          const index = waiters.findIndex((waiter) => waiter.reject === reject);
          if (index >= 0) {
            waiters.splice(index, 1);
          }
          reject(new Error("Timed out waiting for world stream message."));
        }, 5000);
        waiters.push({
          predicate,
          resolve,
          reject,
          timeout,
        });
      });
    },
  };
}
