import { beforeAll, describe, expect, test } from "bun:test";

import { loadBeltBakeSync } from "../../src/server/belt-bake";
import { fieldSummary, streamedFieldAsteroids } from "../../src/server/field";
import { deriveVirtualField, setActiveBeltBake } from "../../src/client/eve/field-core";
import { deriveBase } from "../../src/client/eve/gpu/base-derive";
import { beltRockAt, makeBeltField, sampleDensity } from "../../src/shared/belt/field";
import type { FieldSummary, Vector3 } from "../../src/shared/types";

// Belt-mode parity gate (the bake-driven successor of gpu-base-parity's guarantee):
// the SERVER derive (field.ts -> shared belt module over its disk-loaded bake) and the
// CLIENT derive (field-core -> shared belt module over its registered bake) must produce
// bit-identical rocks, and the GPU `base` upload bytes must be the exact f32 image of
// that derive (docs/gpu-asteroids-architecture.md §3.2 — the GPU never regenerates).

let field: FieldSummary;

beforeAll(() => {
  field = fieldSummary();
  if (field.belt === undefined) {
    throw new Error("belt parity test requires the server to be in belt mode");
  }
  const bake = loadBeltBakeSync(field.belt.preset, field.cellSize);
  if (bake === null) {
    throw new Error("belt bake artifacts missing under public/belt/");
  }
  setActiveBeltBake(bake, field);
});

// Positions inside the belt annulus (the station spawn band) and in sparse regions.
const POSITIONS: Vector3[] = [
  { x: 1264900, y: 20, z: 250 }, // station spawn
  { x: -900000, y: 1100000, z: -4000 }, // opposite side of the belt
  { x: 0, y: 1700000, z: 12000 }, // outer band
  { x: 600000, y: 0, z: 0 }, // inner void edge (sparse: may yield few rocks)
];

describe("belt parity — one derivation, three consumers", () => {
  test("server streamedFieldAsteroids === client deriveVirtualField, bit for bit", () => {
    for (const position of POSITIONS) {
      const fromServer = streamedFieldAsteroids(position);
      const fromClient = deriveVirtualField(position, field);
      expect(fromClient.length).toBe(fromServer.length);
      for (let i = 0; i < fromServer.length; i += 1) {
        const s = fromServer[i]!;
        const c = fromClient[i]!;
        expect(c.id).toBe(s.id);
        expect(c.position.x).toBe(s.position.x);
        expect(c.position.y).toBe(s.position.y);
        expect(c.position.z).toBe(s.position.z);
        expect(c.radius).toBe(s.radius);
        expect(c.signature).toBe(s.signature);
        expect(c.mineralRichness).toBe(s.mineralRichness);
        expect(c.rareMineral).toBe(s.rareMineral);
        expect(c.pocket).toBe(s.pocket);
      }
    }
  });

  test("GPU base bytes are the exact f32 image of the belt derive, in order", () => {
    const position = POSITIONS[0]!;
    const rocks = deriveVirtualField(position, field);
    expect(rocks.length).toBeGreaterThan(1000);
    const { base, count } = deriveBase(position, field, 4000);
    expect(count).toBe(Math.min(rocks.length, 4000));
    for (let i = 0; i < count; i += 1) {
      const r = rocks[i]!;
      const o = i * 4;
      expect(base[o]).toBe(Math.fround(r.position.x));
      expect(base[o + 1]).toBe(Math.fround(r.position.y));
      expect(base[o + 2]).toBe(Math.fround(r.position.z));
      expect(base[o + 3]).toBe(Math.fround(r.radius));
    }
  });

  test("two independent bake loads derive identical rocks (no hidden state)", () => {
    const bakeA = loadBeltBakeSync(field.belt!.preset, field.cellSize)!;
    const bakeB = loadBeltBakeSync(field.belt!.preset, field.cellSize)!;
    const a = makeBeltField(bakeA, field.seed, field.belt!.densityScale);
    const b = makeBeltField(bakeB, field.seed, field.belt!.densityScale);
    const { cx, cy, cz } = cellOfSpawn();
    for (let dx = -6; dx <= 6; dx += 3) {
      for (let dy = -6; dy <= 6; dy += 3) {
        const ra = beltRockAt(a, cx + dx, cy + dy, cz);
        const rb = beltRockAt(b, cx + dx, cy + dy, cz);
        expect(rb === null).toBe(ra === null);
        if (ra !== null && rb !== null) {
          expect(rb.position.x).toBe(ra.position.x);
          expect(rb.id).toBe(ra.id);
        }
      }
    }
  });

  test("structure is real: band density ≫ resonance-gap density, heroes exist", () => {
    const bake = loadBeltBakeSync(field.belt!.preset, field.cellSize)!;
    const belt = makeBeltField(bake, field.seed, field.belt!.densityScale);
    expect(bake.heroes.count).toBeGreaterThan(100);
    expect(bake.heroes.byCell.size).toBeGreaterThan(100);
    // Azimuthal average of sampled density at a band radius vs the inner void.
    const probe = (r: number): number => {
      let sum = 0;
      for (let k = 0; k < 64; k += 1) {
        const theta = (k / 64) * Math.PI * 2;
        sum += sampleDensity(belt, r * Math.cos(theta), r * Math.sin(theta), 0);
      }
      return sum / 64;
    };
    const band = probe(1.27e6);
    const voidInner = probe(0.55e6);
    expect(band).toBeGreaterThan(0.05);
    expect(voidInner).toBeLessThan(band * 0.05);
  });

  test("derive returns fewer rocks in sparse space (emptiness is terrain, not error)", () => {
    const sparse = deriveVirtualField({ x: 600000, y: 0, z: 0 }, field);
    const dense = deriveVirtualField({ x: 1264900, y: 20, z: 250 }, field);
    expect(dense.length).toBeGreaterThan(sparse.length);
  });
});

function cellOfSpawn(): { cx: number; cy: number; cz: number } {
  const geo = {
    cellSize: field.cellSize,
    originXY: -(field.belt!.cellsXY * field.cellSize) / 2,
    originZ: -(field.belt!.cellsZ * field.cellSize) / 2,
  };
  return {
    cx: Math.floor((1264900 - geo.originXY) / geo.cellSize),
    cy: Math.floor((20 - geo.originXY) / geo.cellSize),
    cz: Math.floor((250 - geo.originZ) / geo.cellSize),
  };
}
