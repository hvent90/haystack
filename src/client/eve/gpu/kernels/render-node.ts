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

import {
  Fn,
  attribute,
  clamp,
  cos,
  cross,
  dot,
  float,
  fract,
  instanceIndex,
  mix,
  normalGeometry,
  normalize,
  positionView,
  sin,
  smoothstep,
  time,
  transformNormalToView,
  uniform,
  varying,
  vec3,
  type ShaderNodeObject,
} from "three/tsl";
import * as THREE from "three/webgpu";

import { shadowBubbleFadeFar, shadowBubbleFadeNear } from "../../lighting";
import { packAttr, pos } from "../buffers";

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

// As makeAsteroidMaterial, but for the GPU-culled per-LOD draw path (step 4): the cull
// kernel compacts visible slots into `lodList`, so the per-draw instanceIndex is a COMPACTED
// index — the real slot is lodList[instanceIndex] (non-deterministic per frame; temporal
// state keys on slotMeta, §2.2). Also restores the two-tier aSunlit shadow as TSL
// (architecture §5): near the camera (bubbleWeight→1) the real shadow-map factor wins; far
// away (bubbleWeight→0) the per-instance sun-occlusion scalar (packAttr.w, the
// sun-occlusion.ts march) wins — the exact blend the legacy WebGL patchAsteroidShader
// applied to the sun's light term, now via receivedShadowNode.
export function makeLodAsteroidMaterial(
  lodList: ShaderNodeObject<THREE.StorageBufferNode>,
): InstanceType<typeof THREE.MeshStandardNodeMaterial> {
  const mat = new THREE.MeshStandardNodeMaterial({ color: "#6f6a60", roughness: 0.96 });
  const slot = lodList.element(instanceIndex);

  // Cosmetic spin (step 6): a slow per-rock tumble about a phase-derived axis. Like the
  // wobble it is a PURE function of (slot phase, time) — stateless, eviction-lossless, and
  // it only ROTATES the unit geometry about the rock's own center, so the §4.5 #1 position
  // bound is untouched. Rotation is Rodrigues' formula, applied to the local position AND
  // the local normal (so facet lighting follows the tumble).
  const phase = packAttr.element(slot).z;
  const axis = normalize(
    vec3(sin(phase.mul(3.7)), sin(phase.mul(5.1).add(1.3)), cos(phase.mul(2.9))),
  ).toVar();
  // 0.05..0.30 rad/s tumble, decorrelated from the wobble by the golden-ratio scramble.
  const rate = fract(phase.mul(1.618)).mul(0.25).add(0.05);
  const angle = rate.mul(time);
  const cosA = cos(angle).toVar();
  const sinA = sin(angle).toVar();
  const rodrigues = (v: ReturnType<typeof vec3>): ReturnType<typeof vec3> =>
    v
      .mul(cosA)
      .add(cross(axis, v).mul(sinA))
      .add(axis.mul(dot(axis, v)).mul(cosA.oneMinus()));

  mat.positionNode = Fn(() => {
    const p = pos.element(slot);
    const rel = p.xyz.sub(originMeters).div(METERS_PER_SCENE_UNIT);
    const spun = rodrigues(vec3(attribute("position")));
    return spun.mul(p.w.div(METERS_PER_SCENE_UNIT)).add(rel);
  })();
  mat.normalNode = transformNormalToView(rodrigues(vec3(normalGeometry)));
  // Vertex-stage per-instance values, interpolated to the fragment stage where the shadow
  // blend runs (instanceIndex is vertex-only).
  const aSunlit = varying(packAttr.element(slot).w);
  const bubbleWeight = varying(
    smoothstep(
      float(shadowBubbleFadeNear),
      float(shadowBubbleFadeFar),
      positionView.z.negate(),
    ).oneMinus(),
  );
  // @types/three narrows receivedShadowNode to () => Node; three's own docs (and runtime,
  // NodeMaterial.setupLightingModel) pass the shadow as the first Fn arg.
  mat.receivedShadowNode = Fn(([shadow]: [ShaderNodeObject<THREE.Node>]) =>
    mix(clamp(aSunlit, 0, 1), shadow, bubbleWeight),
  ) as unknown as typeof mat.receivedShadowNode;
  return mat;
}
