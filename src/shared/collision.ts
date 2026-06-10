import type { FieldSummary, Ship, Vector3 } from "./types";

// Shared, deterministic ship collision: the same code resolves collisions on the server
// fixed tick (ShipActor.update) and inside client owned-ship prediction, so flying into a
// rock predicts cleanly instead of rubber-banding. Gameplay collides against rock BASE
// positions only — the GPU renderer's cosmetic per-rock offset (≤ ~250 m) is explicitly
// NOT part of gameplay (see docs/gpu-asteroids-architecture.md).
//
// The virtual-rock derivation below mirrors src/server/field.ts and
// src/client/eve/field-core.ts exactly (same hash, same noise, same placement); the
// collision integration test asserts bit-identical agreement with the client derivation
// so the three copies cannot drift silently.

// Ship collision radius in meters (world units). The remote ship mesh is a 0.08-scaled
// cone (112 m long, ~48 m base radius) — a 50 m bounding sphere matches it.
export const SHIP_COLLISION_RADIUS = 50;

// Largest possible virtual rock radius (45 + 310, see virtualRockAt) — bounds how far a
// rock's surface can reach from its center, which sizes the broad-phase cell expansion.
const MAX_ROCK_RADIUS = 355;

// Gentle bounce: a bump should feel physical, not a perfect-energy billiard hit.
const RESTITUTION = 0.2;

// Ship-ship positional separation is capped per tick so a fully-overlapped pair (e.g.
// two ships on the shared spawn point) glides apart over ~half a second instead of
// teleporting 100 m in one tick.
const MAX_PAIR_SEPARATION_PER_TICK = 4;

export type CollisionSphere = {
  id: string;
  position: Vector3;
  radius: number;
};

export type ShipCollisionEnvironment = {
  obstaclesForSegment(from: Vector3, to: Vector3): CollisionSphere[];
};

type FieldGeometry = {
  seed: number;
  cellSize: number;
  cellsPerAxis: number;
  originOffset: number;
};

// `field` null = no virtual field (seeded obstacles only; used by tests and tools).
export function makeShipCollisionEnvironment(
  field: FieldSummary | null,
  seeded: readonly CollisionSphere[],
): ShipCollisionEnvironment {
  const geometry = field === null ? null : geometryOf(field);
  // Stable processing order on both sides of the prediction (the client receives the
  // seeded set in server order, but sort defensively — response order matters when a
  // ship touches several obstacles in one tick).
  const seededSorted = [...seeded].sort((left, right) => left.id.localeCompare(right.id));
  return {
    obstaclesForSegment(from: Vector3, to: Vector3): CollisionSphere[] {
      const reach = MAX_ROCK_RADIUS + SHIP_COLLISION_RADIUS;
      const obstacles: CollisionSphere[] = [];
      if (geometry !== null) {
        const last = geometry.cellsPerAxis - 1;
        const minX = cellFloor(Math.min(from.x, to.x) - reach, geometry, last);
        const maxX = cellFloor(Math.max(from.x, to.x) + reach, geometry, last);
        const minY = cellFloor(Math.min(from.y, to.y) - reach, geometry, last);
        const maxY = cellFloor(Math.max(from.y, to.y) + reach, geometry, last);
        const minZ = cellFloor(Math.min(from.z, to.z) - reach, geometry, last);
        const maxZ = cellFloor(Math.max(from.z, to.z) + reach, geometry, last);
        for (let x = minX; x <= maxX; x += 1) {
          for (let y = minY; y <= maxY; y += 1) {
            for (let z = minZ; z <= maxZ; z += 1) {
              obstacles.push(virtualRockAt(geometry, x, y, z));
            }
          }
        }
      }
      for (const sphere of seededSorted) {
        const nearestX = clampValue(
          sphere.position.x,
          Math.min(from.x, to.x),
          Math.max(from.x, to.x),
        );
        const nearestY = clampValue(
          sphere.position.y,
          Math.min(from.y, to.y),
          Math.max(from.y, to.y),
        );
        const nearestZ = clampValue(
          sphere.position.z,
          Math.min(from.z, to.z),
          Math.max(from.z, to.z),
        );
        const reachSeeded = sphere.radius + SHIP_COLLISION_RADIUS;
        const dx = sphere.position.x - nearestX;
        const dy = sphere.position.y - nearestY;
        const dz = sphere.position.z - nearestZ;
        // Cheap conservative AABB-style filter: keep any seeded rock whose center is
        // within reach of the motion segment's bounding box.
        if (dx * dx + dy * dy + dz * dz <= reachSeeded * reachSeeded * 4) {
          obstacles.push(sphere);
        }
      }
      return obstacles;
    },
  };
}

