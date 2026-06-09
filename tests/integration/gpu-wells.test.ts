// Gravity wells (architecture §4.3, §7 step 6): K ≤ 8 cosmetic attractors that pull rocks
// into local knots — the thing that MAKES collisions happen at the field's native density.
// Same safety discipline as the wobble (§4.5 #1): the pull is a PURE bounded function of
// `base` (deterministic, eviction-lossless, no integrator), with the TOTAL displacement
// capped so pos stays inside the mine slack. wells.ts carries the CPU mirror of the TSL
// pull formula; this pins the bound and the well derivation.

import { describe, expect, test } from "bun:test";
import {
  deriveGravityWells,
  MAX_WELLS,
  WELL_PULL_CAP_METERS,
  wellPullMeters,
} from "../../src/client/eve/gpu/wells";
import { WOBBLE_AMPLITUDE_METERS } from "../../src/client/eve/gpu/kernels/overlay";

describe("deriveGravityWells", () => {
  test("derives at most MAX_WELLS deterministic wells inside the field cube", () => {
    const wells = deriveGravityWells();
    expect(wells.length).toBeGreaterThan(0);
    expect(wells.length).toBeLessThanOrEqual(MAX_WELLS);
    const again = deriveGravityWells();
    expect(again).toEqual(wells);
    for (const well of wells) {
      // Field cube spans ±56500 m (originOffset .. -originOffset).
      for (const c of [well.x, well.y, well.z]) {
        expect(Math.abs(c)).toBeLessThanOrEqual(56500);
      }
      expect(well.strength).toBeGreaterThan(0);
      expect(well.strength).toBeLessThanOrEqual(1);
    }
  });
});

describe("wellPullMeters bound (§4.5 #1)", () => {
  test("total pull magnitude never exceeds WELL_PULL_CAP_METERS, even at well centers", () => {
    const wells = deriveGravityWells();
    let maxPull = 0;
    // Sweep a grid through the field INCLUDING the exact well centers (the singular point).
    const probes: Array<[number, number, number]> = [];
    for (const well of wells) {
      probes.push([well.x, well.y, well.z]);
      probes.push([well.x + 1, well.y, well.z]);
      probes.push([well.x + 500, well.y - 500, well.z + 250]);
    }
    for (let i = -5; i <= 5; i += 1) {
      probes.push([i * 11000, i * 7000, i * 5000]);
    }
    for (const [x, y, z] of probes) {
      const pull = wellPullMeters(x, y, z, wells);
      const mag = Math.hypot(pull.x, pull.y, pull.z);
      expect(mag).toBeLessThanOrEqual(WELL_PULL_CAP_METERS + 1e-9);
      maxPull = Math.max(maxPull, mag);
    }
    // The cap must actually be approached near well centers (meaningful clumping).
    expect(maxPull).toBeGreaterThan(WELL_PULL_CAP_METERS * 0.5);
  });

  test("pull never overshoots the well (a rock at distance d moves less than d)", () => {
    const wells = deriveGravityWells().slice(0, 1);
    const well = wells[0]!;
    for (const d of [1, 10, 100, 1000, 5000]) {
      const pull = wellPullMeters(well.x + d, well.y, well.z, wells);
      expect(Math.hypot(pull.x, pull.y, pull.z)).toBeLessThan(d);
    }
  });

  test("total cosmetic displacement (wobble + pull) stays far inside the 1400 m mine slack", () => {
    const worst = Math.sqrt(3) * WOBBLE_AMPLITUDE_METERS + WELL_PULL_CAP_METERS;
    // Max rock radius is 355 m; slack is radius + 1400. Worst displacement must stay under
    // 1400 with margin so even a radius-0 hypothetical stays valid.
    expect(worst).toBeLessThan(1400 * 0.5);
  });

  test("far from every well the pull is negligible (native field untouched)", () => {
    const wells = deriveGravityWells();
    // A point at least 3 sigma from every well.
    let probe: [number, number, number] | null = null;
    for (let i = 0; i < 1000 && probe === null; i += 1) {
      const candidate: [number, number, number] = [
        ((i * 7919) % 113000) - 56500,
        ((i * 104729) % 113000) - 56500,
        ((i * 1299709) % 113000) - 56500,
      ];
      const farFromAll = wells.every(
        (well) =>
          Math.hypot(candidate[0] - well.x, candidate[1] - well.y, candidate[2] - well.z) > 12000,
      );
      if (farFromAll) probe = candidate;
    }
    expect(probe).not.toBeNull();
    const pull = wellPullMeters(probe![0], probe![1], probe![2], wells);
    expect(Math.hypot(pull.x, pull.y, pull.z)).toBeLessThan(1);
  });
});
