import type {
  Ship,
  ThrustCommand,
  FlightInputCommand,
  WorldSnapshot,
  Vector3,
} from "../../shared/types";
import { applyShipCommandForPrediction, cloneShip } from "../../shared/ship-motion";

export type OwnedShipCommand = ThrustCommand | FlightInputCommand;

export type PredictionBufferEntry = {
  clientTick: number;
  command: OwnedShipCommand;
  postState: Ship;
};

export type ReconcileOutcome = {
  ship: Ship;
  accepted: boolean;
  corrected: boolean;
  droppedInputs: number;
  replayedInputs: number;
};

const positionToleranceMeters = 1.25;
const velocityToleranceMetersPerSecond = 1.25;
const angularVelocityTolerance = 0.08;
const rotationToleranceRadians = 0.04;
const maxBufferEntries = 240;

export class OwnedShipPrediction {
  private ship: Ship | null = null;
  private readonly inputBuffer: PredictionBufferEntry[] = [];
  private predictionTick = 0;
  private lastAckTick = 0;

  get currentPredictionTick(): number {
    return this.predictionTick;
  }

  get bufferedInputCount(): number {
    return this.inputBuffer.length;
  }

  get currentShip(): Ship | null {
    return this.ship === null ? null : cloneShip(this.ship);
  }

  get lastAcknowledgedTick(): number {
    return this.lastAckTick;
  }

  reset(authoritativeShip: Ship): Ship {
    this.ship = cloneShip(authoritativeShip);
    this.inputBuffer.splice(0);
    this.predictionTick = 0;
    this.lastAckTick = 0;
    return cloneShip(authoritativeShip);
  }

  predict(command: OwnedShipCommand): { clientTick: number; ship: Ship } | null {
    if (this.ship === null) {
      return null;
    }

    const clientTick = this.predictionTick + 1;
    const postState = applyShipCommandForPrediction(this.ship, command);
    this.predictionTick = clientTick;
    this.ship = cloneShip(postState);
    this.inputBuffer.push({
      clientTick,
      command: cloneCommand(command),
      postState: cloneShip(postState),
    });
    if (this.inputBuffer.length > maxBufferEntries) {
      this.inputBuffer.splice(0, this.inputBuffer.length - maxBufferEntries);
    }

    return {
      clientTick,
      ship: cloneShip(postState),
    };
  }

  reconcile(clientTick: number, authoritativeShip: Ship): ReconcileOutcome {
    if (this.ship === null) {
      const ship = this.reset(authoritativeShip);
      this.lastAckTick = Math.max(this.lastAckTick, clientTick);
      return {
        ship,
        accepted: false,
        corrected: true,
        droppedInputs: 0,
        replayedInputs: 0,
      };
    }

    if (clientTick <= this.lastAckTick) {
      return {
        ship: cloneShip(this.ship),
        accepted: true,
        corrected: false,
        droppedInputs: 0,
        replayedInputs: this.inputBuffer.length,
      };
    }

    const entryIndex = this.inputBuffer.findIndex((entry) => entry.clientTick === clientTick);
    if (entryIndex < 0) {
      this.inputBuffer.splice(0);
      this.ship = cloneShip(authoritativeShip);
      this.lastAckTick = clientTick;
      return {
        ship: cloneShip(this.ship),
        accepted: false,
        corrected: true,
        droppedInputs: 0,
        replayedInputs: 0,
      };
    }

    const ackedEntry = this.inputBuffer[entryIndex]!;
    const droppedInputs = entryIndex + 1;
    if (shipsWithinTolerance(ackedEntry.postState, authoritativeShip)) {
      this.inputBuffer.splice(0, droppedInputs);
      this.lastAckTick = clientTick;
      return {
        ship: cloneShip(this.ship),
        accepted: true,
        corrected: false,
        droppedInputs,
        replayedInputs: this.inputBuffer.length,
      };
    }

    const remaining = this.inputBuffer.slice(entryIndex + 1);
    let replayState = cloneShip(authoritativeShip);
    for (const entry of remaining) {
      replayState = applyShipCommandForPrediction(replayState, entry.command);
      entry.postState = cloneShip(replayState);
    }

    this.inputBuffer.splice(0, this.inputBuffer.length, ...remaining);
    this.ship = replayState;
    this.lastAckTick = clientTick;
    return {
      ship: cloneShip(this.ship),
      accepted: false,
      corrected: true,
      droppedInputs,
      replayedInputs: remaining.length,
    };
  }
}

export function mergeWorldSnapshotForOwnedPrediction(
  current: WorldSnapshot | null,
  incoming: WorldSnapshot,
  pilotId: string,
  predictedShip: Ship | null,
): WorldSnapshot {
  const stabilized = preserveStaticWorldArrays(current, incoming);
  if (predictedShip === null) {
    return stabilized;
  }
  const shipFromCurrent = current?.ships.find((ship) => ship.pilotId === pilotId) ?? null;
  const ownedShip = mergeNonMotionShipFields(
    predictedShip,
    stabilized.ships.find((ship) => ship.pilotId === pilotId) ?? shipFromCurrent,
  );
  return replaceOwnedShip(stabilized, pilotId, ownedShip);
}