// Resolve ship-vs-obstacle collisions for one fixed step: a swept sphere test along the
// tick's motion segment (no tunneling at any speed), then positional pushout to the
// contact distance and removal of the inward velocity component (with a gentle bounce).
// Pure and deterministic — prediction and server must produce identical results.
export function resolveShipCollision(
  previousPosition: Vector3,
  ship: Ship,
  environment: ShipCollisionEnvironment,
): Ship {
  const obstacles = environment.obstaclesForSegment(previousPosition, ship.position);
  if (obstacles.length === 0) {
    return ship;
  }

  let position = { ...ship.position };
  let velocity = { ...ship.velocity };
  let touched = false;

  // Two passes so a pushout from one rock cannot leave the ship inside a neighbor.
  for (let pass = 0; pass < 2; pass += 1) {
    for (const obstacle of obstacles) {
      const contactRadius = obstacle.radius + SHIP_COLLISION_RADIUS;

      let contact = false;
      if (pass === 0) {
        const entry = segmentSphereEntry(
          previousPosition,
          position,
          obstacle.position,
          contactRadius,
        );
        if (entry !== null) {
          position = entry;
          contact = true;
        }
      }

      const dx = position.x - obstacle.position.x;
      const dy = position.y - obstacle.position.y;
      const dz = position.z - obstacle.position.z;
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (!contact && distance >= contactRadius) {
        continue;
      }
      touched = true;
      const normal =
        distance > 1e-9
          ? { x: dx / distance, y: dy / distance, z: dz / distance }
          : { x: 1, y: 0, z: 0 };
      if (distance < contactRadius) {
        position = {
          x: obstacle.position.x + normal.x * contactRadius,
          y: obstacle.position.y + normal.y * contactRadius,
          z: obstacle.position.z + normal.z * contactRadius,
        };
      }
      const inward = velocity.x * normal.x + velocity.y * normal.y + velocity.z * normal.z;
      if (inward < 0) {
        const impulse = (1 + RESTITUTION) * inward;
        velocity = {
          x: velocity.x - normal.x * impulse,
          y: velocity.y - normal.y * impulse,
          z: velocity.z - normal.z * impulse,
        };
      }
    }
  }

  if (!touched) {
    return ship;
  }
  return { ...ship, position, velocity };
}

export type ShipPairBody = {
  position: Vector3;
  velocity: Vector3;
};

// Symmetric equal-mass ship-vs-ship response (server-authoritative; ship-ship cannot be
// predicted client-side). Returns null when the pair is not touching. The impulse fires
// only when the ships are approaching, so an overlapped-but-resting pair (shared spawn)
// separates positionally without gaining velocity.
export function resolveShipPairCollision(
  a: ShipPairBody,
  b: ShipPairBody,
): { a: ShipPairBody; b: ShipPairBody } | null {
  const contactRadius = SHIP_COLLISION_RADIUS * 2;
  const dx = b.position.x - a.position.x;
  const dy = b.position.y - a.position.y;
  const dz = b.position.z - a.position.z;
  const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (distance >= contactRadius) {
    return null;
  }

  const normal =
    distance > 1e-9
      ? { x: dx / distance, y: dy / distance, z: dz / distance }
      : { x: 1, y: 0, z: 0 };
  const separation = Math.min((contactRadius - distance) / 2, MAX_PAIR_SEPARATION_PER_TICK);

  const nextA: ShipPairBody = {
    position: {
      x: a.position.x - normal.x * separation,
      y: a.position.y - normal.y * separation,
      z: a.position.z - normal.z * separation,
    },
    velocity: { ...a.velocity },
  };
  const nextB: ShipPairBody = {
    position: {
      x: b.position.x + normal.x * separation,
      y: b.position.y + normal.y * separation,
      z: b.position.z + normal.z * separation,
    },
    velocity: { ...b.velocity },
  };

  const closing =
    (b.velocity.x - a.velocity.x) * normal.x +
    (b.velocity.y - a.velocity.y) * normal.y +
    (b.velocity.z - a.velocity.z) * normal.z;
  if (closing < 0) {
    // Equal masses: each ship takes half of the (1 + e) relative-velocity reversal.
    const impulse = ((1 + RESTITUTION) * closing) / 2;
    nextA.velocity = {
      x: nextA.velocity.x + normal.x * impulse,
      y: nextA.velocity.y + normal.y * impulse,
      z: nextA.velocity.z + normal.z * impulse,
    };
    nextB.velocity = {
      x: nextB.velocity.x - normal.x * impulse,
      y: nextB.velocity.y - normal.y * impulse,
      z: nextB.velocity.z - normal.z * impulse,
    };
  }

  return { a: nextA, b: nextB };
}

