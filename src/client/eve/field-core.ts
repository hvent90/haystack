import type { Asteroid, FieldSummary, Mineral, Vector3 } from "../../shared/types";
import {
  type BeltField,
  deriveBeltField,
  makeBeltField,
  pocketForZone,
  zoneAtRadius,
} from "../../shared/belt/field";
import type { BeltBake } from "../../shared/belt/format";

// Pure, dependency-free reconstruction of the deterministic virtual asteroid field.
//
// This module is imported BOTH on the main thread (FieldDeriver in field-derivation.ts)
// AND inside the field-derivation Web Worker (field-worker.ts). It must therefore stay
// free of any DOM / render-stats / window coupling — only field math + (un)packing.
//
// The server no longer streams the (up to 100k) static virtual rocks every cell
// crossing — it sends only the small mutable seeded set. The field is a pure function of
// the seed + the ship's cell, so the client regenerates it locally here, exactly
// mirroring src/server/field.ts's generator. Math.sin is not bit-portable across JS
// engines, but nothing compares these client-derived rocks against the server — the
// client is now the sole source of virtual rocks, and scan hits carry their own
// server-computed bearing/distance — so any engine ULP difference is purely cosmetic
// (sub-nanometre) and never a correctness issue.

const MINERALS: Mineral[] = ["nickel", "waterIce", "cobalt", "silicates", "platinum", "xenotime"];

// --- belt mode -------------------------------------------------------------------------
//
// When the server publishes a belt-bake field (FieldSummary.belt), structure comes from
// the shared belt derivation (src/shared/belt/field.ts) over artifacts fetched from
// public/belt/<preset>/ (belt-bake-loader.ts). The bake is registered here once per
// realm (main thread and the field worker each register their own copy of the same
// bytes), after which every derive below routes through it.

let activeBelt: BeltField | null = null;
let activeBeltPreset: string | null = null;

export function setActiveBeltBake(bake: BeltBake, field: FieldSummary): void {
  if (field.belt === undefined) {
    throw new Error("setActiveBeltBake: field summary has no belt block");
  }
  if (bake.geo.cellsXZ !== field.belt.cellsXZ || bake.geo.cellsY !== field.belt.cellsY) {
    throw new Error(
      `belt bake grid ${bake.geo.cellsXZ}x${bake.geo.cellsY} != server ` +
        `${field.belt.cellsXZ}x${field.belt.cellsY} — artifact/preset mismatch`,
    );
  }
  activeBelt = makeBeltField(bake, field.seed, field.belt.densityScale);
  activeBeltPreset = field.belt.preset;
}

export function activeBeltField(): BeltField | null {
  return activeBelt;
}

// True when derives for this field summary can run now (legacy fields always can; belt
// fields need their bake registered first).
export function beltReady(field: FieldSummary): boolean {
  return (
    field.belt === undefined || (activeBelt !== null && activeBeltPreset === field.belt.preset)
  );
}

function hashCell(seed: number, x: number, y: number, z: number): number {
  return seed + x * 73856093 + y * 19349663 + z * 83492791;
}

function noise(seed: number): number {
  const value = Math.sin(seed * 12.9898) * 43758.5453;
  return value - Math.floor(value);
}

function pocketForCell(cellX: number): string {
  if (cellX < 33) {
    return "inner-drift";
  }
  if (cellX < 66) {
    return "black-thread";
  }
  return "long-echo";
}

type FieldGeometry = {
  seed: number;
  cellSize: number;
  cellsPerAxis: number;
  originOffset: number;
  limit: number;
};

function geometryOf(field: FieldSummary): FieldGeometry {
  const cellsPerAxis = Math.max(1, Math.round(Math.cbrt(field.totalAsteroids)));
  return {
    seed: field.seed,
    cellSize: field.cellSize,
    cellsPerAxis,
    originOffset: -(cellsPerAxis * field.cellSize) / 2,
    limit: Math.max(1, field.renderedLimit),
  };
}

