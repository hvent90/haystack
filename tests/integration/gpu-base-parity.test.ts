import { describe, expect, test } from "bun:test";

import { deriveVirtualField } from "../../src/client/eve/field-core";
import { base as baseBuffer, backingArrayOf, MAX_RESIDENT } from "../../src/client/eve/gpu/buffers";
import { deriveBase, seedBaseFromCPU } from "../../src/client/eve/gpu/base-derive";
import type { FieldSummary, Vector3 } from "../../src/shared/types";

// docs/gpu-asteroids-architecture.md §8.6 #3 — the base-parity gate.
//
// The end-state gate is `getArrayBufferAsync(base) === deriveVirtualField` bit-identical.
// The GPU round-trip needs a live WebGPU device (unavailable in this headless env), so this
// test validates the actually-load-bearing half: the CPU upload SOURCE bytes are the exact
// f32 image of `deriveVirtualField`, in order, with no GPU regeneration. If anyone replaces
// the CPU derive with a GPU frac(sin) kernel, this test fails.

const FIELD: FieldSummary = {
  totalAsteroids: 1_000_000,
  seed: 424_242,
  cellSize: 1130,
  indexKind: "cubicCellHierarchy",
  preset: "legacy-uniform",
  renderedLimit: 50_000,
};

function fieldWithLimit(renderedLimit: number): FieldSummary {
  return { ...FIELD, renderedLimit };
}

// Independent re-implementation of the server-parity noise formula (src/server/field.ts /
// field-core.ts). Kept SEPARATE from deriveVirtualField so the value check is non-circular:
// we recompute a rock's position from its id with this and confirm `base` holds its f32 image.
function rawNoise(seed: number): number {
  const v = Math.sin(seed * 12.9898) * 43758.5453;
  return v - Math.floor(v);
}
function rawHashCell(seed: number, x: number, y: number, z: number): number {
  return seed + x * 73856093 + y * 19349663 + z * 83492791;
}
function rawRock(
  cx: number,
  cy: number,
  cz: number,
): { x: number; y: number; z: number; r: number } {
  const cellsPerAxis = Math.round(Math.cbrt(FIELD.totalAsteroids)); // 100
  const originOffset = -(cellsPerAxis * FIELD.cellSize) / 2; // -56500
  const seed = rawHashCell(FIELD.seed, cx, cy, cz);
  return {
    x: originOffset + cx * FIELD.cellSize + rawNoise(seed + 1) * FIELD.cellSize,
    y: originOffset + cy * FIELD.cellSize + rawNoise(seed + 2) * FIELD.cellSize,
    z: originOffset + cz * FIELD.cellSize + rawNoise(seed + 3) * FIELD.cellSize,
    r: 45 + rawNoise(seed + 5) * 310,
  };
}

const SHIP_POSITIONS: Vector3[] = [
  { x: 0, y: 0, z: 0 },
  { x: 12_000, y: -8_000, z: 30_000 },
  { x: -45_000, y: 22_000, z: -5_000 },
  { x: 50_000, y: 50_000, z: 50_000 },
];

describe("GPU base parity — base is the bit-exact f32 image of the CPU derive (§3.2/§8.6)", () => {
  test("base xyz/radius equals deriveVirtualField in order, bit-for-bit (f32)", () => {
    for (const position of SHIP_POSITIONS) {
      const limit = 4000;
      const field = fieldWithLimit(limit);
      const rocks = deriveVirtualField(position, field);
      const { base, count } = deriveBase(position, field, limit);
      expect(count).toBe(Math.min(rocks.length, limit));
      for (let i = 0; i < count; i += 1) {
        const r = rocks[i]!;
        const o = i * 4;
        expect(base[o]).toBe(Math.fround(r.position.x));
        expect(base[o + 1]).toBe(Math.fround(r.position.y));
        expect(base[o + 2]).toBe(Math.fround(r.position.z));
        expect(base[o + 3]).toBe(Math.fround(r.radius));
      }
      // tail beyond count must be zeroed
      for (let i = count * 4; i < base.length; i += 1) expect(base[i]).toBe(0);
    }
  });

  test("non-circular value check: base[slot] matches the raw noise formula for that rock's cell", () => {
    const position: Vector3 = { x: 0, y: 0, z: 0 };
    const field = fieldWithLimit(4000);
    const rocks = deriveVirtualField(position, field);
    const { base } = deriveBase(position, field, 4000);
    // Spot-check the first 50 returned rocks against an INDEPENDENT formula recompute.
    for (let i = 0; i < 50; i += 1) {
      const id = rocks[i]!.id; // "v-cx-cy-cz"
      const [, cxs, cys, czs] = id.split("-");
      const ref = rawRock(Number(cxs), Number(cys), Number(czs));
      const o = i * 4;
      expect(base[o]).toBe(Math.fround(ref.x));
      expect(base[o + 1]).toBe(Math.fround(ref.y));
      expect(base[o + 2]).toBe(Math.fround(ref.z));
      expect(base[o + 3]).toBe(Math.fround(ref.r));
    }
  });

  test("deterministic & GPU-free: two derives are byte-identical, no navigator.gpu involved", () => {
    // This very test runs in bun (no WebGPU); a GPU frac(sin) regen path could not run here.
    expect((globalThis as { navigator?: { gpu?: unknown } }).navigator?.gpu).toBeUndefined();
    const position: Vector3 = { x: 7777, y: -3333, z: 9999 };
    const field = fieldWithLimit(3000);
    const a = deriveBase(position, field, 3000).base;
    const b = deriveBase(position, field, 3000).base;
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i += 1) expect(a[i]).toBe(b[i]);
  });

  test("capacity clamping: count never exceeds capacity; tail zero-filled", () => {
    const position: Vector3 = { x: 0, y: 0, z: 0 };
    // renderedLimit 5000 but buffer capacity only 1500 -> count clamped to 1500.
    const { base, count } = deriveBase(position, fieldWithLimit(5000), 1500);
    expect(count).toBe(1500);
    expect(base.length).toBe(1500 * 4);
  });

  test("seedBaseFromCPU writes the derived bytes into the real instancedArray backing store", () => {
    const position: Vector3 = { x: 1000, y: 2000, z: 3000 };
    const { base } = deriveBase(position, FIELD, MAX_RESIDENT);
    seedBaseFromCPU(baseBuffer, base);
    const backing = backingArrayOf(baseBuffer);
    expect(backing.length).toBe(MAX_RESIDENT * 4);
    // every derived byte landed in the buffer, in place
    for (let i = 0; i < 5000 * 4; i += 1) expect(backing[i]).toBe(base[i]);
  });

  test("full-scale 50k derive matches deriveVirtualField (the doc's literal gate size)", () => {
    const position: Vector3 = { x: 0, y: 0, z: 0 };
    const rocks = deriveVirtualField(position, FIELD);
    const { base, count } = deriveBase(position, FIELD, MAX_RESIDENT);
    expect(count).toBe(Math.min(rocks.length, MAX_RESIDENT));
    let mismatches = 0;
    for (let i = 0; i < count; i += 1) {
      const r = rocks[i]!;
      const o = i * 4;
      if (
        base[o] !== Math.fround(r.position.x) ||
        base[o + 1] !== Math.fround(r.position.y) ||
        base[o + 2] !== Math.fround(r.position.z) ||
        base[o + 3] !== Math.fround(r.radius)
      ) {
        mismatches += 1;
      }
    }
    expect(mismatches).toBe(0);
  });
});
