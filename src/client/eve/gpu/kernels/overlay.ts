// The overlay compute kernel (docs/gpu-asteroids-architecture.md §8.3, §3.2).
//
// GPU-UNVERIFIED: the TSL `Fn(...).compute()` graph below is built at module load (so it is
// typecheck- and bundle-verified), but DISPATCHING it requires a live WebGPU device, which
// this build env lacks. Only the bounded-amplitude INVARIANT is unit-tested in pure JS
// (tests/integration/gpu-overlay-bound.test.ts).
//
// DETERMINISM (§3.2): the GPU does ONLY `pos = base + bounded overlay`. It NEVER regenerates
// `base` with a frac(sin) kernel — `base` is the CPU-authored static-noise image. The frac/sin
// HERE is applied to a SMALL bounded phase (packAttr.z + a cosmetic frameCounter), NOT the
// hashCell argument (~5e11) whose f32 sine is non-bit-portable. So this overlay's f32
// non-portability is genuinely cosmetic.
//
// SAFETY (§4.5 #1, §8.6 #4): the wobble is BOUNDED to ±WOBBLE_AMPLITUDE_METERS and the well
// pull (step 6, §4.3) is hard-capped at WELL_PULL_CAP_METERS — both pure functions of
// (base, phase, frame), so the total displacement keeps the rendered rock inside the
// radius+1400 m mine slack. Gameplay reads `base`; only the renderer reads `pos`.

import {
  exp,
  float,
  Fn,
  If,
  instanceIndex,
  Loop,
  min,
  normalize,
  sin,
  uint,
  uniform,
  uniformArray,
  vec3,
} from "three/tsl";
import * as THREE from "three/webgpu";

import { base, MAX_RESIDENT, packAttr, pos } from "../buffers";
import { collOffset } from "./collide";
import {
  deriveGravityWells,
  MAX_WELLS,
  WELL_PULL_CAP_METERS,
  WELL_SIGMA_METERS,
  type GravityWell,
} from "../wells";

// Per-axis wobble half-extent in meters. Each axis term is `sin(...)` ∈ [-1, 1], scaled by
// the amplitude, so |component| ≤ amplitude (= 40 m) on every axis. Exported so the
// invariant is unit-testable; MUST stay ≤ 40 m (the §8.6 #4 bound).
export const WOBBLE_AMPLITUDE_METERS = 40;

// Cosmetic frame ticker driving the wobble animation; bumped once per rendered frame by the
// host component. Exported so the per-frame loop can advance it (`frameCounter.value += 1`).
export const frameCounter = uniform(0);

// Gravity wells (§4.3, step 6): K ≤ 8 attractors as a uniform vec4 array (xyz meters,
// w strength) + an active count. Defaults to the deterministic field wells; tests/harness
// can reconfigure via setGravityWells.
const wellVectors = Array.from({ length: MAX_WELLS }, () => new THREE.Vector4());
const wellsUniform = uniformArray(wellVectors);
const wellCount = uniform(0);

export function setGravityWells(wells: readonly GravityWell[]): void {
  const count = Math.min(wells.length, MAX_WELLS);
  for (let i = 0; i < count; i += 1) {
    const well = wells[i]!;
    wellVectors[i]!.set(well.x, well.y, well.z, well.strength);
  }
  wellCount.value = count;
}
setGravityWells(deriveGravityWells());

// genFieldOverlay: pos = base + bounded wobble(phase, frameCounter) + capped well pull(base).
// One thread per resident slot. Submitted via `renderer.compute(genFieldOverlay)` (single
// submission, NOT computeAsync-awaited per pass — §3.3).
export const genFieldOverlay = Fn(() => {
  const i = instanceIndex;
  const b = base.element(i);
  const ph = packAttr.element(i).z;
  const t = frameCounter.mul(0.01);
  // Each sin(...) ∈ [-1, 1]; ×amplitude ⇒ |component| ≤ amplitude. The per-rock phase seed
  // (packAttr.z ∈ [0, 2π)) decorrelates rocks; the 0, 1.7, 3.1 offsets decorrelate axes.
  // SMOOTHNESS: this MUST stay a plain sinusoid of t — hashing it (fract(sin(x)*43758.5453))
  // re-rolls white noise every frame, which reads as the whole field vibrating (the original
  // step-6 bug; pinned by gpu-overlay-bound.test.ts "temporally SMOOTH").
  const wob = vec3(
    sin(ph.add(t)),
    sin(ph.add(t).add(1.7)),
    sin(ph.add(t).add(3.1)),
  ).mul(WOBBLE_AMPLITUDE_METERS);

  // Well pull — mirrors wells.wellPullMeters exactly: per-well Gaussian falloff toward the
  // center, per-well clamp to 0.9·distance (no overshoot), total clamped to the hard cap.
  const pull = vec3(0).toVar();
  Loop({ start: uint(0), end: uint(MAX_WELLS), type: "uint", condition: "<" }, ({ i: w }) => {
    If(float(uint(w)).lessThan(wellCount), () => {
      const well = wellsUniform.element(uint(w));
      const delta = well.xyz.sub(b.xyz).toVar();
      const dist = delta.length().toVar();
      If(dist.greaterThan(float(1e-6)), () => {
        const falloff = exp(dist.div(float(WELL_SIGMA_METERS)).pow(2).negate());
        const amount = min(float(WELL_PULL_CAP_METERS).mul(well.w).mul(falloff), dist.mul(0.9));
        pull.addAssign(delta.div(dist).mul(amount));
      });
    });
  });
  const pullMag = pull.length();
  If(pullMag.greaterThan(float(WELL_PULL_CAP_METERS)), () => {
    pull.assign(normalize(pull).mul(float(WELL_PULL_CAP_METERS)));
  });

  const p = pos.element(i);
  // collOffset is the step-7 collision displacement (hard-capped, last frame's apply).
  p.xyz.assign(b.xyz.add(wob).add(pull).add(collOffset.element(i).xyz));
  p.w.assign(b.w); // carry the radius into pos (§2.1)
})().compute(MAX_RESIDENT);

// Pure-JS mirror of ONE axis of the kernel wobble, for the bounded-amplitude + smoothness
// invariant tests. Mirrors `sin(phase + t + axisOffset) * amplitude`; |result| ≤ amplitude
// for any finite input, and |Δ per frame| ≤ amplitude * 0.01. Kept here so the tests
// exercise the EXACT formula the kernel uses.
export function wobbleAxisMeters(phase: number, frame: number, axisOffset: number): number {
  const t = frame * 0.01;
  return Math.sin(phase + t + axisOffset) * WOBBLE_AMPLITUDE_METERS;
}
