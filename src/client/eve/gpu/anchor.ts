// The floating FIELD ANCHOR (Saturn-scale precision, docs/asteroid-sim-impl-log.md
// "Saturn scale migration").
//
// Why: GPU buffers and uniforms are f32. At legacy belt coordinates (≤ 3.25e6 m) the f32
// ULP is ~0.25 m and absolute world meters were fine; at Saturn scale (ring coordinates up
// to ~1.5e8 m) the ULP is ~16 m — rock positions would quantize visibly, the ±40 m wobble
// would stair-step, and the per-frame `originMeters` rounding would shake the whole field
// by up to ~8 m as the ship moves.
//
// Fix: every GPU-side coordinate (`base`/`pos` buffers, originMeters, the collision
// gridOrigin, well uniforms) is stored RELATIVE to this anchor. The subtraction happens on
// the CPU in f64 BEFORE the f32 narrowing, so relative magnitudes stay ≤ ~10^5 m and the
// f32 ULP stays ≤ ~1 cm. The anchor follows the ship: when the render origin strays more
// than ANCHOR_REBASE_DISTANCE_METERS from it, the anchor re-snaps and the resident ring is
// fully rewritten under the new anchor (cheap: one 50k-slot CPU pack + upload).
//
// The anchor grid is a power of two so anchor components are exactly representable and
// differences of snapped values stay exact in f64. Gameplay/parity math NEVER reads the
// anchor — server, worker and collision all stay in absolute f64 world meters; only the
// GPU-visible image is rebased (the base-parity and ring-stream gates pin the rebased
// bytes against the same f64-derive + f64-subtract recipe).

import type { Vector3 } from "../../../shared/types";

export const ANCHOR_GRID_METERS = 65536; // 2^16
export const ANCHOR_REBASE_DISTANCE_METERS = ANCHOR_GRID_METERS * 1.5;

const anchor: Vector3 = { x: 0, y: 0, z: 0 };

export function fieldAnchor(): Readonly<Vector3> {
  return anchor;
}

export function snapAnchor(position: Vector3): Vector3 {
  return {
    x: Math.round(position.x / ANCHOR_GRID_METERS) * ANCHOR_GRID_METERS,
    y: Math.round(position.y / ANCHOR_GRID_METERS) * ANCHOR_GRID_METERS,
    z: Math.round(position.z / ANCHOR_GRID_METERS) * ANCHOR_GRID_METERS,
  };
}

export function anchorNeedsRebase(origin: Vector3): boolean {
  return (
    Math.abs(origin.x - anchor.x) > ANCHOR_REBASE_DISTANCE_METERS ||
    Math.abs(origin.y - anchor.y) > ANCHOR_REBASE_DISTANCE_METERS ||
    Math.abs(origin.z - anchor.z) > ANCHOR_REBASE_DISTANCE_METERS
  );
}

export function setFieldAnchor(position: Vector3): void {
  anchor.x = position.x;
  anchor.y = position.y;
  anchor.z = position.z;
}
