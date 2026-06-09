// The asteroid render material's floating-origin position node (docs/gpu-asteroids-architecture.md
// §8.4, §2.6).
//
// GPU-UNVERIFIED: the NodeMaterial + TSL positionNode are built at module load (typecheck- and
// bundle-verified), but rendering them needs a live WebGPU device, absent in this build env.
//
// ZERO-COPY (§1.1, §8.6 #2): `material.positionNode` reads `pos.element(instanceIndex)`
// directly — no `setMatrixAt`, no per-chunk meshes. The bulk draws straight from the GPU
// storage buffer the overlay kernel wrote.
//
// FLOATING ORIGIN (§2.6, §5): positions are absolute world METERS; the scene works in scene
// units at metersPerSceneUnit = 1000. We subtract the ship's `originMeters` then divide by
// 1000 so the camera stays near the scene origin (precision), and scale the unit-radius base
// geometry by radius/1000.

import { Fn, attribute, instanceIndex, uniform } from "three/tsl";
import * as THREE from "three/webgpu";

import { pos } from "../buffers";

// 1000 m per scene unit (§2.6). The render basis divides meters by this.
const METERS_PER_SCENE_UNIT = 1000;

// Floating-origin offset in world meters — set each frame from the own-ship position so the
// rendered field is recentred on the camera. Exported so the per-frame loop can update it
// (`originMeters.value.copy(ownShipMeters)`).
export const originMeters = uniform(new THREE.Vector3());

// Build the asteroid NodeMaterial. positionNode = floating-origin placement of a unit-radius
// base geometry, scaled by per-instance radius (pos.w), translated to (pos.xyz - origin)/1000.
export function makeAsteroidMaterial(): InstanceType<typeof THREE.MeshStandardNodeMaterial> {
  const mat = new THREE.MeshStandardNodeMaterial({ color: "#6f6a60", roughness: 0.96 });
  mat.positionNode = Fn(() => {
    const p = pos.element(instanceIndex);
    const rel = p.xyz.sub(originMeters).div(METERS_PER_SCENE_UNIT); // ship-relative scene units
    return attribute("position").mul(p.w.div(METERS_PER_SCENE_UNIT)).add(rel); // scale by radius/1000
  })();
  return mat;
}
