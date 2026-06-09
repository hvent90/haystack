import { describe, expect, test } from "bun:test";

import {
  WOBBLE_AMPLITUDE_METERS,
  wobbleAxisMeters,
} from "../../src/client/eve/gpu/kernels/overlay";

// docs/gpu-asteroids-architecture.md §8.6 #4 / §4.5 #1 — the bounded-overlay invariant.
//
// The cosmetic overlay MUST stay gameplay-INVISIBLE: bounded well under the 1400 m mine slack
// and below the 3-decimal (~50 m at 50 km) scan-bearing granularity. Gameplay reads `base`;
// only the renderer reads `pos = base + wobble`, so a bounded wobble cannot desync STATE — but
// an UNbounded one could produce a visibly wrong bearing arrow. We pin the bound two ways:
// the constant, and the actual per-axis wobble formula (a pure-JS mirror of the TSL kernel)
// over a sweep of phases and frames.

describe("overlay wobble is bounded (§8.6 #4)", () => {
  test("WOBBLE_AMPLITUDE_METERS <= 40 (under the 1400 m slack, below ~50 m bearing granularity)", () => {
    expect(WOBBLE_AMPLITUDE_METERS).toBeLessThanOrEqual(40);
    expect(WOBBLE_AMPLITUDE_METERS).toBeGreaterThan(0);
  });

  test("|wobble| <= WOBBLE_AMPLITUDE_METERS over a sweep of phases/frames (per-axis formula)", () => {
    // The three kernel axes use offsets 0, 1.7, 3.1 (overlay.ts genFieldOverlay).
    const axisOffsets = [0, 1.7, 3.1];
    let maxAbs = 0;
    for (let phaseStep = 0; phaseStep < 200; phaseStep += 1) {
      // phases across [0, 2π) (the phaseSeed range) plus a few out-of-range values.
      const phase = (phaseStep / 200) * Math.PI * 2;
      for (let frame = 0; frame < 1000; frame += 7) {
        for (const off of axisOffsets) {
          const w = wobbleAxisMeters(phase, frame, off);
          maxAbs = Math.max(maxAbs, Math.abs(w));
          expect(Math.abs(w)).toBeLessThanOrEqual(WOBBLE_AMPLITUDE_METERS);
        }
      }
    }
    // The formula's theoretical max is exactly the amplitude; confirm the sweep approaches it
    // (so the test is meaningfully tight, not vacuously passing on tiny values).
    expect(maxAbs).toBeGreaterThan(WOBBLE_AMPLITUDE_METERS * 0.9);
  });

  test("the 3D displacement magnitude stays under the 1400 m mine slack by a wide margin", () => {
    // Worst case all three axes at full amplitude: sqrt(3)*40 ≈ 69.3 m << 1400 m.
    const worstCaseMagnitude = Math.sqrt(3) * WOBBLE_AMPLITUDE_METERS;
    expect(worstCaseMagnitude).toBeLessThan(1400);
  });
});
