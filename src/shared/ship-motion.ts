import type { FlightInputCommand, Quaternion, Ship, ThrustCommand, Vector3 } from "./types";

export const shipFixedDt = 1 / 60;
export const shipInputFreshSeconds = 0.3;

const mainAcceleration = 34;
const lateralAcceleration = 18;
const verticalAcceleration = 14;
const cruiseAcceleration = 42;
const cruiseSpeed = 220;
const boostImpulse = 12;
const angularAcceleration: Vector3 = { x: 1.65, y: 0.95, z: 2.3 };
const maxAngularRate: Vector3 = { x: 1.15, y: 0.72, z: 1.55 };

export type HeldFlightInput = FlightInputCommand & {
  active: true;
};

export type FlightInputReceipt = {
  ship: Ship;
  heldInput: HeldFlightInput | null;
  inputFreshFor: number;
};

export function cloneShip(ship: Ship): Ship {
  return {
    ...ship,
    position: cloneVector(ship.position),
    velocity: cloneVector(ship.velocity),
    orientation: cloneQuaternion(ship.orientation),
    angularVelocity: cloneVector(ship.angularVelocity),
  };
}

export function receiveFlightInput(ship: Ship, command: FlightInputCommand): FlightInputReceipt {
  let nextShip = cloneShip(ship);
  const throttle = clamp(command.throttle, -1, 1);
  const cruiseLock = command.cruiseLock ?? nextShip.cruiseLock;
  nextShip = {
    ...nextShip,
    throttle,
    cruiseLock,
  };

  const heldInput: HeldFlightInput | null =
    command.active === false
      ? null
      : {
          kind: "flight",
          throttle,
          strafe: clampAxes(command.strafe),
          rotation: clampAxes(command.rotation),
          active: true,
          stabilize: command.stabilize === true,
          cruiseLock,
        };

  if (command.stabilize === true && command.active === false) {
    nextShip = applyStabilizerImpulse(nextShip);
  }
  if (command.boost === true) {
    nextShip = applyBoost(nextShip);
  }

  return {
    ship: nextShip,
    heldInput,
    inputFreshFor: heldInput === null ? 0 : shipInputFreshSeconds,
  };
}

export function applyThrustCommand(ship: Ship, command: ThrustCommand): Ship {
  const impulse = clampVector(command.impulse, 12);
  const worldImpulse =
    command.frame === "local" ? rotateVectorByQuaternion(impulse, ship.orientation) : impulse;
  const angularImpulse = clampAngularVector(command.angularImpulse ?? zeroVector());
  let nextShip = {
    ...cloneShip(ship),
    velocity: addVectors(ship.velocity, worldImpulse),
    angularVelocity: clampAngularVector(addVectors(ship.angularVelocity, angularImpulse)),
    heat: Math.min(100, ship.heat + length(impulse) * 1.8 + length(angularImpulse) * 2),
  };
  if (command.stabilize === true) {
    nextShip = applyStabilizerImpulse(nextShip);
  }
  if (command.boost === true) {
    nextShip = applyBoost(nextShip);
  }
  return nextShip;
}

export function integrateShipTick(ship: Ship, dt: number, heldInput: HeldFlightInput | null): Ship {
  let nextShip = cloneShip(ship);
  if (heldInput !== null) {
    nextShip = integrateHeldInput(nextShip, dt, heldInput);
  }
  nextShip = integrateOrientation(nextShip, dt);
  nextShip = {
    ...nextShip,
    position: {
      x: nextShip.position.x + nextShip.velocity.x * dt,
      y: nextShip.position.y + nextShip.velocity.y * dt,
      z: nextShip.position.z + nextShip.velocity.z * dt,
    },
    heat: Math.max(0, nextShip.heat - dt * 0.85),
  };
  return nextShip;
}

export function applyShipCommandForPrediction(
  ship: Ship,
  command: ThrustCommand | FlightInputCommand,
  dt = shipFixedDt,
): Ship {
  if (isFlightInputCommand(command)) {
    const receipt = receiveFlightInput(ship, command);
    return integrateShipTick(receipt.ship, dt, receipt.heldInput);
  }
  return integrateShipTick(applyThrustCommand(ship, command), dt, null);
}

