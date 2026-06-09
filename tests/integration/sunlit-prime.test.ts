// The aSunlit occlusion march (sun-occlusion.ts) is a per-NEW-rock cost. Marching 50k cold
// rocks on the main thread cost ~440ms at boot (caught by bench:gpu-cross after wiring
// aSunlit into the ring streamer), so the field WORKER computes sunlit alongside the derive
// and the main thread just primes its cache from the transferred values — sunlitForId then
// never marches for worker-delivered rocks.

import { describe, expect, test } from "bun:test";
import { computeSunlit, primeSunlitCells, sunlitForId } from "../../src/client/eve/sun-occlusion";

describe("primeSunlitCells", () => {
  test("a primed cell's value is served by sunlitForId without recomputation", () => {
    // Use a sentinel value that the real march could never produce (> 1) to prove the
    // primed value is what's served, not a fresh march.
    const cells = new Int32Array([10, 20, 30]);
    const values = new Float64Array([7.5]);
    primeSunlitCells(cells, values, 1);
    expect(sunlitForId("v-10-20-30")).toBe(7.5);
  });

  test("an unprimed cell still computes the real march value", () => {
    const expected = computeSunlit(11, 21, 31);
    expect(sunlitForId("v-11-21-31")).toBe(expected);
  });

  test("priming does not override an already-resolved id", () => {
    const resolved = sunlitForId("v-12-22-32");
    primeSunlitCells(new Int32Array([12, 22, 32]), new Float64Array([9.9]), 1);
    expect(sunlitForId("v-12-22-32")).toBe(resolved);
  });
});
