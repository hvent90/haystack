// Froxel volumetric lighting — TSL/WebGPU compute kernels + the post composite node
// (architecture §6, §2.5; CPU executable spec: ../froxels-cpu.ts).
//
// Per frame (joining the existing SINGLE compute submission, §3.3 — never computeAsync):
//   froxelScatter   one lane per froxel (160·90·64): froxel center -> world meters under
//                   the floating origin -> trilinear baked-belt density -> extinction
//                   sigma_t -> per-slice (inScatter.rgb, transmittance.a) into froxelAccum.
//   froxelIntegrate one lane per X/Y column: IN-PLACE front-to-back prefix over Z, after
//                   which accum[z] = cumulative (inScatter, transmittance) from the camera
//                   to slice z's FAR edge.
//   froxelComposite (fragment, built into the ScenePostProcessing chain BEFORE bloom):
//                   scene depth -> radial distance (the same metric the scatter slices
//                   use; NOT -getViewZ — the documented floating-origin trap) -> depth-
//                   aware trilinear lookup -> color·T + inScatter.
//
// GUARDRAILS (§6.4): this grid is VIEW-SPACE and rebuilt every frame (rotation included);
// it shares NO buffers and NO origin with the collision world grid. The froxel pass is
// cosmetic: it writes ONLY froxelAccum, which nothing in the physics/cull pipeline reads.
//
// The baked density ([r][theta][z] polar uint8) is uploaded ONCE as packed u32 words
// (4 bytes/word) — full 1024·1024·8 resolution (8.4 MB; resampling would save nothing at
// sample time since reads are one trilinear fetch either way, and the radial bins at
// ~2.7 km are exactly the structure the fog should follow). A Storage buffer, not a 3D
// texture: textureSample in a compute stage is a WGSL minefield (implicit-LOD sampling is
// fragment-only), and the manual 8-tap trilinear mirrors froxels-cpu.sampleDensity exactly.

import * as THREE from "three/webgpu";
import {
  abs,
  atan,
  clamp,
  exp,
  float,
  floor,
  Fn,
  getViewPosition,
  If,
  instancedArray,
  instanceIndex,
  length,
  log,
  Loop,
  max,
  mix,
  normalize,
  smoothstep,
  storage,
  uint,
  uniform,
  vec3,
  vec4,
  type ShaderNodeObject,
} from "three/tsl";

import type { BeltField } from "../../../../shared/belt/field";
import {
  FROXEL_COUNT,
  FROXEL_D,
  FROXEL_FADE_START,
  FROXEL_FAR,
  FROXEL_H,
  FROXEL_LOG_RATIO,
  FROXEL_NEAR,
  FROXEL_W,
  METERS_PER_SCENE_UNIT,
} from "../froxels-cpu";
import { backingU32Of } from "../buffers";
import { originMeters } from "./render-node";

const WORKGROUP = 256;

// --- the accumulator (§2.5 — committed schema) ----------------------------------------
// vec4 SoA: inScatter.rgb + transmittance.a, index z*W*H + y*W + x. ~14.7 MB.
export const froxelAccum = instancedArray(FROXEL_COUNT, "vec4");

// Read-only view of the SAME attribute for the fragment composite: WGSL requires
// read-only storage access in fragment stages, and one node carries one access mode.
const froxelAccumRead = storage(
  (froxelAccum as unknown as { value: THREE.StorageInstancedBufferAttribute }).value,
  "vec4",
  FROXEL_COUNT,
).toReadOnly();

// --- the baked-density medium ----------------------------------------------------------
// Packed uint8 density bytes, 4 per u32 word. Capacity = the default bake's full grid;
// uploadFroxelDensity throws on a bigger bake rather than silently truncating.
export const DENSITY_BYTE_CAPACITY = 1024 * 1024 * 8;
const densityWords = instancedArray(DENSITY_BYTE_CAPACITY / 4, "uint").setPBO(true);

// Grid geometry uniforms, set at upload. Dims stay exact in f32 (max linear index 2^23).
const uNr = uniform(1);
const uNTheta = uniform(1);
const uNz = uniform(1);
const uRMin = uniform(0); // normalized sim units
const uRMax = uniform(1);
const uZMax = uniform(1);
const uWorldScale = uniform(1); // meters per normalized unit
const uDensityReady = uniform(0); // 0 until a bake is uploaded; gates the baked term

