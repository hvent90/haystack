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
// SAFETY (§4.5 #1, §8.6 #4): the wobble is BOUNDED to ±WOBBLE_AMPLITUDE_METERS. That keeps the
// rendered rock inside the radius+1400 m mine slack AND gameplay-invisible vs the 3-decimal
// (~50 m) scan-bearing granularity. Gameplay reads `base`; only the renderer reads `pos`.

import { Fn, fract, instanceIndex, sin, uniform, vec3 } from "three/tsl";

import { base, MAX_RESIDENT, packAttr, pos } from "../buffers";

// Per-axis wobble half-extent in meters. Each axis term is `(fract(sin(...)) - 0.5)` ∈ [-0.5,
// 0.5], scaled by 2*amplitude, so |component| ≤ amplitude (= 40 m) on every axis. Exported so
// the invariant is unit-testable; MUST stay ≤ 40 m (the §8.6 #4 bound).
export const WOBBLE_AMPLITUDE_METERS = 40;

// Cosmetic frame ticker driving the wobble animation; bumped once per rendered frame by the
// host component. Exported so the per-frame loop can advance it (`frameCounter.value += 1`).
export const frameCounter = uniform(0);

// genFieldOverlay: pos = base + bounded wobble(phase, frameCounter). One thread per resident
// slot. Submitted via `renderer.compute(genFieldOverlay)` (single submission, NOT
// computeAsync-awaited per pass — §3.3).
export const genFieldOverlay = Fn(() => {
  const i = instanceIndex;
  const b = base.element(i);
  const ph = packAttr.element(i).z;
  const t = frameCounter.mul(0.01);
  // Each (fract(sin(...)) - 0.5) ∈ [-0.5, 0.5]; ×(2*amplitude) ⇒ |component| ≤ amplitude.
  const wob = vec3(
    fract(sin(ph.add(t)).mul(43758.5453)).sub(0.5),
    fract(sin(ph.add(t).add(1.7)).mul(43758.5453)).sub(0.5),
    fract(sin(ph.add(t).add(3.1)).mul(43758.5453)).sub(0.5),
  ).mul(WOBBLE_AMPLITUDE_METERS * 2);
  const p = pos.element(i);
  p.xyz.assign(b.xyz.add(wob));
  p.w.assign(b.w); // carry the radius into pos (§2.1)
})().compute(MAX_RESIDENT);

// Pure-JS mirror of ONE axis of the kernel wobble, for the bounded-amplitude invariant test.
// Mirrors `(fract(sin(arg)*43758.5453) - 0.5) * (2*amplitude)`; |result| ≤ amplitude for any
// finite input. Kept here so the test exercises the EXACT formula the kernel uses.
export function wobbleAxisMeters(phase: number, frame: number, axisOffset: number): number {
  const t = frame * 0.01;
  const arg = phase + t + axisOffset;
  const s = Math.sin(arg) * 43758.5453;
  const frac = s - Math.floor(s);
  return (frac - 0.5) * (WOBBLE_AMPLITUDE_METERS * 2);
}