export function clampCell(value: number, cellsPerAxis: number): number {
  return Math.max(0, Math.min(cellsPerAxis - 1, value));
}

// The integer cell a world position falls in (clamped to the field bounds). Shared by
// the deriver and the cell-key memo so the "did we cross a cell" check stays consistent.
export function cellCoords(
  position: Vector3,
  field: FieldSummary,
): { cx: number; cy: number; cz: number } {
  if (field.belt !== undefined) {
    // Belt grids are non-cubic; geometry comes from the summary's belt block alone so
    // cell-cross detection works even before the bake bytes are registered.
    const cellSize = field.cellSize;
    const originXZ = -(field.belt.cellsXZ * cellSize) / 2;
    const originY = -(field.belt.cellsY * cellSize) / 2;
    return {
      cx: clampCell(Math.floor((position.x - originXZ) / cellSize), field.belt.cellsXZ),
      cy: clampCell(Math.floor((position.y - originY) / cellSize), field.belt.cellsY),
      cz: clampCell(Math.floor((position.z - originXZ) / cellSize), field.belt.cellsXZ),
    };
  }
  const geo = geometryOf(field);
  return {
    cx: clampCell(Math.floor((position.x - geo.originOffset) / geo.cellSize), geo.cellsPerAxis),
    cy: clampCell(Math.floor((position.y - geo.originOffset) / geo.cellSize), geo.cellsPerAxis),
    cz: clampCell(Math.floor((position.z - geo.originOffset) / geo.cellSize), geo.cellsPerAxis),
  };
}

function virtualAsteroidAt(geo: FieldGeometry, cx: number, cy: number, cz: number): Asteroid {
  const seed = hashCell(geo.seed, cx, cy, cz);
  return {
    id: `v-${cx}-${cy}-${cz}`,
    pocket: pocketForCell(cx),
    position: {
      x: geo.originOffset + cx * geo.cellSize + noise(seed + 1) * geo.cellSize,
      y: geo.originOffset + cy * geo.cellSize + noise(seed + 2) * geo.cellSize,
      z: geo.originOffset + cz * geo.cellSize + noise(seed + 3) * geo.cellSize,
    },
    radius: 45 + noise(seed + 5) * 310,
    signature: 0.08 + noise(seed + 6) * 0.7,
    mineralRichness: 0.18 + noise(seed + 7) * 0.82,
    rareMineral:
      MINERALS[Math.floor(noise(seed + 4) * MINERALS.length) % MINERALS.length] ?? "nickel",
    discovered: true,
  };
}