// --- camera + tuning uniforms ----------------------------------------------------------
export const froxelProjInv = uniform(new THREE.Matrix4());
export const froxelCamWorld = uniform(new THREE.Matrix4());

export type FroxelTuning = {
  // Extinction per unit baked density (1/km at density 1.0).
  sigmaScale: number;
  // Uniform "interplanetary dust" floor (1/km) — a breath, not a fog.
  sigmaFloor: number;
  // Scattering albedo tint (what color the dust scatters).
  albedo: { r: number; g: number; b: number };
  // Phase-1 isotropic ambient in-scatter strength (kept faint once lights land).
  ambient: number;
  // 0 = froxel composite off (passthrough), 1 = fully applied.
  mix: number;
};

export const FROXEL_DEFAULTS: FroxelTuning = {
  sigmaScale: 0.22,
  sigmaFloor: 0.01,
  albedo: { r: 0.5, g: 0.56, b: 0.74 },
  ambient: 0.028,
  mix: 1,
};

const uSigmaScale = uniform(FROXEL_DEFAULTS.sigmaScale);
const uSigmaFloor = uniform(FROXEL_DEFAULTS.sigmaFloor);
const uAlbedo = uniform(
  new THREE.Color(FROXEL_DEFAULTS.albedo.r, FROXEL_DEFAULTS.albedo.g, FROXEL_DEFAULTS.albedo.b),
);
const uAmbient = uniform(FROXEL_DEFAULTS.ambient);
const uFroxelMix = uniform(FROXEL_DEFAULTS.mix);

// Apply tuning (defaults overlaid with the WorldView debug-override object, if any) —
// called once per frame from the render loop, same pattern as the shadow-tier switches.
export function applyFroxelTuning(override: Partial<FroxelTuning> | null): void {
  const t = { ...FROXEL_DEFAULTS, ...(override ?? {}) };
  uSigmaScale.value = t.sigmaScale;
  uSigmaFloor.value = t.sigmaFloor;
  uAlbedo.value.setRGB(t.albedo.r, t.albedo.g, t.albedo.b);
  uAmbient.value = t.ambient;
  uFroxelMix.value = t.mix;
}

// --- density upload ---------------------------------------------------------------------

let densityUploaded = false;

export type DensityGridSpec = {
  data: Uint8Array;
  nr: number;
  ntheta: number;
  nz: number;
  rMin: number;
  rMax: number;
  zMax: number;
  worldScale: number;
};

// Upload a density grid into the packed word buffer + set the geometry uniforms. Used by
// the belt path below and (with synthetic grids) by the on-device gate.
export function setFroxelDensityGrid(g: DensityGridSpec): void {
  const bytes = g.nr * g.ntheta * g.nz;
  if (g.data.byteLength !== bytes) {
    throw new Error(`setFroxelDensityGrid: data ${g.data.byteLength} != ${bytes}`);
  }
  if (bytes > DENSITY_BYTE_CAPACITY) {
    throw new Error(
      `setFroxelDensityGrid: bake ${bytes}B exceeds froxel density capacity ` +
        `${DENSITY_BYTE_CAPACITY}B — raise DENSITY_BYTE_CAPACITY`,
    );
  }
  const words = backingU32Of(densityWords);
  // Pack little-endian: byte i lives in word i>>2 at bit (i&3)*8 — matches the kernel tap.
  words.fill(0);
  for (let i = 0; i < bytes; i += 1) {
    words[i >> 2] = words[i >> 2]! | (g.data[i]! << ((i & 3) * 8));
  }
  const attr = (densityWords as unknown as { value?: { needsUpdate?: boolean } }).value;
  if (attr) attr.needsUpdate = true;
  uNr.value = g.nr;
  uNTheta.value = g.ntheta;
  uNz.value = g.nz;
  uRMin.value = g.rMin;
  uRMax.value = g.rMax;
  uZMax.value = g.zMax;
  uWorldScale.value = g.worldScale;
  uDensityReady.value = 1;
  densityUploaded = true;
}

// Idempotent per-frame hook: uploads the active belt bake's density once it has loaded
// (the bake fetch is async; until then the medium is the sigmaFloor breath only).
export function ensureFroxelDensity(belt: BeltField | null): boolean {
  if (densityUploaded) {
    return true;
  }
  if (belt === null) {
    return false;
  }
  const { nr, ntheta, nz, rMin, rMax, zMax } = belt.bake.meta.density;
  setFroxelDensityGrid({
    data: belt.bake.density,
    nr,
    ntheta,
    nz,
    rMin,
    rMax,
    zMax,
    worldScale: belt.bake.worldScale,
  });
  return true;
}

