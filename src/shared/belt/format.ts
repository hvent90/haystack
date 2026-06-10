import type { BeltFieldInfo } from "../types";

// Belt bake artifact decoding (beltsim Phase 2 output -> runtime form).
//
// The artifacts are produced by `beltsim bake` (see beltsim/README.md) and committed
// under public/belt/<preset>/. The server reads them from disk, the client fetches the
// same files; both decompress to IDENTICAL bytes and decode here with f64 math only, so
// every consumer derives the exact same belt. This module is environment-free (no fs, no
// fetch, no DOM) — callers hand it decompressed bytes.

// belt-meta.json (subset the runtime needs; beltsim writes more for humans).
export type BeltBakeMeta = {
  formatVersion: number;
  preset: string;
  seed: number;
  density: {
    nr: number;
    ntheta: number;
    nz: number;
    rMin: number;
    rMax: number;
    zMax: number;
    countScale: number;
    densityScale: number;
  };
  flow: { nr: number; ntheta: number; vMax: number };
  zones: { nr: number };
  heroes: { sizeSlope: number };
};

export const BELT_FORMAT_VERSION = 1;

// World-mapping + gameplay-tuning constants. These are RUNTIME knobs (cheap: no re-sim,
// no re-bake). worldScale maps normalized sim units to meters; pMax is the expected
// rocks-per-field-cell where the baked density is at its 99.9th-percentile peak.
export const BELT_WORLD_SCALE = 1.0e6; // meters per normalized unit (a=1 -> 1000 km)
export const BELT_P_MAX = 0.85; // rocks/cell at density 255 (≈ today's 1-rock-per-cell band feel)
export const HERO_RADIUS_BASE = 100; // hero radius = base * d^0.75 (d ∈ [1,60] -> ~100..2150 m)
export const HERO_RADIUS_EXP = 0.75;

// AXIS MAPPING: the game world is y-up (three.js convention; the old seeded pockets kept
// y small). The sim/bake is z-up (orbital inclination -> z). Decode maps sim (x, y, z)
// -> world (x, z_sim -> y, y_sim -> z): the belt plane is the world x–z plane, and the
// thin (vertical) axis is world Y.
export type BeltGridGeometry = {
  cellSize: number;
  cellsXZ: number; // cells per horizontal axis, x and z (field spans ±cellsXZ/2 * cellSize)
  cellsY: number; // cells on the vertical axis (the belt is quasi-2D)
  originXZ: number; // = -(cellsXZ * cellSize) / 2
  originY: number;
};

// Key packing for hero cell buckets. cellsXY stays < 8192 for any sane worldScale
// (3.25e6 m / 1130 m ≈ 5754); (8192^3 = 5.5e11) < 2^53 so the key is exact.
export const BELT_CELL_KEY_BASE = 8192;
export function beltCellKey(cx: number, cy: number, cz: number): number {
  return (cx * BELT_CELL_KEY_BASE + cy) * BELT_CELL_KEY_BASE + cz;
}

export type BeltHeroes = {
  count: number;
  // World-space, 4 per hero: x, y, z (meters), radius (meters). f64 — derived once from
  // the artifact's f32 bytes, identically on every consumer.
  posRadius: Float64Array;
  family: Int16Array;
  // cellKey -> hero index. One hero per cell: the bake can land two heroes in one field
  // cell (rare); the LARGEST wins so the mapping is deterministic.
  byCell: Map<number, number>;
};

export type BeltBake = {
  meta: BeltBakeMeta;
  geo: BeltGridGeometry;
  worldScale: number;
  density: Uint8Array; // [r][theta][z] C-order, nr*ntheta*nz
  zones: Uint8Array; // per r-bin: 0 void, odd band, even gap
  flow: Int8Array; // [r][theta] * 4 (unit dir xyz + speed/127*vMax)
  heroes: BeltHeroes;
};

export function beltGridGeometry(
  meta: BeltBakeMeta,
  worldScale: number,
  cellSize: number,
): BeltGridGeometry {
  const halfXZ = Math.ceil((meta.density.rMax * worldScale) / cellSize);
  const halfY = Math.ceil((meta.density.zMax * worldScale) / cellSize);
  const cellsXZ = halfXZ * 2;
  const cellsY = halfY * 2;
  return {
    cellSize,
    cellsXZ,
    cellsY,
    originXZ: -(cellsXZ * cellSize) / 2,
    originY: -(cellsY * cellSize) / 2,
  };
}

