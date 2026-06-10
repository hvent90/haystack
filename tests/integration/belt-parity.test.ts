import { beforeAll, describe, expect, test } from "bun:test";

import { loadBeltBakeSync } from "../../src/server/belt-bake";
import { fieldSummary, streamedFieldAsteroids } from "../../src/server/field";
import { deriveVirtualField, setActiveBeltBake } from "../../src/client/eve/field-core";
import { deriveBase } from "../../src/client/eve/gpu/base-derive";
import { setFieldAnchor, snapAnchor } from "../../src/client/eve/gpu/anchor";
import {
  beltCellCoords,
  beltRockAt,
  deriveBeltField,
  makeBeltField,
  sampleDensity,
} from "../../src/shared/belt/field";
import {
  BELT_CELL_KEY_BASE_XZ,
  BELT_CELL_KEY_BASE_Y,
  beltCellKey,
  beltFieldInfo,
} from "../../src/shared/belt/format";
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
  { x: -900000, y: -4000, z: 1100000 }, // opposite side of the belt
  { x: 0, y: 12000, z: 1700000 }, // outer band
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
        sum += sampleDensity(belt, r * Math.cos(theta), 0, r * Math.sin(theta));
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

// Saturn-scale far-from-origin parity (the Thread B precision gate): a bake whose meta
// declares a world block runs at worldScale ~7.45e7, putting ring coordinates near 1.4e8 m
// — far beyond f32-exact territory. This block pins (1) deterministic f64 derivation at
// those coordinates across independent bake loads, (2) the asymmetric cell-key packing
// (cellsXZ ~264k would overflow the old 8192³ scheme), and (3) the GPU base image staying
// ANCHOR-RELATIVE small (gpu/anchor.ts) so f32 quantization stays sub-centimeter.
// Runs against the production `saturn` preset once committed; falls back to the
// `saturn-smoke` spike artifacts; skips when neither is present.
describe("saturn-scale far-from-origin parity", () => {
  const presetName = ["saturn", "saturn-smoke"].find(
    (name) => loadBeltBakeSync(name, 1130) !== null,
  );
  const hasSaturn = presetName !== undefined;

  test.skipIf(!hasSaturn)("f64 derivation is deterministic at ~1.4e8 m", () => {
    const bakeA = loadBeltBakeSync(presetName!, 1130)!;
    const bakeB = loadBeltBakeSync(presetName!, 1130)!;
    expect(bakeA.worldScale).toBeGreaterThan(1e7); // the world block actually applied
    const a = makeBeltField(bakeA, 424242, 1);
    const b = makeBeltField(bakeB, 424242, 1);
    // Probe positions across the ring system, including the far side (negative coords).
    const probes: Vector3[] = [
      { x: 1.2656 * bakeA.worldScale, y: 20, z: 250 }, // station band
      { x: -1.4 * bakeA.worldScale, y: -3000, z: 0.35 * bakeA.worldScale }, // far side
      { x: 0, y: 0, z: 1.68 * bakeA.worldScale }, // A-ring analogue
    ];
    let materialized = 0;
    for (const p of probes) {
      const ca = beltCellCoords(a, p);
      for (let dx = -4; dx <= 4; dx += 2) {
        for (let dz = -4; dz <= 4; dz += 2) {
          const ra = beltRockAt(a, ca.cx + dx, ca.cy, ca.cz + dz);
          const rb = beltRockAt(b, ca.cx + dx, ca.cy, ca.cz + dz);
          expect(rb === null).toBe(ra === null);
          if (ra !== null && rb !== null) {
            materialized += 1;
            expect(rb.id).toBe(ra.id);
            expect(rb.position.x).toBe(ra.position.x);
            expect(rb.position.y).toBe(ra.position.y);
            expect(rb.position.z).toBe(ra.position.z);
            expect(rb.radius).toBe(ra.radius);
          }
        }
      }
    }
    expect(materialized).toBeGreaterThan(0);
  });

  test.skipIf(!hasSaturn)("hero cell keys survive the ~264k-cell grid (no collisions lost)", () => {
    const bake = loadBeltBakeSync(presetName!, 1130)!;
    expect(bake.geo.cellsXZ).toBeGreaterThan(BELT_CELL_KEY_BASE_Y); // old scheme would throw
    expect(bake.geo.cellsXZ).toBeLessThan(BELT_CELL_KEY_BASE_XZ);
    expect(bake.geo.cellsY).toBeLessThan(BELT_CELL_KEY_BASE_Y);
    // Every decoded hero must be reachable through its packed cell key, and the key must
    // round-trip to exact integer cell coordinates (2^53 exactness).
    expect(bake.heroes.byCell.size).toBeGreaterThan(0);
    for (const [key, heroIndex] of bake.heroes.byCell) {
      expect(Number.isSafeInteger(key)).toBe(true);
      const cz = key % BELT_CELL_KEY_BASE_XZ;
      const rest = (key - cz) / BELT_CELL_KEY_BASE_XZ;
      const cy = rest % BELT_CELL_KEY_BASE_Y;
      const cx = (rest - cy) / BELT_CELL_KEY_BASE_Y;
      expect(beltCellKey(cx, cy, cz)).toBe(key);
      const o = heroIndex * 4;
      const hx = bake.heroes.posRadius[o]!;
      const hy = bake.heroes.posRadius[o + 1]!;
      const hz = bake.heroes.posRadius[o + 2]!;
      expect(Math.floor((hx - bake.geo.originXZ) / bake.geo.cellSize)).toBe(cx);
      expect(Math.floor((hy - bake.geo.originY) / bake.geo.cellSize)).toBe(cy);
      expect(Math.floor((hz - bake.geo.originXZ) / bake.geo.cellSize)).toBe(cz);
    }
  });

  test.skipIf(!hasSaturn)("GPU base image is anchor-relative and f32-precise at 1.4e8 m", () => {
    const bake = loadBeltBakeSync(presetName!, 1130)!;
    const belt = makeBeltField(bake, 424242, 1);
    const position: Vector3 = { x: 1.2656 * bake.worldScale, y: 20, z: 250 };
    const anchor = snapAnchor(position);
    setFieldAnchor(anchor);
    try {
      const rocks = deriveBeltField(belt, position, 500);
      expect(rocks.length).toBeGreaterThan(0);
      const summary: FieldSummary = {
        totalAsteroids: 0,
        seed: 424242,
        cellSize: 1130,
        indexKind: "beltBakeV1",
        renderedLimit: 500,
        belt: beltFieldInfo(bake, 1),
      };
      setActiveBeltBake(bake, summary);
      const { base, count } = deriveBase(position, summary, 500);
      expect(count).toBeGreaterThan(0);
      for (let i = 0; i < count; i += 1) {
        const o = i * 4;
        // Anchor-relative: small magnitudes (≤ rebase distance + derive bubble), and the
        // f64-subtract-then-fround recipe exactly.
        expect(Math.abs(base[o]!)).toBeLessThan(2e5);
        expect(Math.abs(base[o + 2]!)).toBeLessThan(2e5);
        const r = rocks[i]!;
        expect(base[o]).toBe(Math.fround(r.position.x - anchor.x));
        expect(base[o + 1]).toBe(Math.fround(r.position.y - anchor.y));
        expect(base[o + 2]).toBe(Math.fround(r.position.z - anchor.z));
        // f32 ULP at ≤2e5 m is ≤ 0.0156 m: the stored value must sit within 2 cm of the
        // f64 truth — the Saturn-scale quantization bug would show ~8-16 m here.
        expect(Math.abs(base[o]! - (r.position.x - anchor.x))).toBeLessThan(0.02);
        expect(Math.abs(base[o + 2]! - (r.position.z - anchor.z))).toBeLessThan(0.02);
      }
    } finally {
      setFieldAnchor({ x: 0, y: 0, z: 0 });
      // Re-register the active server bake so later tests see the suite's own state.
      setActiveBeltBake(loadBeltBakeSync(field.belt!.preset, field.cellSize)!, field);
    }
  });
});

function cellOfSpawn(): { cx: number; cy: number; cz: number } {
  const geo = {
    cellSize: field.cellSize,
    originXZ: -(field.belt!.cellsXZ * field.cellSize) / 2,
    originY: -(field.belt!.cellsY * field.cellSize) / 2,
  };
  return {
    cx: Math.floor((1264900 - geo.originXZ) / geo.cellSize),
    cy: Math.floor((20 - geo.originY) / geo.cellSize),
    cz: Math.floor((250 - geo.originXZ) / geo.cellSize),
  };
}