// Test/harness hook: forget the uploaded bake so a fresh grid can be set.
export function resetFroxelDensityForTest(): void {
  densityUploaded = false;
  uDensityReady.value = 0;
}

// --- shared TSL pieces -------------------------------------------------------------------

type FloatNode = ShaderNodeObject<THREE.Node>;

// One density byte tap at integer (float-typed, in-range) grid coords. Index arithmetic
// stays in f32 — exact for the 2^23 max linear index — then converts to uint for the
// word/byte extraction. Mirrors froxels-cpu.sampleDensity's addressing.
function densityTap(ir: FloatNode, it: FloatNode, iz: FloatNode): FloatNode {
  const fidx = ir.mul(uNTheta).add(it).mul(uNz).add(iz);
  const idx = uint(fidx);
  const word = densityWords.element(idx.shiftRight(uint(2)));
  return float(word.shiftRight(idx.bitAnd(uint(3)).mul(uint(8))).bitAnd(uint(255)));
}

// Trilinear baked-density sample at a world position (METERS), 0..1. Theta wraps; r and
// z clamp, hard 0 outside the bake volume. Mirrors froxels-cpu.sampleDensity.
function sampleDensityTSL(world: ShaderNodeObject<THREE.Node>): FloatNode {
  const result = float(0).toVar();
  const rNorm = length(vec3(world).xz).div(uWorldScale).toVar();
  const zNorm = vec3(world).y.div(uWorldScale).toVar();
  const inRange = rNorm
    .greaterThanEqual(uRMin)
    .and(rNorm.lessThanEqual(uRMax))
    .and(abs(zNorm).lessThanEqual(uZMax))
    .and(uDensityReady.greaterThan(0.5));
  If(inRange, () => {
    const theta = atan(vec3(world).z, vec3(world).x); // [-pi, pi)
    const fr = rNorm.sub(uRMin).div(uRMax.sub(uRMin)).mul(uNr).sub(0.5).toVar();
    const ft = theta
      .add(Math.PI)
      .div(2 * Math.PI)
      .mul(uNTheta)
      .sub(0.5)
      .toVar();
    const fz = zNorm.add(uZMax).div(uZMax.mul(2)).mul(uNz).sub(0.5).toVar();

    const ir0 = floor(fr).toVar();
    const it0 = floor(ft).toVar();
    const iz0 = floor(fz).toVar();
    const wr = fr.sub(ir0).toVar();
    const wt = ft.sub(it0).toVar();
    const wz = fz.sub(iz0).toVar();

    // r/z clamp to [0, n-1]; theta wraps (it0 ∈ [-1, ntheta-1] by construction).
    const ir0c = clamp(ir0, 0, uNr.sub(1)).toVar();
    const ir1c = clamp(ir0.add(1), 0, uNr.sub(1)).toVar();
    const it0w = it0.lessThan(0).select(it0.add(uNTheta), it0).toVar();
    const it1 = it0.add(1).toVar();
    const it1w = it1.greaterThanEqual(uNTheta).select(it1.sub(uNTheta), it1).toVar();
    const iz0c = clamp(iz0, 0, uNz.sub(1)).toVar();
    const iz1c = clamp(iz0.add(1), 0, uNz.sub(1)).toVar();

    const c000 = densityTap(ir0c, it0w, iz0c);
    const c001 = densityTap(ir0c, it0w, iz1c);
    const c010 = densityTap(ir0c, it1w, iz0c);
    const c011 = densityTap(ir0c, it1w, iz1c);
    const c100 = densityTap(ir1c, it0w, iz0c);
    const c101 = densityTap(ir1c, it0w, iz1c);
    const c110 = densityTap(ir1c, it1w, iz0c);
    const c111 = densityTap(ir1c, it1w, iz1c);

    const c00 = mix(c000, c001, wz);
    const c01 = mix(c010, c011, wz);
    const c10 = mix(c100, c101, wz);
    const c11 = mix(c110, c111, wz);
    const c0 = mix(c00, c01, wt);
    const c1 = mix(c10, c11, wt);
    result.assign(mix(c0, c1, wr).div(255));
  });
  return result;
}

