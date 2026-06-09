import { describe, expect, test } from "bun:test";

import { deriveVirtualField } from "../../src/client/eve/field-core";
import {
  slotMeta as slotMetaBuffer,
  backingU32Of,
  MAX_RESIDENT,
} from "../../src/client/eve/gpu/buffers";
import { deriveBase, idFromSlotMeta, seedU32FromCPU } from "../../src/client/eve/gpu/base-derive";
import type { FieldSummary, Vector3 } from "../../src/shared/types";

// docs/gpu-asteroids-architecture.md §2.2 / §7 step 4 — the id↔slot bridge.
//
// The most-flagged step-4 trap: a compacted draw slot is NOT a stable rock id (atomic
// compaction order is non-deterministic), so temporal per-rock state (selection, promotion)
// must key on slotMeta -> `v-cx-cy-cz`, never on the draw slot. This gate proves the slotMeta
// reconstruction is bit-exact vs the authoritative deriveVirtualField id, headless (no GPU).

const FIELD: FieldSummary = {
  totalAsteroids: 1_000_000,
  seed: 424_242,
  cellSize: 1130,
  indexKind: "cubicCellHierarchy",
  renderedLimit: 50_000,
};

function fieldWithLimit(renderedLimit: number): FieldSummary {
  return { ...FIELD, renderedLimit };
}

const SHIP_POSITIONS: Vector3[] = [
  { x: 0, y: 0, z: 0 },
  { x: 12_000, y: -8_000, z: 30_000 },
  { x: -45_000, y: 22_000, z: -5_000 },
];

describe("GPU slotMeta id-bridge — slotMeta -> v-cx-cy-cz is bit-exact (§2.2/step 4)", () => {
  test("idFromSlotMeta reconstructs deriveVirtualField's id for every slot", () => {
    for (const position of SHIP_POSITIONS) {
      const field = fieldWithLimit(4000);
      const rocks = deriveVirtualField(position, field);
      const { slotMeta, count } = deriveBase(position, field, 4000);
      expect(count).toBe(Math.min(rocks.length, 4000));
      for (let i = 0; i < count; i += 1) {
        expect(idFromSlotMeta(slotMeta, i)).toBe(rocks[i]!.id);
      }
    }
  });

  test("slotMeta uvec4 layout matches the rock's parsed cell coords", () => {
    const position: Vector3 = { x: 0, y: 0, z: 0 };
    const field = fieldWithLimit(2000);
    const rocks = deriveVirtualField(position, field);
    const { slotMeta, count } = deriveBase(position, field, 2000);
    for (let i = 0; i < count; i += 1) {
      const parts = rocks[i]!.id.split("-"); // ["v", cx, cy, cz]
      const o = i * 4;
      expect(slotMeta[o]).toBe(Number(parts[1]));
      expect(slotMeta[o + 1]).toBe(Number(parts[2]));
      expect(slotMeta[o + 2]).toBe(Number(parts[3]));
    }
  });

  test("all cell coords lie within the FIELD 100³ id-space [0, 99] (NOT the collision 64³)", () => {
    for (const position of SHIP_POSITIONS) {
      const { slotMeta, count } = deriveBase(position, fieldWithLimit(4000), 4000);
      for (let i = 0; i < count; i += 1) {
        const o = i * 4;
        for (let k = 0; k < 3; k += 1) {
          expect(slotMeta[o + k]).toBeGreaterThanOrEqual(0);
          expect(slotMeta[o + k]).toBeLessThanOrEqual(99);
        }
      }
    }
  });

  test("residencyEpoch is carried into slotMeta.w", () => {
    const { slotMeta, count } = deriveBase({ x: 0, y: 0, z: 0 }, fieldWithLimit(500), 500, 7);
    for (let i = 0; i < count; i += 1) expect(slotMeta[i * 4 + 3]).toBe(7);
  });

  test("seedU32FromCPU writes slotMeta into the real instancedArray backing store", () => {
    const { slotMeta } = deriveBase({ x: 0, y: 0, z: 0 }, FIELD, MAX_RESIDENT, 3);
    seedU32FromCPU(slotMetaBuffer, slotMeta);
    const backing = backingU32Of(slotMetaBuffer);
    expect(backing.length).toBe(MAX_RESIDENT * 4);
    for (let i = 0; i < 4000 * 4; i += 1) expect(backing[i]).toBe(slotMeta[i]);
  });
});