// The 4s HTTP poll re-fetches the whole world, producing fresh array references for
// the static fields (asteroids, structures) even when their content is unchanged.
// Reuse the prior reference when the render-relevant content (id + discovered) is
// identical so identity-based memos downstream — notably the instanced asteroid
// field's matrix rebuild — don't fire on every poll. The 30Hz delta path already
// preserves these refs via {...current, ...patch} (hash-gated server-side); this
// gives the poll path the same stability.
function preserveStaticWorldArrays(
  current: WorldSnapshot | null,
  incoming: WorldSnapshot,
): WorldSnapshot {
  if (current === null) {
    return incoming;
  }
  const asteroids = sameDiscoverableSet(current.asteroids, incoming.asteroids)
    ? current.asteroids
    : incoming.asteroids;
  const structures = sameDiscoverableSet(current.structures, incoming.structures)
    ? current.structures
    : incoming.structures;
  if (asteroids === incoming.asteroids && structures === incoming.structures) {
    return incoming;
  }
  return { ...incoming, asteroids, structures };
}

// Cheap equality on the only fields that change the rendered/overview set: identity
// and discovery. Positions/radii are static per id (deterministic field / DB rows),
// so id + discovered fully captures any change that affects the rendered field.
function sameDiscoverableSet(
  a: ReadonlyArray<{ id: string; discovered: boolean }>,
  b: ReadonlyArray<{ id: string; discovered: boolean }>,
): boolean {
  if (a === b) {
    return true;
  }
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    if (x === undefined || y === undefined || x.id !== y.id || x.discovered !== y.discovered) {
      return false;
    }
  }
  return true;
}

export function mergeWorldPatchForOwnedPrediction(
  current: WorldSnapshot,
  patch: Partial<WorldSnapshot>,
  pilotId: string,
  predictedShip: Ship | null,
): WorldSnapshot {
  const merged = { ...current, ...patch };
  if (patch.ships === undefined || predictedShip === null) {
    return merged;
  }
  const authoritativeOwned = patch.ships.find((ship) => ship.pilotId === pilotId) ?? null;
  const ownedShip = mergeNonMotionShipFields(predictedShip, authoritativeOwned);
  return replaceOwnedShip(merged, pilotId, ownedShip);
}

export function replaceOwnedShip(
  snapshot: WorldSnapshot,
  pilotId: string,
  ship: Ship,
): WorldSnapshot {
  return {
    ...snapshot,
    ships: snapshot.ships.map((candidate) => (candidate.pilotId === pilotId ? ship : candidate)),
  };
}

function mergeNonMotionShipFields(predictedShip: Ship, authoritativeShip: Ship | null): Ship {
  if (authoritativeShip === null) {
    return cloneShip(predictedShip);
  }
  return {
    ...authoritativeShip,
    position: cloneVector(predictedShip.position),
    velocity: cloneVector(predictedShip.velocity),
    orientation: { ...predictedShip.orientation },
    angularVelocity: cloneVector(predictedShip.angularVelocity),
    throttle: predictedShip.throttle,
    cruiseLock: predictedShip.cruiseLock,
  };
}

function shipsWithinTolerance(predicted: Ship, authoritative: Ship): boolean {
  return (
    distance(predicted.position, authoritative.position) <= positionToleranceMeters &&
    distance(predicted.velocity, authoritative.velocity) <= velocityToleranceMetersPerSecond &&
    distance(predicted.angularVelocity, authoritative.angularVelocity) <=
      angularVelocityTolerance &&
    quaternionAngle(predicted.orientation, authoritative.orientation) <= rotationToleranceRadians
  );
}

function quaternionAngle(
  left: { x: number; y: number; z: number; w: number },
  right: { x: number; y: number; z: number; w: number },
): number {
  const dot = Math.abs(left.x * right.x + left.y * right.y + left.z * right.z + left.w * right.w);
  return Math.acos(Math.min(1, Math.max(-1, dot))) * 2;
}

function distance(left: Vector3, right: Vector3): number {
  return Math.sqrt(
    (left.x - right.x) * (left.x - right.x) +
      (left.y - right.y) * (left.y - right.y) +
      (left.z - right.z) * (left.z - right.z),
  );
}

function cloneVector(vector: Vector3): Vector3 {
  return {
    x: vector.x,
    y: vector.y,
    z: vector.z,
  };
}

function cloneCommand(command: OwnedShipCommand): OwnedShipCommand {
  if ("impulse" in command) {
    return {
      ...command,
      impulse: cloneVector(command.impulse),
      ...(command.angularImpulse === undefined
        ? {}
        : { angularImpulse: cloneVector(command.angularImpulse) }),
    };
  }
  return {
    ...command,
    strafe: cloneVector(command.strafe),
    rotation: cloneVector(command.rotation),
  };
}