// Far-handoff ease-out for sigma_t (mirrors froxels-cpu.froxelSigmaT's fade).
function farFade(dist: FloatNode): FloatNode {
  return smoothstep(float(FROXEL_FADE_START), float(FROXEL_FAR), dist).oneMinus();
}

// --- the kernels -------------------------------------------------------------------------

export type FroxelPipeline = {
  scatter: ReturnType<ReturnType<ReturnType<typeof Fn>>["compute"]>;
  integrate: ReturnType<ReturnType<ReturnType<typeof Fn>>["compute"]>;
  // The per-frame dispatch list, in order.
  dispatches: ReturnType<ReturnType<ReturnType<typeof Fn>>["compute"]>[];
};

export function makeFroxelPipeline(): FroxelPipeline {
  // froxelScatter — one lane per froxel. 921600 % 256 == 0, but keep the §impl-log
  // bounds guard anyway (dispatch rounding is a documented device-caught failure mode).
  const scatter = Fn(() => {
    If(instanceIndex.lessThan(uint(FROXEL_COUNT)), () => {
      const i = instanceIndex;
      const x = i.mod(uint(FROXEL_W)).toVar();
      const y = i.div(uint(FROXEL_W)).mod(uint(FROXEL_H)).toVar();
      const z = i.div(uint(FROXEL_W * FROXEL_H)).toVar();

      // Froxel-center view ray from the NDC tile center (any clip depth lands on the ray).
      const ndcX = float(x).add(0.5).div(FROXEL_W).mul(2).sub(1);
      const ndcY = float(y).add(0.5).div(FROXEL_H).mul(2).sub(1);
      const v = froxelProjInv.mul(vec4(ndcX, ndcY, 0.5, 1)).toVar();
      const dir = normalize(v.xyz.div(v.w)).toVar();

      // Log-depth slice geometry (radial distance, scene units; spec: froxels-cpu).
      const zf = float(z).toVar();
      const sliceNear = float(FROXEL_NEAR)
        .mul(exp(zf.div(FROXEL_D).mul(FROXEL_LOG_RATIO)))
        .toVar();
      const sliceFar = float(FROXEL_NEAR)
        .mul(exp(zf.add(1).div(FROXEL_D).mul(FROXEL_LOG_RATIO)))
        .toVar();
      const dist = float(FROXEL_NEAR)
        .mul(exp(zf.add(0.5).div(FROXEL_D).mul(FROXEL_LOG_RATIO)))
        .toVar();
      const sliceLen = sliceFar.sub(sliceNear).toVar();

      // Floating-origin world position (meters): scene = camWorld · (dir·dist);
      // world = originMeters + scene·1000 (the §"floating origin" hard constraint).
      const posScene = froxelCamWorld.mul(vec4(dir.mul(dist), 1)).xyz.toVar();
      const world = vec3(originMeters).add(posScene.mul(METERS_PER_SCENE_UNIT)).toVar();

      const density = sampleDensityTSL(world).toVar();
      const sigmaT = density.mul(uSigmaScale).add(uSigmaFloor).mul(farFade(dist)).toVar();
      const trans = exp(sigmaT.mul(sliceLen).negate()).toVar();

      // Phase 1: isotropic ambient in-scatter only (sun march + flashlight are phase 2).
      const energy = uAmbient.mul(trans.oneMinus());
      froxelAccum.element(i).assign(vec4(vec3(uAlbedo).mul(energy), trans));
    });
  })().compute(FROXEL_COUNT, [WORKGROUP]);

  // froxelIntegrate — one lane per X/Y column; in-place front-to-back prefix over Z.
  // 14400 rounds up to a workgroup multiple, so the bounds guard is load-bearing here.
  const integrate = Fn(() => {
    If(instanceIndex.lessThan(uint(FROXEL_W * FROXEL_H)), () => {
      const col = instanceIndex;
      const accumL = vec3(0).toVar();
      const accumT = float(1).toVar();
      Loop({ start: uint(0), end: uint(FROXEL_D), type: "uint", condition: "<" }, ({ i: zi }) => {
        const idx = uint(zi)
          .mul(uint(FROXEL_W * FROXEL_H))
          .add(col)
          .toVar();
        const slice = froxelAccum.element(idx).toVar();
        accumL.addAssign(slice.xyz.mul(accumT));
        accumT.mulAssign(slice.w);
        froxelAccum.element(idx).assign(vec4(accumL, accumT));
      });
    });
  })().compute(FROXEL_W * FROXEL_H, [WORKGROUP]);

  return { scatter, integrate, dispatches: [scatter, integrate] };
}

