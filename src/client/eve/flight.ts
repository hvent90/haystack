import type {
  FlightInputCommand,
  Quaternion,
  Ship,
  ThrustCommand,
  Vector3,
  WorldSnapshot,
} from "../../shared/types";
import { clampVector, round, vectorMagnitude } from "./vector";

const predictedFlightDt = 0.05;
const mainAcceleration = 34;
const lateralAcceleration = 18;
const verticalAcceleration = 14;
const cruiseAcceleration = 42;
const cruiseSpeed = 220;
const boostImpulse = 12;
const linearThrusterHeatPerImpulse = 0.16;
const angularThrusterHeatPerImpulse = 0.8;
const angularAcceleration: Vector3 = { x: 1.65, y: 0.95, z: 2.3 };
const maxAngularRate: Vector3 = { x: 1.15, y: 0.72, z: 1.55 };

export function isFlightKey(code: string): boolean {
  return (
    code === "KeyW" ||
    code === "KeyQ" ||
    code === "KeyE" ||
    code === "KeyA" ||
    code === "KeyS" ||
    code === "KeyD" ||
    code === "KeyZ" ||
    code === "KeyC" ||
    code === "Space" ||
    code === "ControlLeft" ||
    code === "ControlRight" ||
    code === "KeyX" ||
    code === "KeyJ" ||
    code === "Tab"
  );
}

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  const tag = target.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || target.isContentEditable;
}

export function predictFlightSnapshot(
  snapshot: WorldSnapshot,
  pilotId: string,
  command: ThrustCommand | FlightInputCommand,
): WorldSnapshot {
  return {
    ...snapshot,
    ships: snapshot.ships.map((ship) =>
      ship.pilotId === pilotId ? predictShipAfterCommand(ship, command) : ship,
    ),
  };
}

function predictShipAfterCommand(ship: Ship, command: ThrustCommand | FlightInputCommand): Ship {
  if (isFlightInputCommand(command)) {
    return predictShipAfterFlightInput(ship, command);
  }

  const impulse = clampVector(command.impulse, 12);
  const worldImpulse =
    command.frame === "local" ? rotateVectorByQuaternion(impulse, ship.orientation) : impulse;
  const angularImpulse = clampVector(command.angularImpulse ?? { x: 0, y: 0, z: 0 }, 1.55);
  const stabilization = command.stabilize === true;
  const dampening = stabilization ? 1 - ship.stabilizerEfficiency : 1;
  const velocityAfterImpulse = addVectors(ship.velocity, worldImpulse);
  const angularVelocityAfterImpulse = addVectors(ship.angularVelocity, angularImpulse);
  const velocity = scaleVector(velocityAfterImpulse, dampening);
  const angularVelocity = scaleVector(angularVelocityAfterImpulse, dampening);
  const heatAdded =
    thrusterHeat(impulse, angularImpulse) +
    (stabilization
      ? thrusterHeat(
          subtractVectors(velocity, velocityAfterImpulse),
          subtractVectors(angularVelocity, angularVelocityAfterImpulse),
        )
      : 0);
  return {
    ...ship,
    velocity: roundVector(velocity),
    angularVelocity: roundVector(angularVelocity),
    heat: round(Math.min(100, ship.heat + heatAdded)),
  };
}

function predictShipAfterFlightInput(ship: Ship, command: FlightInputCommand): Ship {
  let velocity = ship.velocity;
  let angularVelocity = ship.angularVelocity;
  let heat = ship.heat;
  let cruiseLock = command.cruiseLock ?? ship.cruiseLock;
  const active = command.active !== false;

  if (command.stabilize === true && !active) {
    const dampening = 1 - ship.stabilizerEfficiency;
    const nextVelocity = scaleVector(velocity, dampening);
    const nextAngularVelocity = scaleVector(angularVelocity, dampening);
    heat = addThrusterHeat(
      heat,
      subtractVectors(nextVelocity, velocity),
      subtractVectors(nextAngularVelocity, angularVelocity),
    );
    velocity = nextVelocity;
    angularVelocity = nextAngularVelocity;
  }

  if (command.boost === true && heat < 96) {
    velocity = addVectors(
      velocity,
      rotateVectorByQuaternion({ x: 0, y: 0, z: -boostImpulse }, ship.orientation),
    );
    heat = addThrusterHeat(heat, { x: 0, y: 0, z: -boostImpulse });
  }

  if (active) {
    const rotation = command.rotation;
    const nextAngularVelocity = clampAngularVector(
      addVectors(angularVelocity, {
        x: rotation.x * angularAcceleration.x * predictedFlightDt,
        y: rotation.y * angularAcceleration.y * predictedFlightDt,
        z: rotation.z * angularAcceleration.z * predictedFlightDt,
      }),
    );
    heat = addThrusterHeat(
      heat,
      { x: 0, y: 0, z: 0 },
      subtractVectors(nextAngularVelocity, angularVelocity),
    );
    angularVelocity = nextAngularVelocity;

    const strafe = command.strafe;
    if (cruiseLock) {
      if (heat >= 96) {
        cruiseLock = false;
      } else {
        const forward = rotateVectorByQuaternion({ x: 0, y: 0, z: -1 }, ship.orientation);
        const targetVelocity = scaleVector(forward, command.throttle * cruiseSpeed);
        const correction = clampVector(
          subtractVectors(targetVelocity, velocity),
          cruiseAcceleration * predictedFlightDt,
        );
        velocity = addVectors(velocity, correction);
        heat = addThrusterHeat(heat, correction);
      }
    } else {
      const localImpulse = {
        x: strafe.x * lateralAcceleration * predictedFlightDt,
        y: strafe.y * verticalAcceleration * predictedFlightDt,
        z:
          (-command.throttle * mainAcceleration + strafe.z * lateralAcceleration) *
          predictedFlightDt,
      };
      if (vectorMagnitude(localImpulse) > 0) {
        velocity = addVectors(velocity, rotateVectorByQuaternion(localImpulse, ship.orientation));
        heat = addThrusterHeat(heat, localImpulse);
      }
    }

    if (command.stabilize === true) {
      const dampening = Math.max(0, 1 - ship.stabilizerEfficiency * predictedFlightDt * 3.2);
      const nextVelocity = scaleVector(velocity, dampening);
      const nextAngularVelocity = scaleVector(angularVelocity, dampening);
      heat = addThrusterHeat(
        heat,
        subtractVectors(nextVelocity, velocity),
        subtractVectors(nextAngularVelocity, angularVelocity),
      );
      velocity = nextVelocity;
      angularVelocity = nextAngularVelocity;
    }
  }

  return {
    ...ship,
    velocity: roundVector(velocity),
    angularVelocity: roundVector(angularVelocity),
    throttle: round(command.throttle),
    cruiseLock,
    heat: round(heat),
  };
}