function decodeHeroes(bytes: Uint8Array, geo: BeltGridGeometry, worldScale: number): BeltHeroes {
  const RECORD = 20; // f32 x,y,z,d + i16 family + i16 pad, little-endian
  const count = Math.floor(bytes.byteLength / RECORD);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const posRadius = new Float64Array(count * 4);
  const family = new Int16Array(count);
  const byCell = new Map<number, number>();
  for (let i = 0; i < count; i += 1) {
    const o = i * RECORD;
    // Sim (x, y, z_vertical) -> world (x, y = sim z, z = sim y); see the axis-mapping
    // note on BeltGridGeometry.
    const x = view.getFloat32(o, true) * worldScale;
    const z = view.getFloat32(o + 4, true) * worldScale;
    const y = view.getFloat32(o + 8, true) * worldScale;
    const d = view.getFloat32(o + 12, true);
    const radius = HERO_RADIUS_BASE * Math.pow(d, HERO_RADIUS_EXP);
    posRadius[i * 4] = x;
    posRadius[i * 4 + 1] = y;
    posRadius[i * 4 + 2] = z;
    posRadius[i * 4 + 3] = radius;
    family[i] = view.getInt16(o + 16, true);
    const cx = Math.floor((x - geo.originXZ) / geo.cellSize);
    const cy = Math.floor((y - geo.originY) / geo.cellSize);
    const cz = Math.floor((z - geo.originXZ) / geo.cellSize);
    if (cx < 0 || cx >= geo.cellsXZ || cy < 0 || cy >= geo.cellsY || cz < 0 || cz >= geo.cellsXZ) {
      continue; // outside the field grid (shouldn't happen with matched extents)
    }
    const key = beltCellKey(cx, cy, cz);
    const existing = byCell.get(key);
    if (existing === undefined || posRadius[existing * 4 + 3]! < radius) {
      byCell.set(key, i);
    }
  }
  return { count, posRadius, family, byCell };
}

export type BeltBakeBytes = {
  metaJson: string;
  density: Uint8Array;
  heroes: Uint8Array;
  zones: Uint8Array;
  flow: Uint8Array;
};

export function decodeBeltBake(
  bytes: BeltBakeBytes,
  cellSize: number,
  worldScale: number = BELT_WORLD_SCALE,
): BeltBake {
  const meta = JSON.parse(bytes.metaJson) as BeltBakeMeta;
  if (meta.formatVersion !== BELT_FORMAT_VERSION) {
    throw new Error(`belt bake format ${meta.formatVersion} != supported ${BELT_FORMAT_VERSION}`);
  }
  const { nr, ntheta, nz } = meta.density;
  if (bytes.density.byteLength !== nr * ntheta * nz) {
    throw new Error(`density bytes ${bytes.density.byteLength} != ${nr}*${ntheta}*${nz}`);
  }
  if (bytes.zones.byteLength !== nr) {
    throw new Error(`zones bytes ${bytes.zones.byteLength} != nr ${nr}`);
  }
  const geo = beltGridGeometry(meta, worldScale, cellSize);
  return {
    meta,
    geo,
    worldScale,
    density: bytes.density,
    zones: bytes.zones,
    flow: new Int8Array(bytes.flow.buffer, bytes.flow.byteOffset, bytes.flow.byteLength),
    heroes: decodeHeroes(bytes.heroes, geo, worldScale),
  };
}

// The belt block the server publishes in FieldSummary so the client can fetch + verify
// the matching artifacts and reconstruct the identical grid.
export function beltFieldInfo(bake: BeltBake, densityScale: number): BeltFieldInfo {
  return {
    preset: bake.meta.preset,
    formatVersion: bake.meta.formatVersion,
    worldScale: bake.worldScale,
    pMax: BELT_P_MAX,
    densityScale,
    cellsXZ: bake.geo.cellsXZ,
    cellsY: bake.geo.cellsY,
  };
}
