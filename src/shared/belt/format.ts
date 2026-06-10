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
  // Optional world-mapping block (bakes from the saturn line onward). When present it
  // overrides the legacy BELT_WORLD_SCALE default so a preset carries its own scale —
  // e.g. saturn: worldScale 7.45e7 (a=1 -> 74,500 km, the C-ring inner edge) and
  // planetRadius 0.809 normalized (60,268 km / 74,500 km). Server and client read the
  // identical meta bytes, so the scale cannot split-brain.
  world?: {
    worldScale: number;
    planetRadius?: number;
  };
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
export const BELT_P_MAX = 0.85; // rocks/cell at density 255 (≈ 1-rock-per-cell band ceiling)
// Belt grid cell (meters). 530 m + pMax 0.85 -> ~5.7 rocks/km³ peak, ~350 m mean
// nearest-neighbour spacing — the Elite Dangerous ring feel (research doc §2: ED slab
// density ~5-10 rocks/km³, spacing ≥300 m). The legacy hash field keeps its own 1130 m.
export const BELT_CELL_SIZE = 530;
// Vertical compression of the bake's z structure: a raw sim slab (legacy default
// ±90 km, Saturn-scale ±447 km) reads as a fluffy torus from inside; ED rings are a
// thin slab — community estimates 2-4 km full, with "several km" eyeballs (research doc
// §3). Instead of a fixed divisor (right for one bake, wrong at Saturn scale), every
// bake is squashed to the SAME absolute target half-thickness: squash =
// zMax·worldScale / slabHalfMeters, computed once at decode (legacy default ±90 km ->
// ÷22, saturn ±447 km -> ÷109). 4,100 m half ≈ 8 km full: ED-thin from outside,
// hv-requested headroom inside. No re-bake: the grid, density sampling and hero decode
// all share the bake's squash, so server/client/GPU stay bit-identical.
//
// TOGGLEABLE: the server resolves the squash (HAYSTACK_BELT_SLAB env — "native" plays
// the bake's true vertical structure at squash 1, a number targets that slab
// half-thickness in meters) and PUBLISHES it in FieldSummary.belt.squash; the client
// decodes with the published value, so both sides always derive the identical field.
export const BELT_SLAB_HALF_METERS = 4100;
export function beltVerticalSquash(
  meta: BeltBakeMeta,
  worldScale: number,
  slabHalfMeters: number = BELT_SLAB_HALF_METERS,
): number {
  return Math.max(1, (meta.density.zMax * worldScale) / slabHalfMeters);
}
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

// Key packing for hero cell buckets. The grid is wide and FLAT (the belt is quasi-2D),
// so the axes get asymmetric bases: 2^20 for the two horizontal axes, 2^11 for the
// vertical. Worst key = (2^20·2^11 + 2^11)·2^20 + 2^20 < 2^51 < 2^53, so the packed key
// stays an exact f64 integer even at Saturn scale with the ED-density cell
// (worldScale 7.45e7 / BELT_CELL_SIZE 530 m -> cellsXZ ≈ 548k, over the 2^19 the
// 1130 m grid fit under).
export const BELT_CELL_KEY_BASE_XZ = 1048576; // 2^20
export const BELT_CELL_KEY_BASE_Y = 2048; // 2^11
export function beltCellKey(cx: number, cy: number, cz: number): number {
  return (cx * BELT_CELL_KEY_BASE_Y + cy) * BELT_CELL_KEY_BASE_XZ + cz;
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
  // Vertical compression factor (beltVerticalSquash(meta, worldScale)) — every consumer
  // that maps world y into the bake's z range divides/multiplies by this.
  squash: number;
  density: Uint8Array; // [r][theta][z] C-order, nr*ntheta*nz
  zones: Uint8Array; // per r-bin: 0 void, odd band, even gap
  flow: Int8Array; // [r][theta] * 4 (unit dir xyz + speed/127*vMax)
  heroes: BeltHeroes;
};

