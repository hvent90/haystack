// Regression guard for the owned-ship jerk root cause: the client predictor must
// advance by ELAPSED WALL TIME, not by how often the input timer fires.
//
// The owned ship uses client-side prediction + server reconciliation. The server
// integrates physics on an elapsed-time accumulator (~60 fixed steps/wall-second,
// world.ts:340-405). If the client advances prediction by a fixed COUNT (one step
// per input-timer fire) and that timer is starved below 60Hz by main-thread
// contention, the client predicts fewer steps/wall-second than the server, the
// predicted pose lags the authoritative pose, and every ack snaps it forward — the
// visible jerk. Driving prediction by elapsed time (a fixed-step accumulator, the
// production fix in EveApp's input timer) keeps the counts matched at any fire rate.
//
// This drives the REAL ServerWorld and the REAL OwnedShipPrediction with simulated
// wall time and asserts: step-count cadence under a starved timer produces many
// reconcile corrections; elapsed-time cadence produces essentially none.

import { afterEach, describe, expect, test } from "bun:test";

import { openDatabase, type HaystackDb } from "../../src/server/db";
import { createPilot } from "../../src/server/sim";
import { getServerWorld } from "../../src/server/world";
import { OwnedShipPrediction } from "../../src/client/eve/prediction";
import { shipFixedDt } from "../../src/shared/ship-motion";
import type { FlightInputCommand, Ship } from "../../src/shared/types";

const dt = shipFixedDt;

// Steady "fly forward and yaw" — exercises both translation and rotation.
const command: FlightInputCommand = {
  kind: "flight",
  throttle: 1,
  strafe: { x: 0, y: 0, z: 0 },
  rotation: { x: 0, y: 1, z: 0 },
  active: true,
};

let openDb: HaystackDb | null = null;
afterEach(() => {
  openDb?.close();
  openDb = null;
});

function readShip(db: HaystackDb, pilotId: string): Ship {
  const row = db.query("SELECT * FROM ships WHERE pilot_id = ?").get(pilotId) as Record<
    string,
    number | string
  >;
  return {
    pilotId: String(row["pilot_id"]),
    name: String(row["name"]),
    position: { x: Number(row["x"]), y: Number(row["y"]), z: Number(row["z"]) },
    velocity: { x: Number(row["vx"]), y: Number(row["vy"]), z: Number(row["vz"]) },
    orientation: {
      x: Number(row["qx"]),
      y: Number(row["qy"]),
      z: Number(row["qz"]),
      w: Number(row["qw"]),
    },
    angularVelocity: { x: Number(row["wx"]), y: Number(row["wy"]), z: Number(row["wz"]) },
    throttle: Number(row["throttle"]),
    cruiseLock: Number(row["cruise_lock"]) === 1,
    navLightsOn: Number(row["nav_lights"]) === 1,
    flashlightOn: Number(row["flashlight"]) === 1,
    heat: Number(row["heat"]),
    cargoMass: Number(row["cargo_mass"]),
    cargoCapacity: Number(row["cargo_capacity"]),
    scanPower: Number(row["scan_power"]),
    miningPower: Number(row["mining_power"]),
    stabilizerEfficiency: Number(row["stabilizer_efficiency"]),
  };
}

type Outcome = { predicts: number; serverSteps: number; acks: number; corrections: number };

// Drive `wallSeconds` of simulated wall time. The server runs its 60Hz background
// loop (advanceToNow) plus a forced tick per received input (applyCommand). The
// client's input timer fires `fireHz` times/wall-second.
//   - "step-count": one predict per fire (the bug).
//   - "elapsed-time": drain a wall-clock accumulator, send+predict floor(elapsed/dt)
//     steps per fire (the fix).
function simulate(
  mode: "step-count" | "elapsed-time",
  fireHz: number,
  wallSeconds: number,
): Outcome {
  const db = openDatabase(":memory:");
  openDb = db;
  const pilot = createPilot(db, { callsign: `Cadence ${mode} ${fireHz}` });
  const world = getServerWorld(db);

  const baseMs = 1_000_000;
  world.advanceToNow(baseMs); // sync the server wall clock to t=0 (ship is at rest)

  const prediction = new OwnedShipPrediction();
  prediction.reset(readShip(db, pilot.id));

  const totalSlots = Math.round(wallSeconds * 60);
  const fireEvery = 60 / fireHz;
  const firePeriodSec = fireEvery * dt;
  let nextFireSlot = 0;
  let accumulatorSec = 0;
  let lastSentTick = 0;
  let predicts = 0;
  let acks = 0;
  let corrections = 0;

  for (let slot = 0; slot < totalSlots; slot += 1) {
    const nowMs = baseMs + (slot + 1) * dt * 1000;
    world.advanceToNow(nowMs);

    if (slot >= nextFireSlot) {
      nextFireSlot += fireEvery;
      let stepsThisFire: number;
      if (mode === "step-count") {
        stepsThisFire = 1;
      } else {
        accumulatorSec += firePeriodSec;
        stepsThisFire = Math.floor(accumulatorSec / dt + 1e-9);
        accumulatorSec -= stepsThisFire * dt;
      }
      for (let i = 0; i < stepsThisFire; i += 1) {
        world.applyCommand(pilot.id, command, nowMs);
        prediction.predict(command);
        lastSentTick = prediction.currentPredictionTick;
        predicts += 1;
      }
    }

    if (slot % 2 === 1) {
      acks += 1;
      const outcome = prediction.reconcile(lastSentTick, readShip(db, pilot.id));
      if (outcome.corrected) {
        corrections += 1;
      }
    }
  }

  return { predicts, serverSteps: world.currentTick, acks, corrections };
}

describe("owned-ship prediction cadence", () => {
  const wallSeconds = 4;

  test("step-count cadence under a starved timer lags the server and snaps on acks", () => {
    const result = simulate("step-count", 30, wallSeconds);
    // 30Hz timer => ~half the server's fixed steps are never predicted.
    expect(result.predicts).toBeLessThan(result.serverSteps * 0.6);
    // The lag exceeds tolerance on most acks — this is the jerk the owner reported.
    expect(result.corrections).toBeGreaterThan(result.acks * 0.4);
  });

  test("elapsed-time cadence keeps step counts matched at any fire rate (the fix)", () => {
    for (const fireHz of [50, 40, 30, 20]) {
      const result = simulate("elapsed-time", fireHz, wallSeconds);
      // Client predicts ~one step per server step regardless of the timer rate.
      expect(result.predicts).toBeGreaterThanOrEqual(result.serverSteps - 2);
      // With counts matched, acks accept: at most the single startup transient that
      // the uncontended 60Hz baseline also shows.
      expect(result.corrections).toBeLessThanOrEqual(2);
    }
  });

  test("uncontended 60Hz step-count cadence is already clean (baseline)", () => {
    const result = simulate("step-count", 60, wallSeconds);
    expect(result.corrections).toBeLessThanOrEqual(2);
  });
});