// --- the composite node (ScenePostProcessing, BEFORE bloom) -------------------------------

// Build the froxel composite over an input color node. Depth -> radial camera distance
// (the SAME metric the slices use) -> forward-project the view position back to NDC for
// the X/Y froxel coordinate (consistent with the scatter rays by construction, immune to
// uv-origin conventions) -> trilinear cumulative lookup -> color·T + inScatter.
export function makeFroxelComposite(
  input: THREE.Node,
  depthNode: THREE.Node,
  screenUV: THREE.Node,
  camera: THREE.Camera,
): ShaderNodeObject<THREE.Node> {
  // Live references — these are the camera's own mutable matrices (the ScenePostProcessing
  // pattern), re-read every frame by the uniform nodes.
  const uProj = uniform(camera.projectionMatrix);
  const uProjInv = uniform(camera.projectionMatrixInverse);
  // Cumulative-accumulator fetch at integer froxel coords; z < 0 reads the identity
  // (nothing between the camera and the first slice edge).
  const fetch = (fx: FloatNode, fy: FloatNode, fzi: FloatNode): ShaderNodeObject<THREE.Node> => {
    const idx = uint(max(fzi, 0))
      .mul(uint(FROXEL_W * FROXEL_H))
      .add(uint(fy).mul(uint(FROXEL_W)))
      .add(uint(fx));
    return fzi.lessThan(0).select(vec4(0, 0, 0, 1), froxelAccumRead.element(idx));
  };

  return Fn(() => {
    const result = vec4(input).toVar();
    If(uFroxelMix.greaterThan(0), () => {
      const depth = float(depthNode).toVar();
      // Background (depth 1) reconstructs to the camera far plane — still ON the fragment's
      // ray, so the radial distance simply clamps to FROXEL_FAR (full medium column).
      const viewPos = vec3(getViewPosition(screenUV, depth, uProjInv)).toVar();
      const dist = clamp(length(viewPos), float(FROXEL_NEAR), float(FROXEL_FAR * 0.9999)).toVar();

      // Forward-project for the froxel X/Y (same NDC space the scatter rays came from).
      const clip = uProj.mul(vec4(viewPos, 1)).toVar();
      const ndc = clip.xy.div(clip.w).toVar();
      const fx = clamp(ndc.x.mul(0.5).add(0.5).mul(FROXEL_W).sub(0.5), 0, FROXEL_W - 1).toVar();
      const fy = clamp(ndc.y.mul(0.5).add(0.5).mul(FROXEL_H).sub(0.5), 0, FROXEL_H - 1).toVar();
      // Cumulative lookup coordinate: accum[z] holds camera->farEdge(z), so fz = zOf(d)-1.
      const fz = float(FROXEL_D)
        .mul(log(dist.div(FROXEL_NEAR)))
        .div(FROXEL_LOG_RATIO)
        .sub(1)
        .toVar();

      const x0 = floor(fx).toVar();
      const y0 = floor(fy).toVar();
      const z0 = floor(fz).toVar();
      const x1 = clamp(x0.add(1), 0, FROXEL_W - 1).toVar();
      const y1 = clamp(y0.add(1), 0, FROXEL_H - 1).toVar();
      const z1 = clamp(z0.add(1), 0, FROXEL_D - 1).toVar();
      const wx = fx.sub(x0).toVar();
      const wy = fy.sub(y0).toVar();
      const wz = fz.sub(z0).toVar();

      const s00 = mix(fetch(x0, y0, z0), fetch(x0, y0, z1), wz);
      const s01 = mix(fetch(x0, y1, z0), fetch(x0, y1, z1), wz);
      const s10 = mix(fetch(x1, y0, z0), fetch(x1, y0, z1), wz);
      const s11 = mix(fetch(x1, y1, z0), fetch(x1, y1, z1), wz);
      const s = mix(mix(s00, s01, wy), mix(s10, s11, wy), wx).toVar();

      const fogged = vec3(result.rgb).mul(s.w).add(s.xyz);
      result.rgb.assign(mix(vec3(result.rgb), fogged, uFroxelMix));
    });
    return result;
  })();
}