export function beltGridGeometry(
  meta: BeltBakeMeta,
  worldScale: number,
  cellSize: number,
  squash: number = beltVerticalSquash(meta, worldScale),
): BeltGridGeometry {
  const halfXZ = Math.ceil((meta.density.rMax * worldScale) / cellSize);
  const halfY = Math.ceil((meta.density.zMax * worldScale) / squash / cellSize);
  const cellsXZ = halfXZ * 2;
  const cellsY = halfY * 2;
  if (cellsXZ >= BELT_CELL_KEY_BASE_XZ || cellsY >= BELT_CELL_KEY_BASE_Y) {
    throw new Error(
      `belt grid ${cellsXZ}x${cellsY} exceeds cell-key bases ` +
        `${BELT_CELL_KEY_BASE_XZ}/${BELT_CELL_KEY_BASE_Y} — ` +
        "repack beltCellKey (watch the 2^53 exact-integer ceiling) before scaling further",
    );
  }
  return {
    cellSize,
    cellsXZ,
    cellsY,
    originXZ: -(cellsXZ * cellSize) / 2,
    originY: -(cellsY * cellSize) / 2,
  };
}

function decodeHeroes(
  bytes: Uint8Array,
  geo: BeltGridGeometry,
  worldScale: number,
  squash: number,
): BeltHeroes {
  const RECORD = 20; // f32 x,y,z,d + i16 family + i16 pad, little-endian
  const count = Math.floor(bytes.byteLength / RECORD);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const posRadius = new Float64Array(count * 4);
  const family = new Int16Array(count);
  const byCell = new Map<number, number>();
  for (let i = 0; i < count; i += 1) {
    const o = i * RECORD;
    // Sim (x, y, z_vertical) -> world (x, y = sim z, z = sim y); see the axis-mapping
    // note on BeltGridGeometry. The vertical axis is squashed with the rest of the slab
    // (beltVerticalSquash) so heroes stay inside the thinned grid.
    const x = view.getFloat32(o, true) * worldScale;
    const z = view.getFloat32(o + 4, true) * worldScale;
    const y = (view.getFloat32(o + 8, true) * worldScale) / squash;
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
      // A hero outside the grid cannot exist at runtime. The bake excludes them since
      // format v1 hero-volume clipping; tolerate stragglers in older artifacts.
      continue;
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
  // Resolved vertical squash. The server computes it (env toggle) and publishes it in
  // FieldSummary.belt.squash; the client passes the published value back here so every
  // consumer compresses the slab identically. Default: the ED slab target.
  squashOverride?: number,
): BeltBake {
  const meta = JSON.parse(bytes.metaJson) as BeltBakeMeta;
  if (meta.formatVersion !== BELT_FORMAT_VERSION) {
    throw new Error(`belt bake format ${meta.formatVersion} != supported ${BELT_FORMAT_VERSION}`);
  }
  // A bake that declares its own world mapping wins over the caller's default — the meta
  // is the one artifact every consumer shares byte-identically.
  if (meta.world?.worldScale !== undefined) {
    worldScale = meta.world.worldScale;
  }
  const { nr, ntheta, nz } = meta.density;
  if (bytes.density.byteLength !== nr * ntheta * nz) {
    throw new Error(`density bytes ${bytes.density.byteLength} != ${nr}*${ntheta}*${nz}`);
  }
  if (bytes.zones.byteLength !== nr) {
    throw new Error(`zones bytes ${bytes.zones.byteLength} != nr ${nr}`);
  }
  if (bytes.heroes.byteLength % 20 !== 0) {
    throw new Error(`heroes bytes ${bytes.heroes.byteLength} not a multiple of the 20B record`);
  }
  if (bytes.flow.byteLength !== meta.flow.nr * meta.flow.ntheta * 4) {
    throw new Error(`flow bytes ${bytes.flow.byteLength} != ${meta.flow.nr}*${meta.flow.ntheta}*4`);
  }
  const squash = squashOverride ?? beltVerticalSquash(meta, worldScale);
  const geo = beltGridGeometry(meta, worldScale, cellSize, squash);
  return {
    meta,
    geo,
    worldScale,
    squash,
    density: bytes.density,
    zones: bytes.zones,
    flow: new Int8Array(bytes.flow.buffer, bytes.flow.byteOffset, bytes.flow.byteLength),
    heroes: decodeHeroes(bytes.heroes, geo, worldScale, squash),
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
    squash: bake.squash,
    cellsXZ: bake.geo.cellsXZ,
    cellsY: bake.geo.cellsY,
  };
}
