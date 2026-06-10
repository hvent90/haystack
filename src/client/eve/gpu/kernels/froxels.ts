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
  atomicLoad,
  Break,
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
  min,
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
  SUN_ANGULAR_RADIUS,
  SUN_MARCH_STEP_METERS,
  SUN_MARCH_STEPS,
  SUN_PENUMBRA_CAP,
  SUN_TRANS_FLOOR,
} from "../froxels-cpu";
import { backingU32Of, pos } from "../buffers";
import { COLLISION_CELL_METERS, COLLISION_GRID_AXIS } from "../collide-cpu";
import {
  flashlightAngle,
  flashlightColor,
  flashlightDecay,
  flashlightDistance,
  flashlightIntensity,
  flashlightPenumbra,
  sunDirection,
  sunLightColor,
} from "../../lighting";
import type { BinnerBuffers } from "./binner";
import { gridOrigin } from "./collide";
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
// The field anchor (gpu/anchor.ts): every GPU coordinate (originMeters, pos, gridOrigin)
// is ANCHOR-RELATIVE at Saturn scale, so the froxel ray reconstruction and the up-sun
// march stay in that frame — but the polar DENSITY sample needs ABSOLUTE world meters
// (the belt is centered on the planet at the true origin). The anchor is added back just
// for the density lookup; at ~1.5e8 m the f32 ULP (~16 m) is noise against ≥70 km bins.
export const froxelAnchor = uniform(new THREE.Vector3());

export type FroxelTuning = {
  // Extinction per unit baked density (1/km at density 1.0).
  sigmaScale: number;
  // Uniform "interplanetary dust" floor (1/km) — a breath, not a fog.
  sigmaFloor: number;
  // Scattering albedo tint (what color the dust scatters).
  albedo: { r: number; g: number; b: number };
  // Isotropic ambient in-scatter strength (faint — the lights carry the look).
  ambient: number;
  // Sun in-scatter gain (the rock-shadow march + HG phase ride this term).
  sunStrength: number;
  // Henyey-Greenstein anisotropy; slight forward scatter per the spec (g ≈ 0.3..0.6).
  hgG: number;
  // Multiplier over flashlightIntensity for the volumetric beam term.
  flashStrength: number;
  // 0 = froxel composite off (passthrough), 1 = fully applied.
  mix: number;
};

export const FROXEL_DEFAULTS: FroxelTuning = {
  sigmaScale: 0.22,
  sigmaFloor: 0.01,
  albedo: { r: 0.5, g: 0.56, b: 0.74 },
  ambient: 0.008,
  sunStrength: 0.65,
  hgG: 0.45,
  flashStrength: 1,
  mix: 1,
};

const uSigmaScale = uniform(FROXEL_DEFAULTS.sigmaScale);
const uSigmaFloor = uniform(FROXEL_DEFAULTS.sigmaFloor);
const uAlbedo = uniform(
  new THREE.Color(FROXEL_DEFAULTS.albedo.r, FROXEL_DEFAULTS.albedo.g, FROXEL_DEFAULTS.albedo.b),
);
const uAmbient = uniform(FROXEL_DEFAULTS.ambient);
const uSunStrength = uniform(FROXEL_DEFAULTS.sunStrength);
const uHgG = uniform(FROXEL_DEFAULTS.hgG);
const uFroxelMix = uniform(FROXEL_DEFAULTS.mix);

// Apply tuning (defaults overlaid with the WorldView debug-override object, if any) —
// called once per frame from the render loop, same pattern as the shadow-tier switches.
export function applyFroxelTuning(override: Partial<FroxelTuning> | null): void {
  const t = { ...FROXEL_DEFAULTS, ...(override ?? {}) };
  uSigmaScale.value = t.sigmaScale;
  uSigmaFloor.value = t.sigmaFloor;
  uAlbedo.value.setRGB(t.albedo.r, t.albedo.g, t.albedo.b);
  uAmbient.value = t.ambient;
  uSunStrength.value = t.sunStrength;
  uHgG.value = t.hgG;
  flashTuningStrength = t.flashStrength;
  uFroxelMix.value = t.mix;
}

// --- the ship flashlight (analytic spot cone, scene units) -------------------------------
// Pose + on/off are pushed each frame by ShipFlashlight (the same component that drives
// the real shadow-casting spotlight), so the volumetric beam stays locked to the cockpit.
const uFlashPos = uniform(new THREE.Vector3());
const uFlashDir = uniform(new THREE.Vector3(0, 0, -1));
const uFlashIntensity = uniform(0);
const uFlashReach = uniform(flashlightDistance);
const uFlashCosInner = uniform(Math.cos(flashlightAngle * (1 - flashlightPenumbra)));
const uFlashCosOuter = uniform(Math.cos(flashlightAngle));
const uFlashDecay = uniform(flashlightDecay);
const uFlashColor = uniform(new THREE.Color(flashlightColor));
let flashTuningStrength = FROXEL_DEFAULTS.flashStrength;

