// CPU executable spec for the step-7 inter-asteroid collision narrow phase (architecture
// §4.2): 27-cell deferred-apply sphere-sphere pushout + restitution impulse, each lane
// accumulating ONLY its own dp[i]/dv[i] (the race-free deferred form, which double-counts
// pair work by design). collide-cpu.ts is the reference the TSL kernel mirrors; the
// on-device gate compares GPU dp/dv against it (tolerance: float-addition order differs).

import { describe, expect, test } from "bun:test";
import {
  COLLISION_OFFSET_CAP_METERS,
  narrowPhaseCPU,
  RESTITUTION,
  stepOffsetsCPU,
} from "../../src/client/eve/gpu/collide-cpu";

function bodies(list: Array<[number, number, number, number]>): Float32Array {
  const pos = new Float32Array(list.length * 4);
  list.forEach(([x, y, z, r], i) => pos.set([x, y, z, r], i * 4));
  return pos;
}

describe("narrowPhaseCPU", () => {
  test("a resting overlapping pair separates symmetrically along the axis (half-penetration each)", () => {
    // Two 100m rocks, centers 150m apart on x: penetration 50m -> each pushed 25m apart.
    const pos = bodies([
      [0, 0, 0, 100],
      [150, 0, 0, 100],
    ]);
    const vel = new Float32Array(2 * 4);
    const { dp, dv } = narrowPhaseCPU(pos, vel, 2);
    expect(dp[0]).toBeCloseTo(-25, 5);
    expect(dp[4]).toBeCloseTo(25, 5);
    expect(dp[1]).toBeCloseTo(0, 5);
    expect(dp[5]).toBeCloseTo(0, 5);
    // At rest: no impulse.
    for (let i = 0; i < 8; i += 1) expect(dv[i]).toBeCloseTo(0, 6);
  });

  test("non-overlapping rocks are untouched", () => {
    const pos = bodies([
      [0, 0, 0, 100],
      [500, 0, 0, 100],
    ]);
    const vel = new Float32Array(2 * 4);
    const { dp, dv } = narrowPhaseCPU(pos, vel, 2);
    for (let i = 0; i < 8; i += 1) {
      expect(dp[i]).toBe(0);
      expect(dv[i]).toBe(0);
    }
  });

  test("an approaching pair receives a separating restitution impulse that conserves momentum", () => {
    const pos = bodies([
      [0, 0, 0, 100],
      [150, 0, 0, 100],
    ]);
    const vel = new Float32Array(2 * 4);
    vel[0] = 10; // body 0 moving +x toward body 1
    vel[4] = -10; // body 1 moving -x toward body 0
    const { dv } = narrowPhaseCPU(pos, vel, 2);
    // vRel·n = -20 (approaching). Impulse halves: dv0.x = vn*(1+e)/2 < 0, dv1.x > 0.
    const expected = (-20 * (1 + RESTITUTION)) / 2;
    expect(dv[0]).toBeCloseTo(expected, 5);
    expect(dv[4]).toBeCloseTo(-expected, 5);
    // Momentum: sum of dv is zero.
    expect(dv[0]! + dv[4]!).toBeCloseTo(0, 6);
  });

  test("a separating pair receives NO impulse (restitution only opposes approach)", () => {
    const pos = bodies([
      [0, 0, 0, 100],
      [150, 0, 0, 100],
    ]);
    const vel = new Float32Array(2 * 4);
    vel[0] = -5; // moving apart
    vel[4] = 5;
    const { dv } = narrowPhaseCPU(pos, vel, 2);
    for (let i = 0; i < 8; i += 1) expect(dv[i]).toBeCloseTo(0, 6);
  });

  test("a three-body chain accumulates pushout from BOTH neighbors (deferred-apply sums)", () => {
    // Middle rock overlapped by both sides equally: net dp == 0, sides push outward.
    const pos = bodies([
      [-150, 0, 0, 100],
      [0, 0, 0, 100],
      [150, 0, 0, 100],
    ]);
    const vel = new Float32Array(3 * 4);
    const { dp } = narrowPhaseCPU(pos, vel, 3);
    expect(dp[0]).toBeCloseTo(-25, 5);
    expect(dp[4]).toBeCloseTo(0, 5);
    expect(dp[8]).toBeCloseTo(25, 5);
  });
});

describe("stepOffsetsCPU (apply pass)", () => {
  test("accumulates dp and clamps the total offset to the hard cap", () => {
    const offset = new Float32Array(4);
    const vel = new Float32Array(4);
    const dp = new Float32Array([COLLISION_OFFSET_CAP_METERS * 2, 0, 0, 0]);
    const dv = new Float32Array(4);
    stepOffsetsCPU(offset, vel, dp, dv, 1, 1 / 60);
    expect(Math.hypot(offset[0]!, offset[1]!, offset[2]!)).toBeLessThanOrEqual(
      COLLISION_OFFSET_CAP_METERS + 1e-6,
    );
    expect(offset[0]).toBeGreaterThan(0);
  });

  test("velocity decays toward zero when no impulses arrive", () => {
    const offset = new Float32Array(4);
    const vel = new Float32Array([10, 0, 0, 0]);
    const dp = new Float32Array(4);
    const dv = new Float32Array(4);
    for (let i = 0; i < 600; i += 1) {
      stepOffsetsCPU(offset, vel, dp, dv, 1, 1 / 60);
    }
    expect(Math.abs(vel[0]!)).toBeLessThan(0.5);
  });
});
