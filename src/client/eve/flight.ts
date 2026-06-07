import type {
  FlightInputCommand,
  Quaternion,
  Ship,
  ThrustCommand,
  WorldSnapshot,
} from "../../shared/types";
import { clampVector, round, vectorMagnitude } from "./vector";

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
    const stabilized = command.stabilize === true && ship.heat < 96;
    const boosted = command.boost === true && ship.heat < 96;
    const dampening = stabilized ? 1 - ship.stabilizerEfficiency : 1;
    const boost = boosted
      ? rotateVectorByQuaternion({ x: 0, y: 0, z: -12 }, ship.orientation)
      : { x: 0, y: 0, z: 0 };
    return {
      ...ship,
      velocity: {
        x: round((ship.velocity.x + boost.x) * dampening),
        y: round((ship.velocity.y + boost.y) * dampening),
        z: round((ship.velocity.z + boost.z) * dampening),
      },
      angularVelocity: {
        x: round(ship.angularVelocity.x * dampening),
        y: round(ship.angularVelocity.y * dampening),
        z: round(ship.angularVelocity.z * dampening),
      },
      throttle: round(command.throttle),
      cruiseLock: command.cruiseLock ?? ship.cruiseLock,
      heat: round(Math.min(100, ship.heat + (stabilized ? 18 : 0) + (boosted ? 24 : 0))),
    };
  }

  const impulse = clampVector(command.impulse, 12);
  const worldImpulse =
    command.frame === "local" ? rotateVectorByQuaternion(impulse, ship.orientation) : impulse;
  const angularImpulse = clampVector(command.angularImpulse ?? { x: 0, y: 0, z: 0 }, 1.55);
  const stabilization = command.stabilize === true && ship.heat < 96;
  const dampening = stabilization ? 1 - ship.stabilizerEfficiency : 1;
  const heatAdded =
    vectorMagnitude(impulse) * 1.8 + vectorMagnitude(angularImpulse) * 2 + (stabilization ? 18 : 0);
  return {
    ...ship,
    velocity: {
      x: round((ship.velocity.x + worldImpulse.x) * dampening),
      y: round((ship.velocity.y + worldImpulse.y) * dampening),
      z: round((ship.velocity.z + worldImpulse.z) * dampening),
    },
    angularVelocity: {
      x: round((ship.angularVelocity.x + angularImpulse.x) * dampening),
      y: round((ship.angularVelocity.y + angularImpulse.y) * dampening),
      z: round((ship.angularVelocity.z + angularImpulse.z) * dampening),
    },
    heat: round(Math.min(100, ship.heat + heatAdded)),
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