export function setFroxelFlashlight(
  posScene: { x: number; y: number; z: number },
  dirScene: { x: number; y: number; z: number },
  on: boolean,
): void {
  uFlashPos.value.set(posScene.x, posScene.y, posScene.z);
  uFlashDir.value.set(dirScene.x, dirScene.y, dirScene.z);
  uFlashIntensity.value = on ? flashlightIntensity * flashTuningStrength : 0;
}

// Sun constants (lighting.ts): fixed direction toward the sun; world == scene direction.
const SUN_DIR = vec3(sunDirection.x, sunDirection.y, sunDirection.z);
const SUN_COLOR = new THREE.Color(sunLightColor);
const TAN_SUN = Math.tan(SUN_ANGULAR_RADIUS);
const SUN_MARCH_M = SUN_MARCH_STEPS * SUN_MARCH_STEP_METERS;

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

// Henyey-Greenstein phase on the shared anisotropy uniform (froxels-cpu.henyeyGreenstein).
function hgPhase(cosTheta: FloatNode): FloatNode {
  const g2 = uHgG.mul(uHgG);
  return g2.oneMinus().div(
    g2
      .add(1)
      .sub(uHgG.mul(2).mul(cosTheta))
      .pow(1.5)
      .mul(4 * Math.PI),
  );
}

// --- the kernels -------------------------------------------------------------------------

export type FroxelPipeline = {
  scatter: ReturnType<ReturnType<ReturnType<typeof Fn>>["compute"]>;
  integrate: ReturnType<ReturnType<ReturnType<typeof Fn>>["compute"]>;
  // The per-frame dispatch list, in order.
  dispatches: ReturnType<ReturnType<ReturnType<typeof Fn>>["compute"]>[];
};

