import type { FlightInputCommand, Quaternion, Ship, ThrustCommand, Vector3 } from "./types";

export const shipFixedDt = 1 / 60;
export const shipInputFreshSeconds = 0.3;
export const autoRotationStabilizerThresholdRadians = (0.2 * Math.PI) / 180;

const mainAcceleration = 34;
const lateralAcceleration = 90;
const verticalAcceleration = 70;
const cruiseAcceleration = 42;
const cruiseSpeed = 220;
const boostImpulse = 12;
const linearThrusterHeatPerImpulse = 0.16;
const angularThrusterHeatPerImpulse = 0.8;
const angularAcceleration: Vector3 = { x: 1.65, y: 0.95, z: 2.3 };
export const shipMaxAngularRate: Vector3 = { x: 1.15, y: 0.72, z: 1.55 };
const rotationInputEpsilon = 0.0001;

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
  const navLightsOn = command.navLights ?? nextShip.navLightsOn;
  const flashlightOn = command.flashlight ?? nextShip.flashlightOn;
  nextShip = {
    ...nextShip,
    throttle,
    cruiseLock,
    navLightsOn,
    flashlightOn,
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
    heat: addThrusterHeat(ship.heat, impulse, angularImpulse),
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
  } else {
    nextShip = applyAutoRotationStabilizer(nextShip, zeroVector(), nextShip.angularVelocity);
  }
  nextShip = integrateOrientation(nextShip, dt);
  nextShip = {
    ...nextShip,
    position: {
      x: nextShip.position.x + nextShip.velocity.x * dt,
      y: nextShip.position.y + nextShip.velocity.y * dt,
      z: nextShip.position.z + nextShip.velocity.z * dt,
    },
    heat: Math.max(0, nextShip.heat - dt * 4.25),
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
  const nextAngularVelocity = clampAngularVector({
    x: ship.angularVelocity.x + rotation.x * angularAcceleration.x * dt,
    y: ship.angularVelocity.y + rotation.y * angularAcceleration.y * dt,
    z: ship.angularVelocity.z + rotation.z * angularAcceleration.z * dt,
  });
  let nextShip = {
    ...ship,
    angularVelocity: nextAngularVelocity,
    heat: addThrusterHeat(
      ship.heat,
      zeroVector(),
      subtractVectors(nextAngularVelocity, ship.angularVelocity),
    ),
  };
  nextShip = applyAutoRotationStabilizer(nextShip, rotation, ship.angularVelocity);

  const strafe = input.strafe;
  if (nextShip.cruiseLock) {
    nextShip = integrateCruise(nextShip, dt, strafe);
  } else {
    nextShip = integrateLocalThrust(nextShip, dt, strafe, nextShip.throttle);
  }
  if (input.stabilize === true) {
    nextShip = integrateStabilizer(nextShip, dt);
  }

  return nextShip;
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
    heat: addThrusterHeat(ship.heat, localImpulse),
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
      heat: addThrusterHeat(ship.heat, correction),
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
  const dampening = 1 - ship.stabilizerEfficiency;
  const velocity = scaleVector(ship.velocity, dampening);
  const angularVelocity = scaleVector(ship.angularVelocity, dampening);
  return {
    ...ship,
    velocity,
    angularVelocity,
    heat: addThrusterHeat(
      ship.heat,
      subtractVectors(velocity, ship.velocity),
      subtractVectors(angularVelocity, ship.angularVelocity),
    ),
  };
}

function integrateStabilizer(ship: Ship, dt: number): Ship {
  const dampening = Math.max(0, 1 - ship.stabilizerEfficiency * dt * 3.2);
  const velocity = scaleVector(ship.velocity, dampening);
  const angularVelocity = scaleVector(ship.angularVelocity, dampening);
  return {
    ...ship,
    velocity,
    angularVelocity,
    heat: addThrusterHeat(
      ship.heat,
      subtractVectors(velocity, ship.velocity),
      subtractVectors(angularVelocity, ship.angularVelocity),
    ),
  };
}

function applyAutoRotationStabilizer(
  ship: Ship,
  rotationInput: Vector3,
  previousAngularVelocity: Vector3,
): Ship {
  if (!shouldAutoStabilizeRotation(ship.angularVelocity, rotationInput, previousAngularVelocity)) {
    return ship;
  }
  return {
    ...ship,
    angularVelocity: zeroVector(),
  };
}

function shouldAutoStabilizeRotation(
  angularVelocity: Vector3,
  rotationInput: Vector3,
  previousAngularVelocity: Vector3,
): boolean {
  const angularSpeed = length(angularVelocity);
  if (angularSpeed > autoRotationStabilizerThresholdRadians) {
    return false;
  }

  const inputMagnitude = length(rotationInput);
  if (inputMagnitude <= rotationInputEpsilon) {
    return true;
  }

  return dotVectors(previousAngularVelocity, rotationInput) < 0;
}

function applyBoost(ship: Ship): Ship {
  if (ship.heat >= 96) {
    return ship;
  }
  const worldImpulse = rotateVectorByQuaternion({ x: 0, y: 0, z: -boostImpulse }, ship.orientation);
  return {
    ...ship,
    velocity: addVectors(ship.velocity, worldImpulse),
    heat: addThrusterHeat(ship.heat, { x: 0, y: 0, z: -boostImpulse }),
  };
}

function addThrusterHeat(
  heat: number,
  linearImpulse: Vector3,
  angularImpulse = zeroVector(),
): number {
  const heatAdded =
    length(linearImpulse) * linearThrusterHeatPerImpulse +
    length(angularImpulse) * angularThrusterHeatPerImpulse;
  if (heatAdded <= 0) {
    return heat;
  }
  return Math.min(100, heat + heatAdded);
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

function dotVectors(left: Vector3, right: Vector3): number {
  return left.x * right.x + left.y * right.y + left.z * right.z;
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
    x: clamp(vector.x, -shipMaxAngularRate.x, shipMaxAngularRate.x),
    y: clamp(vector.y, -shipMaxAngularRate.y, shipMaxAngularRate.y),
    z: clamp(vector.z, -shipMaxAngularRate.z, shipMaxAngularRate.z),
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
