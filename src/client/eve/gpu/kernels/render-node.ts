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
  color,
  cos,
  cross,
  dFdx,
  dFdy,
  dot,
  float,
  fract,
  instanceIndex,
  mix,
  normalize,
  positionView,
  sin,
  smoothstep,
  step,
  time,
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

// Benchmark-only A/B switches for the two shadow tiers (1 = on, 0 = term forced to 1.0 /
// fully lit). Driven from RenderDebugControls each frame; both 1 in normal play. They let
// the shadow-diag harness prove each tier's visible contribution by screenshot diff.
export const shadowTier1Enable = uniform(1);
export const shadowTier2Enable = uniform(1);

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
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.95 });
  const slot = lodList.element(instanceIndex);

  // Cosmetic spin (step 6): a slow per-rock tumble about a phase-derived axis. Like the
  // wobble it is a PURE function of (slot phase, time) — stateless, eviction-lossless, and
  // it only ROTATES the unit geometry about the rock's own center, so the §4.5 #1 position
  // bound is untouched. Rotation is Rodrigues' formula, applied to the local position.
  const phase = packAttr.element(slot).z;
  const axis = normalize(
    vec3(sin(phase.mul(3.7)), sin(phase.mul(5.1).add(1.3)), cos(phase.mul(2.9))),
  ).toVar();
  // ED ring tumble (research doc §4: 1-5 min/rev typical, tens of seconds rare-fast):
  // 0.01..0.12 rad/s for the bulk, with ~4% fast spinners at +0.25 rad/s.
  const rate = fract(phase.mul(1.618))
    .mul(0.11)
    .add(0.01)
    .add(step(0.96, fract(phase.mul(7.31))).mul(0.25));
  const angle = rate.mul(time);
  const cosA = cos(angle).toVar();
  const sinA = sin(angle).toVar();
  const rodrigues = (v: ReturnType<typeof vec3>): ReturnType<typeof vec3> =>
    v
      .mul(cosA)
      .add(cross(axis, v).mul(sinA))
      .add(axis.mul(dot(axis, v)).mul(cosA.oneMinus()));

  // ED "lumpy potato" shapes (research doc §4) from the shared unit icosa geometry:
  // three fixed-frequency sine octaves, phased per rock, scale each vertex radially to
  // 0.62..1.0 — every instance gets its own lump pattern from the same buffer, and the
  // fixed frequencies keep a family resemblance (ED reuses ~6 meshes per ring type).
  // Displacement is INWARD-only so the visual never exceeds the collision/gameplay
  // radius, and it is applied BEFORE the tumble (shape is rock-fixed).
  const local = vec3(attribute("position"));
  const lumpPhase = phase.mul(61.7);
  const lump = sin(dot(local, vec3(2.7, 1.3, 3.4)).add(lumpPhase))
    .mul(0.55)
    .add(sin(dot(local, vec3(5.1, 4.2, 1.9)).add(lumpPhase.mul(1.7))).mul(0.3))
    .add(sin(dot(local, vec3(9.3, 7.7, 8.1)).add(lumpPhase.mul(2.3))).mul(0.15));
  const shaped = local.mul(lump.sub(1).mul(0.19).add(1));

  mat.positionNode = Fn(() => {
    const p = pos.element(slot);
    const rel = p.xyz.sub(originMeters).div(METERS_PER_SCENE_UNIT);
    const spun = rodrigues(shaped);
    return spun.mul(p.w.div(METERS_PER_SCENE_UNIT)).add(rel);
  })();
  // Faceted normals from screen-space derivatives: free, and they follow displacement
  // and tumble exactly (an analytic normal would need the lump gradient).
  mat.normalNode = normalize(cross(dFdx(positionView), dFdy(positionView)));
  // Rocky-ring albedo (research doc §4: mid grey-brown, matte) with per-instance
  // lightness variation so the field doesn't read as a single repeated material.
  const tint = varying(fract(phase.mul(3.33)));
  mat.colorNode = mix(color("#564d42"), color("#867d6e"), tint);
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
  mat.receivedShadowNode = Fn(([shadow]: [ShaderNodeObject<THREE.Node>]) => {
    const sunlitTerm = mix(float(1), clamp(aSunlit, 0, 1), shadowTier2Enable);
    const shadowTerm = mix(float(1), shadow, shadowTier1Enable);
    return mix(sunlitTerm, shadowTerm, bubbleWeight);
  }) as unknown as typeof mat.receivedShadowNode;
  return mat;
}