// The nearest `renderedLimit` virtual rocks to the ship's CELL CENTER, sorted nearest
// first (matching the server's old streamedFieldAsteroids). Snapping the query to the
// cell center makes the result a pure function of the cell, so it only changes when the
// ship crosses a cell boundary — not as it drifts within a cell.
//
// A cube of cells grown around the ship is scanned until it provably contains the global
// nearest `renderedLimit` (the limit-th rock is closer than any unscanned cell) or spans
// the whole field. This is O(rendered) rather than the server's old O(field) full scan.
export function deriveVirtualField(position: Vector3, field: FieldSummary): Asteroid[] {
  if (field.belt !== undefined) {
    if (!beltReady(field)) {
      throw new Error(
        `deriveVirtualField: belt bake "${field.belt.preset}" not registered ` +
          "(callers must gate on beltReady / ensureBeltBake first)",
      );
    }
    return deriveBeltField(activeBelt!, position, Math.max(1, field.renderedLimit));
  }
  const geo = geometryOf(field);
  const last = geo.cellsPerAxis - 1;
  const cx = clampCell(
    Math.floor((position.x - geo.originOffset) / geo.cellSize),
    geo.cellsPerAxis,
  );
  const cy = clampCell(
    Math.floor((position.y - geo.originOffset) / geo.cellSize),
    geo.cellsPerAxis,
  );
  const cz = clampCell(
    Math.floor((position.z - geo.originOffset) / geo.cellSize),
    geo.cellsPerAxis,
  );
  const ox = geo.originOffset + cx * geo.cellSize + geo.cellSize / 2;
  const oy = geo.originOffset + cy * geo.cellSize + geo.cellSize / 2;
  const oz = geo.originOffset + cz * geo.cellSize + geo.cellSize / 2;

  let half = Math.max(1, Math.ceil(Math.cbrt(geo.limit) / 2));
  let candidates: Array<{ asteroid: Asteroid; d2: number }> = [];
  for (;;) {
    const minX = Math.max(0, cx - half);
    const maxX = Math.min(last, cx + half);
    const minY = Math.max(0, cy - half);
    const maxY = Math.min(last, cy + half);
    const minZ = Math.max(0, cz - half);
    const maxZ = Math.min(last, cz + half);
    candidates = [];
    for (let x = minX; x <= maxX; x += 1) {
      for (let y = minY; y <= maxY; y += 1) {
        for (let z = minZ; z <= maxZ; z += 1) {
          const asteroid = virtualAsteroidAt(geo, x, y, z);
          const dx = asteroid.position.x - ox;
          const dy = asteroid.position.y - oy;
          const dz = asteroid.position.z - oz;
          candidates.push({ asteroid, d2: dx * dx + dy * dy + dz * dz });
        }
      }
    }
    const spansField =
      minX === 0 && maxX === last && minY === 0 && maxY === last && minZ === 0 && maxZ === last;
    if (candidates.length >= geo.limit) {
      candidates.sort((a, b) => a.d2 - b.d2);
      // The nearest unscanned cell sits one layer beyond the cube; its closest possible
      // rock is (half + 0.5) cells away. If the limit-th rock is nearer than that, the
      // cube already holds the true global nearest set.
      const safe = (half + 0.5) * geo.cellSize;
      const limitRock = candidates[geo.limit - 1];
      if (spansField || (limitRock !== undefined && Math.sqrt(limitRock.d2) <= safe)) {
        break;
      }
    } else if (spansField) {
      candidates.sort((a, b) => a.d2 - b.d2);
      break;
    }
    half += Math.max(2, Math.ceil(half * 0.5));
  }

  const count = Math.min(candidates.length, geo.limit);
  const result: Asteroid[] = new Array(count);
  for (let i = 0; i < count; i += 1) {
    result[i] = candidates[i]!.asteroid;
  }
  return result;
}

// Compact, transferable representation of a derived virtual field. Every virtual rock is
// fully reconstructible from (cell coords + the four float scalars), so the heavy derive
// can run in a Web Worker and hand its result back as zero-copy ArrayBuffers — the main
// thread never re-runs the ~100-300ms scan/sort, only a ~3ms object rebuild (unpackField).
export type PackedField = {
  count: number;
  // 3 per rock: cx, cy, cz (drives id + pocket).
  cells: Int32Array;
  // 3 per rock: position x, y, z (f64 — bit-identical to deriveVirtualField).
  positions: Float64Array;
  // 3 per rock: radius, signature, mineralRichness.
  scalars: Float64Array;
  // 1 per rock: index into MINERALS for rareMineral.
  minerals: Uint8Array;
};

// Pack a derived virtual field (all rocks have the `v-cx-cy-cz` id shape and
// discovered=true) into transferable typed arrays. Runs in the worker, off the hot path.
export function packField(asteroids: Asteroid[]): PackedField {
  const count = asteroids.length;
  const cells = new Int32Array(count * 3);
  const positions = new Float64Array(count * 3);
  const scalars = new Float64Array(count * 3);
  const minerals = new Uint8Array(count);
  for (let i = 0; i < count; i += 1) {
    const asteroid = asteroids[i]!;
    const parts = asteroid.id.split("-");
    cells[i * 3] = Number(parts[1]);
    cells[i * 3 + 1] = Number(parts[2]);
    cells[i * 3 + 2] = Number(parts[3]);
    positions[i * 3] = asteroid.position.x;
    positions[i * 3 + 1] = asteroid.position.y;
    positions[i * 3 + 2] = asteroid.position.z;
    scalars[i * 3] = asteroid.radius;
    scalars[i * 3 + 1] = asteroid.signature;
    scalars[i * 3 + 2] = asteroid.mineralRichness;
    const mineralIndex = MINERALS.indexOf(asteroid.rareMineral);
    minerals[i] = mineralIndex < 0 ? 0 : mineralIndex;
  }
  return { count, cells, positions, scalars, minerals };
}