function addThrusterHeat(
  heat: number,
  linearImpulse: Vector3,
  angularImpulse = zeroVector(),
): number {
  return round(Math.min(100, heat + thrusterHeat(linearImpulse, angularImpulse)));
}

function thrusterHeat(linearImpulse: Vector3, angularImpulse = zeroVector()): number {
  return (
    vectorMagnitude(linearImpulse) * linearThrusterHeatPerImpulse +
    vectorMagnitude(angularImpulse) * angularThrusterHeatPerImpulse
  );
}

function zeroVector(): Vector3 {
  return { x: 0, y: 0, z: 0 };
}

function addVectors(left: Vector3, right: Vector3): Vector3 {
  return {
    x: left.x + right.x,
    y: left.y + right.y,
    z: left.z + right.z,
  };
}

function subtractVectors(left: Vector3, right: Vector3): Vector3 {
  return {
    x: left.x - right.x,
    y: left.y - right.y,
    z: left.z - right.z,
  };
}

function scaleVector(vector: Vector3, scale: number): Vector3 {
  return {
    x: vector.x * scale,
    y: vector.y * scale,
    z: vector.z * scale,
  };
}

function clampAngularVector(vector: Vector3): Vector3 {
  return {
    x: clamp(vector.x, -maxAngularRate.x, maxAngularRate.x),
    y: clamp(vector.y, -maxAngularRate.y, maxAngularRate.y),
    z: clamp(vector.z, -maxAngularRate.z, maxAngularRate.z),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function roundVector(vector: Vector3): Vector3 {
  return {
    x: round(vector.x),
    y: round(vector.y),
    z: round(vector.z),
  };
}

function rotateVectorByQuaternion(
  vector: { x: number; y: number; z: number },
  quaternion: Quaternion,
) {
  const normalized = normalizeQuaternion(quaternion);
  const ix = normalized.w * vector.x + normalized.y * vector.z - normalized.z * vector.y;
  const iy = normalized.w * vector.y + normalized.z * vector.x - normalized.x * vector.z;
  const iz = normalized.w * vector.z + normalized.x * vector.y - normalized.y * vector.x;
  const iw = -normalized.x * vector.x - normalized.y * vector.y - normalized.z * vector.z;

  return {
    x: ix * normalized.w + iw * -normalized.x + iy * -normalized.z - iz * -normalized.y,
    y: iy * normalized.w + iw * -normalized.y + iz * -normalized.x - ix * -normalized.z,
    z: iz * normalized.w + iw * -normalized.z + ix * -normalized.y - iy * -normalized.x,
  };
}

function normalizeQuaternion(quaternion: Quaternion): Quaternion {
  const magnitude = Math.sqrt(
    quaternion.x * quaternion.x +
      quaternion.y * quaternion.y +
      quaternion.z * quaternion.z +
      quaternion.w * quaternion.w,
  );
  if (magnitude <= 0) {
    return { x: 0, y: 0, z: 0, w: 1 };
  }
  return {
    x: quaternion.x / magnitude,
    y: quaternion.y / magnitude,
    z: quaternion.z / magnitude,
    w: quaternion.w / magnitude,
  };
}

function isFlightInputCommand(
  command: ThrustCommand | FlightInputCommand,
): command is FlightInputCommand {
  return "kind" in command && command.kind === "flight";
}