// --- deterministic virtual field mirror (see file header) ---

function geometryOf(field: FieldSummary): FieldGeometry {
  const cellsPerAxis = Math.max(1, Math.round(Math.cbrt(field.totalAsteroids)));
  return {
    seed: field.seed,
    cellSize: field.cellSize,
    cellsPerAxis,
    originOffset: -(cellsPerAxis * field.cellSize) / 2,
  };
}

function cellFloor(value: number, geometry: FieldGeometry, last: number): number {
  return Math.max(
    0,
    Math.min(last, Math.floor((value - geometry.originOffset) / geometry.cellSize)),
  );
}

function virtualRockAt(
  geometry: FieldGeometry,
  cx: number,
  cy: number,
  cz: number,
): CollisionSphere {
  const seed = geometry.seed + cx * 73856093 + cy * 19349663 + cz * 83492791;
  return {
    id: `v-${cx}-${cy}-${cz}`,
    position: {
      x: geometry.originOffset + cx * geometry.cellSize + noise(seed + 1) * geometry.cellSize,
      y: geometry.originOffset + cy * geometry.cellSize + noise(seed + 2) * geometry.cellSize,
      z: geometry.originOffset + cz * geometry.cellSize + noise(seed + 3) * geometry.cellSize,
    },
    radius: 45 + noise(seed + 5) * 310,
  };
}

function noise(seed: number): number {
  const value = Math.sin(seed * 12.9898) * 43758.5453;
  return value - Math.floor(value);
}

// Earliest point along [from, to] where a sphere of combined radius `radius` centered at
// `center` is first touched, or null when the segment never enters it (or starts inside —
// the static pushout handles that case).
function segmentSphereEntry(
  from: Vector3,
  to: Vector3,
  center: Vector3,
  radius: number,
): Vector3 | null {
  const dirX = to.x - from.x;
  const dirY = to.y - from.y;
  const dirZ = to.z - from.z;
  const lengthSquared = dirX * dirX + dirY * dirY + dirZ * dirZ;
  if (lengthSquared <= 1e-12) {
    return null;
  }
  const offsetX = from.x - center.x;
  const offsetY = from.y - center.y;
  const offsetZ = from.z - center.z;
  const startDistanceSquared = offsetX * offsetX + offsetY * offsetY + offsetZ * offsetZ;
  if (startDistanceSquared <= radius * radius) {
    return null;
  }
  const b = 2 * (offsetX * dirX + offsetY * dirY + offsetZ * dirZ);
  const c = startDistanceSquared - radius * radius;
  const discriminant = b * b - 4 * lengthSquared * c;
  if (discriminant < 0) {
    return null;
  }
  const t = (-b - Math.sqrt(discriminant)) / (2 * lengthSquared);
  if (t < 0 || t > 1) {
    return null;
  }
  return {
    x: from.x + dirX * t,
    y: from.y + dirY * t,
    z: from.z + dirZ * t,
  };
}

function clampValue(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