// Cell coords are packed into one number key so the per-cross reuse map (below) needs no
// string allocation to look a rock up. Safe while cellsPerAxis < 8192 (totalAsteroids <
// ~5.5e11) — far beyond any real field.
const CELL_KEY_BASE = 8192;
function cellKeyOf(cx: number, cy: number, cz: number): number {
  return (cx * CELL_KEY_BASE + cy) * CELL_KEY_BASE + cz;
}

// Build the cellKey -> Asteroid index for an already-derived virtual field (rocks have the
// `v-cx-cy-cz` id shape). Lets the synchronous first-paint derive seed the reuse map so the
// FIRST worker cross also reuses objects instead of re-allocating the whole 100k set.
export function indexByCell(asteroids: Asteroid[]): Map<number, Asteroid> {
  const byCell = new Map<number, Asteroid>();
  for (const asteroid of asteroids) {
    const parts = asteroid.id.split("-");
    byCell.set(cellKeyOf(Number(parts[1]), Number(parts[2]), Number(parts[3])), asteroid);
  }
  return byCell;
}

export type UnpackedField = {
  asteroids: Asteroid[];
  // cellKey -> Asteroid, so the NEXT cross can reuse the unchanged objects (95%+ on a
  // 1-cell cross) instead of re-allocating 100k objects + 100k id strings every crossing.
  byCell: Map<number, Asteroid>;
};

// Rebuild the Asteroid[] from a PackedField on the main thread, REUSING the previous
// cross's objects for any cell that is still present (a virtual rock is a pure function of
// its cell, so a reused object is identical to a freshly built one). On a single-cell cross
// almost every rock is shared, so this allocates only the handful of newly-entered rocks
// instead of 100k objects + 100k id strings — eliminating the per-cross GC spike. With no
// reuse map it is a plain full rebuild (deep-equal to deriveVirtualField's output).
export function unpackField(
  packed: PackedField,
  reuse?: Map<number, Asteroid> | null,
): UnpackedField {
  const { count, cells, positions, scalars, minerals } = packed;
  const asteroids: Asteroid[] = new Array(count);
  const byCell = new Map<number, Asteroid>();
  for (let i = 0; i < count; i += 1) {
    const cx = cells[i * 3]!;
    const cy = cells[i * 3 + 1]!;
    const cz = cells[i * 3 + 2]!;
    const cellKey = cellKeyOf(cx, cy, cz);
    let asteroid = reuse?.get(cellKey);
    if (asteroid === undefined) {
      const x = positions[i * 3]!;
      const y = positions[i * 3 + 1]!;
      // Belt rocks carry zone-driven pockets (a function of the rock's radial position);
      // legacy rocks keep the coordinate-band pockets. Both are pure recomputes, so the
      // unpacked object deep-equals the original derive.
      const pocket =
        activeBelt !== null
          ? pocketForZone(zoneAtRadius(activeBelt, x, positions[i * 3 + 2]!))
          : pocketForCell(cx);
      asteroid = {
        id: `v-${cx}-${cy}-${cz}`,
        pocket,
        position: { x, y, z: positions[i * 3 + 2]! },
        radius: scalars[i * 3]!,
        signature: scalars[i * 3 + 1]!,
        mineralRichness: scalars[i * 3 + 2]!,
        rareMineral: MINERALS[minerals[i]!] ?? "nickel",
        discovered: true,
      };
    }
    asteroids[i] = asteroid;
    byCell.set(cellKey, asteroid);
  }
  return { asteroids, byCell };
}
