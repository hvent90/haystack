// CPU executable spec for the GPU cull/LOD compaction (architecture §7 step 4): the exact
// frustum + distance + banding logic the TSL kernel (kernels/cull.ts) mirrors. The
// on-device gate (verify-gpu.ts) compares the GPU lists against this implementation, the
// same CPU-spec-first discipline the binner used (binner-cpu.ts).
//
// All distances are SCENE units (meters / metersPerSceneUnit = 1000); positions arrive in
// absolute field METERS (the `pos` buffer image) and are rebased by the floating origin
// here, exactly as the render path does.

import type { Matrix4 } from "three";

import {
  shadowBubbleHalf,
  shadowCameraFar,
  shadowCameraNear,
  shadowLightDistance,
} from "../lighting";

export const LOD_COUNT = 4;
// Upper NEAREST-distance (dist - radius, scene units) per band, carried over from the
// legacy per-chunk cull (WorldView LOD_BAND_SCENE): dodeca -> icosa -> octa -> tetra.
export const LOD_BANDS_SCENE = [4, 9, 13] as const;
// Per-rock draw distance (scene units): a rock whose nearest point is beyond this is not
// drawn (the fog has fully extinguished it well before — fogFar is 18).
export const MAX_DRAW_SCENE = 18;
export const METERS_PER_SCENE_UNIT = 1000;

// Shadow-caster keep radius (scene units): rocks whose nearest point is within this
// distance of the camera survive the cull EVEN OFF-FRUSTUM. The shadow depth pass draws
// the same compacted lists as the main pass, so a strict camera-frustum cull would drop
// off-screen up-sun casters and their shadows would pop in/out as the camera turns. This
// sphere circumscribes the camera-following ortho shadow box (lateral ±shadowBubbleHalf;
// depth from shadowCameraNear to shadowCameraFar of a light shadowLightDistance up-sun),
// so every rock the shadow camera can see is kept. Off-frustum keeps cost vertex work
// only — the rasterizer clips them in the main pass.
export const SHADOW_CASTER_SCENE = Math.hypot(
  shadowBubbleHalf,
  shadowBubbleHalf,
  Math.max(shadowCameraFar - shadowLightDistance, shadowLightDistance - shadowCameraNear),
);

// The LOD band for a rock whose NEAREST point (dist - radius) is `nearest` scene units
// away. Caller has already culled nearest >= MAX_DRAW_SCENE.
export function lodBandFor(nearest: number): number {
  for (let band = 0; band < LOD_BANDS_SCENE.length; band += 1) {
    if (nearest < LOD_BANDS_SCENE[band]!) {
      return band;
    }
  }
  return LOD_COUNT - 1;
}

// Gribb-Hartmann frustum plane extraction from a projScreen matrix (projectionMatrix *
// matrixWorldInverse), normalized so plane·point + w is a true signed distance. Layout:
// 24 floats, 6 planes × (nx, ny, nz, d); a sphere is (conservatively) inside when
// dot(n, center) + d >= -radius for ALL six planes — the same predicate
// THREE.Frustum.intersectsSphere uses.
export function extractFrustumPlanes(projScreen: Matrix4): Float32Array {
  const e = projScreen.elements;
  const planes = new Float32Array(24);
  // rows of the matrix (column-major storage): row i element j = e[j*4 + i]
  const row = (i: number, j: number): number => e[j * 4 + i]!;
  const set = (p: number, a: number, b: number, c: number, d: number): void => {
    const inv = 1 / Math.hypot(a, b, c);
    planes[p * 4] = a * inv;
    planes[p * 4 + 1] = b * inv;
    planes[p * 4 + 2] = c * inv;
    planes[p * 4 + 3] = d * inv;
  };
  // left/right/bottom/top/near/far = row3 ± row0/1/2
  set(
    0,
    row(3, 0) + row(0, 0),
    row(3, 1) + row(0, 1),
    row(3, 2) + row(0, 2),
    row(3, 3) + row(0, 3),
  );
  set(
    1,
    row(3, 0) - row(0, 0),
    row(3, 1) - row(0, 1),
    row(3, 2) - row(0, 2),
    row(3, 3) - row(0, 3),
  );
  set(
    2,
    row(3, 0) + row(1, 0),
    row(3, 1) + row(1, 1),
    row(3, 2) + row(1, 2),
    row(3, 3) + row(1, 3),
  );
  set(
    3,
    row(3, 0) - row(1, 0),
    row(3, 1) - row(1, 1),
    row(3, 2) - row(1, 2),
    row(3, 3) - row(1, 3),
  );
  set(
    4,
    row(3, 0) + row(2, 0),
    row(3, 1) + row(2, 1),
    row(3, 2) + row(2, 2),
    row(3, 3) + row(2, 3),
  );
  set(
    5,
    row(3, 0) - row(2, 0),
    row(3, 1) - row(2, 1),
    row(3, 2) - row(2, 2),
    row(3, 3) - row(2, 3),
  );
  return planes;
}

export type CullResult = {
  // Per-LOD compacted slot lists (in slot order on CPU; the GPU's order is an atomic race,
  // so cross-checks compare as SETS).
  lists: Uint32Array[];
};

// Reference cull: for each live slot (radius > 0), rebase to scene units, distance-cull on
// the nearest point, frustum-test the bounding sphere, and band the survivors.
export function cullCPU(
  posXYZR: Float32Array,
  count: number,
  originMeters: { x: number; y: number; z: number },
  planes: Float32Array,
): CullResult {
  const lists: number[][] = Array.from({ length: LOD_COUNT }, () => []);
  for (let slot = 0; slot < count; slot += 1) {
    const o = slot * 4;
    const radius = posXYZR[o + 3]!;
    if (radius <= 0) {
      continue;
    }
    const x = (posXYZR[o]! - originMeters.x) / METERS_PER_SCENE_UNIT;
    const y = (posXYZR[o + 1]! - originMeters.y) / METERS_PER_SCENE_UNIT;
    const z = (posXYZR[o + 2]! - originMeters.z) / METERS_PER_SCENE_UNIT;
    const radiusScene = radius / METERS_PER_SCENE_UNIT;
    const dist = Math.hypot(x, y, z);
    const nearest = dist - radiusScene;
    if (nearest >= MAX_DRAW_SCENE) {
      continue;
    }
    let inside = true;
    for (let p = 0; p < 6; p += 1) {
      const d =
        planes[p * 4]! * x + planes[p * 4 + 1]! * y + planes[p * 4 + 2]! * z + planes[p * 4 + 3]!;
      if (d < -radiusScene) {
        inside = false;
        break;
      }
    }
    // Off-frustum rocks inside the shadow-caster bubble are kept (see SHADOW_CASTER_SCENE).
    if (!inside && nearest >= SHADOW_CASTER_SCENE) {
      continue;
    }
    lists[lodBandFor(nearest)]!.push(slot);
  }
  return { lists: lists.map((list) => Uint32Array.from(list)) };
}