// Build the froxel pipeline. `binner` is the COLLISION world-grid instance (§6.3): the
// up-sun shadow march READS its cellStart/cellCount/sortedItems over the live `pos`
// buffer — rocks become volumetric shadow casters for free. Froxels never write to it,
// and the two grids keep separate origins (§6.4).
export function makeFroxelPipeline(binner: BinnerBuffers): FroxelPipeline {
  const { cellCount, cellStart, sortedItems } = binner;

  // froxelScatter — one lane per froxel. 921600 % 256 == 0, but keep the §impl-log
  // bounds guard anyway (dispatch rounding is a documented device-caught failure mode).
  // Storage bindings: froxelAccum + densityWords + cellCount + cellStart + sortedItems +
  // pos = 6, under the WebGPU default maxStorageBuffersPerShaderStage of 8.
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

      // Floating-origin position (ANCHOR-RELATIVE meters, the frame pos/gridOrigin live
      // in): scene = camWorld · (dir·dist); rel = originMeters + scene·1000 (the
      // §"floating origin" hard constraint). The march below stays in this frame.
      const posScene = froxelCamWorld.mul(vec4(dir.mul(dist), 1)).xyz.toVar();
      const world = vec3(originMeters).add(posScene.mul(METERS_PER_SCENE_UNIT)).toVar();
      // Unit view direction in scene == world axes (the camWorld rotation applied to the
      // view-space ray) — the lighting phase functions' frame.
      const dirWorld = normalize(froxelCamWorld.mul(vec4(dir, 0)).xyz).toVar();

      // Density sampling needs the ABSOLUTE world position (polar around the planet).
      const density = sampleDensityTSL(world.add(vec3(froxelAnchor))).toVar();
      const sigmaT = density.mul(uSigmaScale).add(uSigmaFloor).mul(farFade(dist)).toVar();
      const trans = exp(sigmaT.mul(sliceLen).negate()).toVar();

      // In-scatter = albedo · (ambient + sun + flashlight) · (1 - sliceT). Lights skip
      // where sigma_t ≈ 0: nothing scatters, so the march would be wasted bandwidth.
      const light = vec3(uAmbient).toVar();
      If(sigmaT.greaterThan(float(1e-4)), () => {
        // --- sun: up-sun rock-shadow march through the collision world grid (the
        // computeSunlit port, froxels-cpu.sunTransmittanceCPU mirrors this exactly).
        If(uSunStrength.greaterThan(0), () => {
          const sunT = float(1).toVar();
          const prevCell = uint(0xffffffff).toVar();
          Loop(
            { start: uint(1), end: uint(SUN_MARCH_STEPS + 1), type: "uint", condition: "<" },
            ({ i: si }) => {
              // Outer-derived values materialized BEFORE the inner loop (the documented
              // nested-Loop WGSL shadowing corruption — impl-log device bug #7).
              const t = float(uint(si)).mul(SUN_MARCH_STEP_METERS).toVar();
              const sample = world.add(SUN_DIR.mul(t)).toVar();
              const cellF = floor(sample.sub(gridOrigin).div(COLLISION_CELL_METERS)).toVar();
              const inGrid = cellF.x
                .greaterThanEqual(0)
                .and(cellF.y.greaterThanEqual(0))
                .and(cellF.z.greaterThanEqual(0))
                .and(cellF.x.lessThan(COLLISION_GRID_AXIS))
                .and(cellF.y.lessThan(COLLISION_GRID_AXIS))
                .and(cellF.z.lessThan(COLLISION_GRID_AXIS));
              If(inGrid, () => {
                const cellIdx = uint(cellF.x)
                  .mul(uint(COLLISION_GRID_AXIS * COLLISION_GRID_AXIS))
                  .add(uint(cellF.y).mul(uint(COLLISION_GRID_AXIS)))
                  .add(uint(cellF.z))
                  .toVar();
                // Consecutive same-cell dedupe (step == cell size, so revisits are
                // only ever adjacent in the walk).
                If(cellIdx.notEqual(prevCell), () => {
                  prevCell.assign(cellIdx);
                  // Loop bounds materialized — a storage/atomic read as a raw Loop
                  // end emits empty WGSL (impl-log device bug #6).
                  const start = cellStart.element(cellIdx).toVar();
                  const occ = uint(atomicLoad(cellCount.element(cellIdx))).toVar();
                  Loop({ start: uint(0), end: occ, type: "uint", condition: "<" }, ({ i: k }) => {
                    const j = sortedItems.element(start.add(uint(k))).toVar();
                    const q = pos.element(j).toVar();
                    const w = q.xyz.sub(world).toVar();
                    const along = w.dot(SUN_DIR).toVar();
                    If(along.greaterThan(0).and(along.lessThanEqual(float(SUN_MARCH_M))), () => {
                      const perp = w.sub(SUN_DIR.mul(along));
                      const d = length(perp);
                      const penumbra = min(float(SUN_PENUMBRA_CAP), along.mul(TAN_SUN));
                      const cover = smoothstep(q.w, q.w.add(penumbra), d).oneMinus();
                      sunT.mulAssign(cover.oneMinus());
                    });
                  });
                });
              });
              If(sunT.lessThanEqual(float(SUN_TRANS_FLOOR)), () => {
                Break();
              });
            },
          );
          // Forward-scatter phase: cosTheta = dot(S, viewDir) (looking toward the sun
          // through dust = bright glare; rocks carve shafts via sunT).
          const sunE = uSunStrength.mul(hgPhase(SUN_DIR.dot(dirWorld))).mul(sunT);
          light.addAssign(vec3(SUN_COLOR.r, SUN_COLOR.g, SUN_COLOR.b).mul(sunE));
        });

        // --- ship flashlight: analytic spot-cone in scene units (no occlusion march —
        // the beam reads through dust; rocks already block it at the surface hit).
        If(uFlashIntensity.greaterThan(0), () => {
          const toF = posScene.sub(uFlashPos).toVar();
          const df = length(toF).toVar();
          If(df.greaterThan(float(1e-4)).and(df.lessThan(uFlashReach)), () => {
            const lDir = toF.div(df).toVar();
            const spot = smoothstep(uFlashCosOuter, uFlashCosInner, lDir.dot(vec3(uFlashDir)));
            const range = clamp(df.div(uFlashReach).oneMinus(), 0, 1).pow(2);
            const atten = range.div(max(df.pow(uFlashDecay), 0.05));
            // Light propagates along lDir; out-scatter toward the camera is -viewDir.
            const phase = hgPhase(lDir.dot(dirWorld).negate());
            const flashE = uFlashIntensity.mul(spot).mul(atten).mul(phase);
            light.addAssign(vec3(uFlashColor).mul(flashE));
          });
        });
      });

      const inScatter = vec3(uAlbedo).mul(light).mul(trans.oneMinus());
      froxelAccum.element(i).assign(vec4(inScatter, trans));
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
