// Gravity wells (architecture §4.3, §7 step 6): K ≤ 8 sparse cosmetic attractors that pull
// rocks into local knots — manufactured local density, the thing that makes inter-asteroid
// collisions (step 7) actually happen at the field's native ~1-rock-per-1130 m spacing.
//
// SAFETY (§4.5 #1, same discipline as the wobble): the pull is a PURE function of `base`
// (deterministic, time-independent, eviction-lossless — no integrator), and the TOTAL pull
// magnitude is hard-capped at WELL_PULL_CAP_METERS, so `pos = base + wobble + pull` stays
// far inside the radius+1400 m mine slack. Gameplay reads `base`; only the renderer reads
// `pos`. (A rock near a well CAN show a slightly skewed scan-bearing arrow — the documented
// §4.5 #1 trade-off accepted for clumping; the bulk of the field, > ~3σ from every well, is
// untouched.)
//
// This module is the CPU side: the deterministic well derivation + the pure-JS mirror of
// the TSL pull formula (kernels/overlay.ts), pinned by tests/integration/gpu-wells.test.ts.

export const MAX_WELLS = 8;
// Hard cap on the TOTAL pull displacement (meters). With the √3·40 m wobble this keeps the
// worst cosmetic displacement ≈ 389 m — well under half the 1400 m mine slack.
export const WELL_PULL_CAP_METERS = 320;
// Gaussian falloff radius (meters): rocks inside ~1σ clump hard; beyond ~3σ are untouched.
export const WELL_SIGMA_METERS = 4000;

// Field constants (client-side mirror, same values sun-occlusion.ts pins).
const FIELD_SEED = 424242;
const FIELD_HALF_EXTENT_METERS = 56500;

export type GravityWell = {
  x: number;
  y: number;
  z: number;
  // 0..1 multiplier on the pull cap.
  strength: number;
};

function noise(seed: number): number {
  const value = Math.sin(seed * 12.9898) * 43758.5453;
  return value - Math.floor(value);
}

// K deterministic wells inside the inner field cube (±0.8 half-extent, so a well's whole
// clump stays in the id-space). Pure function of the field seed — every client derives the
// same wells, so the cosmetic clumps look the same for everyone.
export function deriveGravityWells(k = 6): GravityWell[] {
  const count = Math.min(k, MAX_WELLS);
  const wells: GravityWell[] = [];
  for (let i = 0; i < count; i += 1) {
    const s = FIELD_SEED + i * 9176;
    const span = FIELD_HALF_EXTENT_METERS * 0.8 * 2;
    wells.push({
      x: (noise(s + 1) - 0.5) * span,
      y: (noise(s + 2) - 0.5) * span,
      z: (noise(s + 3) - 0.5) * span,
      strength: 0.5 + noise(s + 4) * 0.5,
    });
  }
  return wells;
}

// Pure-JS mirror of the TSL well pull (kernels/overlay.ts genFieldOverlay): per well a
// Gaussian-falloff pull toward the center, clamped per-well to 0.9·distance (never
// overshoots the center), then the SUM clamped to WELL_PULL_CAP_METERS. Mirrored exactly so
// the bound test exercises the same formula the kernel runs.
export function wellPullMeters(
  px: number,
  py: number,
  pz: number,
  wells: readonly GravityWell[],
): { x: number; y: number; z: number } {
  let tx = 0;
  let ty = 0;
  let tz = 0;
  for (const well of wells) {
    const dx = well.x - px;
    const dy = well.y - py;
    const dz = well.z - pz;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist < 1e-6) {
      continue; // exactly at the center: no direction, no pull
    }
    const falloff = Math.exp(-((dist / WELL_SIGMA_METERS) * (dist / WELL_SIGMA_METERS)));
    const pull = Math.min(WELL_PULL_CAP_METERS * well.strength * falloff, dist * 0.9);
    tx += (dx / dist) * pull;
    ty += (dy / dist) * pull;
    tz += (dz / dist) * pull;
  }
  const mag = Math.sqrt(tx * tx + ty * ty + tz * tz);
  if (mag > WELL_PULL_CAP_METERS) {
    const scale = WELL_PULL_CAP_METERS / mag;
    tx *= scale;
    ty *= scale;
    tz *= scale;
  }
  return { x: tx, y: ty, z: tz };
}
