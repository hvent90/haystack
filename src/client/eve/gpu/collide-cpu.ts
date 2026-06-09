// CPU executable spec for the step-7 inter-asteroid collision narrow phase + apply
// (architecture §4.2, §4.4): the exact formulas the TSL kernels (kernels/collide.ts)
// mirror, in the same CPU-spec-first discipline as binner-cpu/cull-cpu.
//
// NARROW PHASE (deferred-apply, race-free): every body accumulates ONLY its own dp/dv from
// every overlapping neighbor — no j≤i skip, no cross-lane writes (pair work is doubled by
// design, §4.2). Per contact: sphere-sphere positional pushout (half penetration, equal
// cosmetic masses) + a restitution impulse opposing approach (e = 0.15).
//
// APPLY (the cosmetic-tier reconciliation of §4.2 with the §4.5 #1 bound): instead of a
// free-running integrator, collisions accumulate into a per-slot OFFSET that is hard-capped
// at COLLISION_OFFSET_CAP_METERS, with a damped, capped velocity. With wobble (√3·40) +
// well pull (320) + this cap (250), the worst rendered displacement stays ≈ 700 m — inside
// the radius+1400 m mine slack. Gameplay reads `base`; only the renderer reads `pos`.

export const RESTITUTION = 0.15;
// Hard cap on the accumulated collision displacement (meters).
export const COLLISION_OFFSET_CAP_METERS = 250;
// Per-step velocity retention (damps cosmetic motion back to rest).
export const COLLISION_DAMPING = 0.96;
// Cosmetic speed cap (m/s).
export const COLLISION_MAX_SPEED = 30;
// Collision broad-phase grid (§4.1): 64³ cells of 768 m over a ship-snapped near-window.
export const COLLISION_GRID_AXIS = 64;
export const COLLISION_CELL_METERS = 768;
export const COLLISION_WINDOW_METERS = COLLISION_GRID_AXIS * COLLISION_CELL_METERS; // 49152

export type NarrowResult = {
  // vec4-strided per body: positional correction xyz (w unused).
  dp: Float32Array;
  // vec4-strided per body: velocity impulse xyz (w unused).
  dv: Float32Array;
};

// Reference narrow phase, brute force O(n²) over the live bodies (the GPU uses the binner's
// 27-cell grid walk; same pair set, so results match up to float-summation order). Bodies
// with radius <= 0 are dead slots and never interact.
export function narrowPhaseCPU(
  posXYZR: Float32Array,
  velXYZ: Float32Array,
  count: number,
): NarrowResult {
  const dp = new Float32Array(count * 4);
  const dv = new Float32Array(count * 4);
  for (let i = 0; i < count; i += 1) {
    const oi = i * 4;
    const ri = posXYZR[oi + 3]!;
    if (ri <= 0) {
      continue;
    }
    for (let j = 0; j < count; j += 1) {
      if (j === i) {
        continue;
      }
      const oj = j * 4;
      const rj = posXYZR[oj + 3]!;
      if (rj <= 0) {
        continue;
      }
      const dx = posXYZR[oj]! - posXYZR[oi]!;
      const dy = posXYZR[oj + 1]! - posXYZR[oi + 1]!;
      const dz = posXYZR[oj + 2]! - posXYZR[oi + 2]!;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const sumR = ri + rj;
      if (dist >= sumR || dist <= 1e-3) {
        continue;
      }
      const nx = dx / dist;
      const ny = dy / dist;
      const nz = dz / dist;
      const penetration = sumR - dist;
      // Pushout: i moves AWAY from j by half the penetration (equal cosmetic masses).
      dp[oi] = dp[oi]! - nx * penetration * 0.5;
      dp[oi + 1] = dp[oi + 1]! - ny * penetration * 0.5;
      dp[oi + 2] = dp[oi + 2]! - nz * penetration * 0.5;
      // Restitution impulse, only when approaching (vRel·n < 0). Equal masses: each body
      // takes half; dv_i = n * vn*(1+e)/2 (vn negative ⇒ i pushed along -n, away from j).
      const vrx = velXYZ[oj]! - velXYZ[oi]!;
      const vry = velXYZ[oj + 1]! - velXYZ[oi + 1]!;
      const vrz = velXYZ[oj + 2]! - velXYZ[oi + 2]!;
      const vn = vrx * nx + vry * ny + vrz * nz;
      if (vn < 0) {
        const half = (vn * (1 + RESTITUTION)) / 2;
        dv[oi] = dv[oi]! + nx * half;
        dv[oi + 1] = dv[oi + 1]! + ny * half;
        dv[oi + 2] = dv[oi + 2]! + nz * half;
      }
    }
  }
  return { dp, dv };
}

// Reference apply pass: fold dp/dv into the persistent (offset, vel) state with damping and
// hard caps. Mutates offset/vel in place (vec4 stride).
export function stepOffsetsCPU(
  offsetXYZ: Float32Array,
  velXYZ: Float32Array,
  dp: Float32Array,
  dv: Float32Array,
  count: number,
  dtSeconds: number,
): void {
  for (let i = 0; i < count; i += 1) {
    const o = i * 4;
    let vx = (velXYZ[o]! + dv[o]!) * COLLISION_DAMPING;
    let vy = (velXYZ[o + 1]! + dv[o + 1]!) * COLLISION_DAMPING;
    let vz = (velXYZ[o + 2]! + dv[o + 2]!) * COLLISION_DAMPING;
    const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
    if (speed > COLLISION_MAX_SPEED) {
      const s = COLLISION_MAX_SPEED / speed;
      vx *= s;
      vy *= s;
      vz *= s;
    }
    velXYZ[o] = vx;
    velXYZ[o + 1] = vy;
    velXYZ[o + 2] = vz;

    let ox = offsetXYZ[o]! + dp[o]! + vx * dtSeconds;
    let oy = offsetXYZ[o + 1]! + dp[o + 1]! + vy * dtSeconds;
    let oz = offsetXYZ[o + 2]! + dp[o + 2]! + vz * dtSeconds;
    const mag = Math.sqrt(ox * ox + oy * oy + oz * oz);
    if (mag > COLLISION_OFFSET_CAP_METERS) {
      const s = COLLISION_OFFSET_CAP_METERS / mag;
      ox *= s;
      oy *= s;
      oz *= s;
    }
    offsetXYZ[o] = ox;
    offsetXYZ[o + 1] = oy;
    offsetXYZ[o + 2] = oz;
  }
}