export function isFlightInputCommand(
  command: ThrustCommand | FlightInputCommand,
): command is FlightInputCommand {
  return "kind" in command && command.kind === "flight";
}

export function normalizeQuaternion(quaternion: Quaternion): Quaternion {
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

export function roundShip(ship: Ship): Ship {
  return {
    ...ship,
    position: roundVector(ship.position),
    velocity: roundVector(ship.velocity),
    orientation: roundQuaternion(ship.orientation),
    angularVelocity: roundVector(ship.angularVelocity),
    throttle: round(ship.throttle),
    heat: round(ship.heat),
    cargoMass: round(ship.cargoMass),
  };
}

function integrateHeldInput(ship: Ship, dt: number, input: HeldFlightInput): Ship {
  const rotation = input.rotation;
  let nextShip = {
    ...ship,
    angularVelocity: clampAngularVector({
      x: ship.angularVelocity.x + rotation.x * angularAcceleration.x * dt,
      y: ship.angularVelocity.y + rotation.y * angularAcceleration.y * dt,
      z: ship.angularVelocity.z + rotation.z * angularAcceleration.z * dt,
    }),
  };

  const strafe = input.strafe;
  if (nextShip.cruiseLock) {
    nextShip = integrateCruise(nextShip, dt, strafe);
  } else {
    nextShip = integrateLocalThrust(nextShip, dt, strafe, nextShip.throttle);
  }
  if (input.stabilize === true) {
    nextShip = integrateStabilizer(nextShip, dt);
  }

  const angularLoad =
    Math.abs(rotation.x) * angularAcceleration.x +
    Math.abs(rotation.y) * angularAcceleration.y +
    Math.abs(rotation.z) * angularAcceleration.z;
  return {
    ...nextShip,
    heat: Math.min(100, nextShip.heat + angularLoad * dt * 0.8),
  };
}

function integrateLocalThrust(ship: Ship, dt: number, strafe: Vector3, throttle: number): Ship {
  const localImpulse = {
    x: strafe.x * lateralAcceleration * dt,
    y: strafe.y * verticalAcceleration * dt,
    z: (-throttle * mainAcceleration + strafe.z * lateralAcceleration) * dt,
  };
  if (length(localImpulse) <= 0) {
    return ship;
  }
  const worldImpulse = rotateVectorByQuaternion(localImpulse, ship.orientation);
  return {
    ...ship,
    velocity: addVectors(ship.velocity, worldImpulse),
    heat: Math.min(100, ship.heat + length(localImpulse) * 1.8),
  };
}

function integrateCruise(ship: Ship, dt: number, strafe: Vector3): Ship {
  if (ship.heat >= 96) {
    return {
      ...ship,
      cruiseLock: false,
    };
  }
  const forward = rotateVectorByQuaternion({ x: 0, y: 0, z: -1 }, ship.orientation);
  const targetVelocity = scaleVector(forward, ship.throttle * cruiseSpeed);
  const correction = clampVector(
    subtractVectors(targetVelocity, ship.velocity),
    cruiseAcceleration * dt,
  );
  return integrateLocalThrust(
    {
      ...ship,
      velocity: addVectors(ship.velocity, correction),
      heat: Math.min(100, ship.heat + length(correction) * 0.8 + dt * 4),
    },
    dt,
    strafe,
    0,
  );
}

function integrateOrientation(ship: Ship, dt: number): Ship {
  const angularSpeed = length(ship.angularVelocity);
  if (angularSpeed <= 0.000001) {
    return ship;
  }
  const delta = quaternionFromAxisAngle(
    scaleVector(ship.angularVelocity, 1 / angularSpeed),
    angularSpeed * dt,
  );
  return {
    ...ship,
    orientation: normalizeQuaternion(multiplyQuaternions(ship.orientation, delta)),
  };
}

function applyStabilizerImpulse(ship: Ship): Ship {
  if (ship.heat >= 96) {
    return ship;
  }
  const dampening = 1 - ship.stabilizerEfficiency;
  return {
    ...ship,
    velocity: scaleVector(ship.velocity, dampening),
    angularVelocity: scaleVector(ship.angularVelocity, dampening),
    heat: Math.min(100, ship.heat + 18),
  };
}

function integrateStabilizer(ship: Ship, dt: number): Ship {
  if (ship.heat >= 96) {
    return ship;
  }
  const linearSpeed = length(ship.velocity);
  const angularSpeed = length(ship.angularVelocity);
  const dampening = Math.max(0, 1 - ship.stabilizerEfficiency * dt * 3.2);
  return {
    ...ship,
    velocity: scaleVector(ship.velocity, dampening),
    angularVelocity: scaleVector(ship.angularVelocity, dampening),
    heat: Math.min(100, ship.heat + dt * (4 + linearSpeed * 0.012 + angularSpeed * 1.8)),
  };
}

function applyBoost(ship: Ship): Ship {
  if (ship.heat >= 96) {
    return ship;
  }
  const worldImpulse = rotateVectorByQuaternion({ x: 0, y: 0, z: -boostImpulse }, ship.orientation);
  return {
    ...ship,
    velocity: addVectors(ship.velocity, worldImpulse),
    heat: Math.min(100, ship.heat + 24),
  };
}

function zeroVector(): Vector3 {
  return { x: 0, y: 0, z: 0 };
}

function cloneVector(vector: Vector3): Vector3 {
  return {
    x: vector.x,
    y: vector.y,
    z: vector.z,
  };
}

function cloneQuaternion(quaternion: Quaternion): Quaternion {
  return {
    x: quaternion.x,
    y: quaternion.y,
    z: quaternion.z,
    w: quaternion.w,
  };
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

function clampVector(vector: Vector3, maxLength: number): Vector3 {
  const magnitude = length(vector);
  if (magnitude <= maxLength) {
    return vector;
  }
  const scale = maxLength / magnitude;
  return {
    x: vector.x * scale,
    y: vector.y * scale,
    z: vector.z * scale,
  };
}

function clampAxes(vector: Vector3): Vector3 {
  return {
    x: clamp(vector.x, -1, 1),
    y: clamp(vector.y, -1, 1),
    z: clamp(vector.z, -1, 1),
  };
}

function clampAngularVector(vector: Vector3): Vector3 {
  return {
    x: clamp(vector.x, -maxAngularRate.x, maxAngularRate.x),
    y: clamp(vector.y, -maxAngularRate.y, maxAngularRate.y),
    z: clamp(vector.z, -maxAngularRate.z, maxAngularRate.z),
  };
}

function length(vector: Vector3): number {
  return Math.sqrt(vector.x * vector.x + vector.y * vector.y + vector.z * vector.z);
}

function quaternionFromAxisAngle(axis: Vector3, angle: number): Quaternion {
  const halfAngle = angle / 2;
  const scale = Math.sin(halfAngle);
  return normalizeQuaternion({
    x: axis.x * scale,
    y: axis.y * scale,
    z: axis.z * scale,
    w: Math.cos(halfAngle),
  });
}

function multiplyQuaternions(left: Quaternion, right: Quaternion): Quaternion {
  return {
    x: left.w * right.x + left.x * right.w + left.y * right.z - left.z * right.y,
    y: left.w * right.y - left.x * right.z + left.y * right.w + left.z * right.x,
    z: left.w * right.z + left.x * right.y - left.y * right.x + left.z * right.w,
    w: left.w * right.w - left.x * right.x - left.y * right.y - left.z * right.z,
  };
}

function rotateVectorByQuaternion(vector: Vector3, quaternion: Quaternion): Vector3 {
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

function roundVector(vector: Vector3): Vector3 {
  return {
    x: round(vector.x),
    y: round(vector.y),
    z: round(vector.z),
  };
}

function roundQuaternion(quaternion: Quaternion): Quaternion {
  const normalized = normalizeQuaternion(quaternion);
  return {
    x: round(normalized.x),
    y: round(normalized.y),
    z: round(normalized.z),
    w: round(normalized.w),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
