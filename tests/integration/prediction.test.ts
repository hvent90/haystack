import { describe, expect, test } from "bun:test";

import { OwnedShipPrediction } from "../../src/client/eve/prediction";
import {
  applyShipCommandForPrediction,
  autoRotationStabilizerThresholdRadians,
} from "../../src/shared/ship-motion";
import type { FlightInputCommand, Ship } from "../../src/shared/types";

const thrustForward: FlightInputCommand = {
  kind: "flight",
  throttle: 1,
  cruiseLock: false,
  active: true,
  strafe: { x: 0, y: 0, z: 0 },
  rotation: { x: 0, y: 0, z: 0 },
};

describe("owned ship prediction", () => {
  test("stamps local input with client prediction ticks", () => {
    const prediction = new OwnedShipPrediction();
    prediction.reset(baseShip());

    const first = prediction.predict(thrustForward);
    const second = prediction.predict(thrustForward);

    expect(first?.clientTick).toBe(1);
    expect(second?.clientTick).toBe(2);
    expect(prediction.currentPredictionTick).toBe(2);
    expect(prediction.bufferedInputCount).toBe(2);
    expect(second?.ship.position.z).toBeLessThan(first?.ship.position.z ?? 0);
  });

  test("accepts matching ACKs without hard-overwriting the current predicted state", () => {
    const prediction = new OwnedShipPrediction();
    const ship = baseShip();
    prediction.reset(ship);

    const first = prediction.predict(thrustForward);
    const second = prediction.predict(thrustForward);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();

    const outcome = prediction.reconcile(first!.clientTick, first!.ship);

    expect(outcome.accepted).toBe(true);
    expect(outcome.corrected).toBe(false);
    expect(outcome.droppedInputs).toBe(1);
    expect(prediction.bufferedInputCount).toBe(1);
    expect(outcome.ship.position.z).toBeCloseTo(second!.ship.position.z, 6);
    expect(outcome.ship.position.z).not.toBeCloseTo(first!.ship.position.z, 6);
  });

  test("drops acknowledged inputs when prediction matches", () => {
    const prediction = new OwnedShipPrediction();
    prediction.reset(baseShip());

    const first = prediction.predict(thrustForward)!;
    const second = prediction.predict(thrustForward)!;
    const third = prediction.predict(thrustForward)!;

    const outcome = prediction.reconcile(second.clientTick, second.ship);

    expect(outcome.accepted).toBe(true);
    expect(outcome.droppedInputs).toBe(2);
    expect(outcome.replayedInputs).toBe(1);
    expect(prediction.bufferedInputCount).toBe(1);
    expect(outcome.ship.position.z).toBeCloseTo(third.ship.position.z, 6);
    expect(prediction.lastAcknowledgedTick).toBe(second.clientTick);
    expect(first.clientTick).toBe(1);
  });

  test("rewinds to authoritative state and replays unacknowledged inputs on divergence", () => {
    const prediction = new OwnedShipPrediction();
    const ship = baseShip();
    prediction.reset(ship);

    const first = prediction.predict(thrustForward)!;
    const second = prediction.predict(thrustForward)!;
    const authoritative = {
      ...first.ship,
      position: {
        ...first.ship.position,
        x: first.ship.position.x + 8,
      },
    };

    const outcome = prediction.reconcile(first.clientTick, authoritative);
    const expected = applyShipCommandForPrediction(authoritative, thrustForward);

    expect(outcome.accepted).toBe(false);
    expect(outcome.corrected).toBe(true);
    expect(outcome.droppedInputs).toBe(1);
    expect(outcome.replayedInputs).toBe(1);
    expect(prediction.bufferedInputCount).toBe(1);
    expect(outcome.ship.position.x).toBeCloseTo(expected.position.x, 6);
    expect(outcome.ship.position.z).toBeCloseTo(expected.position.z, 6);
    expect(outcome.ship.position.x).not.toBeCloseTo(second.ship.position.x, 6);
  });

  test("delayed ACKs do not snap owned movement back to each acknowledged frame", () => {
    const prediction = new OwnedShipPrediction();
    prediction.reset(baseShip());
    const predictedFrames = Array.from({ length: 12 }, () => prediction.predict(thrustForward)!);
    const latestPredicted = predictedFrames.at(-1)!;

    for (const ack of predictedFrames.slice(0, 8)) {
      const before = prediction.currentShip!;
      const outcome = prediction.reconcile(ack.clientTick, ack.ship);
      expect(outcome.accepted).toBe(true);
      expect(outcome.corrected).toBe(false);
      expect(outcome.ship.position.z).toBeCloseTo(before.position.z, 6);
      expect(outcome.ship.position.z).toBeCloseTo(latestPredicted.ship.position.z, 6);
    }

    expect(prediction.bufferedInputCount).toBe(4);
  });

  test("auto-stabilizes sub-threshold angular drift without braking linear velocity", () => {
    const ship = {
      ...baseShip(),
      velocity: { x: 12, y: 0, z: -4 },
      angularVelocity: { x: autoRotationStabilizerThresholdRadians * 0.5, y: 0, z: 0 },
    };

    const next = applyShipCommandForPrediction(ship, {
      kind: "flight",
      throttle: 0,
      active: true,
      cruiseLock: false,
      strafe: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
    });

    expect(next.angularVelocity.x).toBe(0);
    expect(next.velocity.x).toBeCloseTo(ship.velocity.x, 6);
    expect(next.velocity.z).toBeCloseTo(ship.velocity.z, 6);
    expect(next.heat).toBe(0);
  });

  test("auto-stabilizer does not suppress intentional low-rate rotation input", () => {
    const next = applyShipCommandForPrediction(baseShip(), {
      kind: "flight",
      throttle: 0,
      active: true,
      cruiseLock: false,
      strafe: { x: 0, y: 0, z: 0 },
      rotation: { x: 0.1, y: 0, z: 0 },
    });

    expect(next.angularVelocity.x).toBeGreaterThan(0);
    expect(next.angularVelocity.x).toBeLessThan(autoRotationStabilizerThresholdRadians);
  });

  test("auto-stabilizes sub-threshold angular drift under tiny corrective input", () => {
    const ship = {
      ...baseShip(),
      angularVelocity: { x: autoRotationStabilizerThresholdRadians * 0.5, y: 0, z: 0 },
    };

    const next = applyShipCommandForPrediction(ship, {
      kind: "flight",
      throttle: 0,
      active: true,
      cruiseLock: false,
      strafe: { x: 0, y: 0, z: 0 },
      rotation: { x: -0.001, y: 0, z: 0 },
    });

    expect(next.angularVelocity.x).toBe(0);
  });
});

function baseShip(): Ship {
  return {
    pilotId: "pilot-owned",
    name: "Owned Brickrunner",
    position: { x: -7100, y: 20, z: 250 },
    velocity: { x: 0, y: 0, z: 0 },
    orientation: { x: 0, y: 0, z: 0, w: 1 },
    angularVelocity: { x: 0, y: 0, z: 0 },
    throttle: 0,
    cruiseLock: false,
    heat: 0,
    cargoMass: 0,
    cargoCapacity: 180,
    scanPower: 1,
    miningPower: 22,
    stabilizerEfficiency: 0.42,
  };
}
