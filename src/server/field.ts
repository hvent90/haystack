import type {
  Asteroid,
  FieldDiagnostic,
  FieldSummary,
  Mineral,
  ScanHit,
  Vector3,
} from "../shared/types";
import {
  type BeltField,
  beltCellCoords,
  deriveBeltField,
  makeBeltField,
  queryBeltAsteroids,
} from "../shared/belt/field";
import { BELT_CELL_SIZE, beltFieldInfo } from "../shared/belt/format";
import { beltDensityScale, beltPresetName, fieldMode, loadBeltBakeSync } from "./belt-bake";

type Cell = {
  x: number;
  y: number;
  z: number;
};

type QueryResult = {
  asteroids: Asteroid[];
  cellsVisited: number;
  materializedAsteroids: number;
};

const fieldSeed = 424242;
// Legacy hash-field cell (~6000 / ∛150 for 150x asteroid density). Belt mode uses the
// shared BELT_CELL_SIZE (530 m, ED ring density) — fieldSummary publishes whichever
// grid is active, so the client always reconstructs the right one.
const cellSize = 1130;
const cellsPerAxis = 100;
// Cap on how many virtual rocks the client derives/renders near a player. Env-configurable
// so the perf benchmark can drive the field to 100k+; defaults to 50000 in normal use.
// The field is derived client-side in a Web Worker, so this is free for the server tick —
// only the client's render budget (frustum/distance/LOD culling) scales with it.
function renderedLimit(): number {
  return Number(process.env["HAYSTACK_RENDERED_LIMIT"] ?? "50000");
}
const originOffset = -(cellsPerAxis * cellSize) / 2;
const minerals: Mineral[] = ["nickel", "waterIce", "cobalt", "silicates", "platinum", "xenotime"];

// --- belt mode (the default structure source; docs/asteroid-sim-impl-log.md) ----------
//
// Structure comes from the beltsim bake committed under public/belt/<preset>/: heroes,
// density, zones, flow. Derivation lives in src/shared/belt/field.ts and is shared
// bit-for-bit with the client. The legacy seeded-hash field below stays available as the
// pure-noise baseline (HAYSTACK_FIELD=hash) and as a fallback when artifacts are absent.

const beltField: BeltField | null = (() => {
  if (fieldMode() !== "belt") {
    return null;
  }
  const bake = loadBeltBakeSync(beltPresetName(), BELT_CELL_SIZE);
  if (bake === null) {
    console.warn(
      `[field] belt bake "${beltPresetName()}" not found under public/belt/ — ` +
        "falling back to the legacy hash field",
    );
    return null;
  }
  return makeBeltField(bake, fieldSeed, beltDensityScale());
})();

// Expected virtual-rock population of the belt: integrate the baked density (polar texel
// volume in field-cell units x probability). Computed once at boot; informational.
const beltTotalAsteroids: number = (() => {
  if (beltField === null) {
    return 0;
  }
  const { meta, worldScale } = beltField.bake;
  const { nr, ntheta, nz, rMin, rMax, zMax } = meta.density;
  const density = beltField.bake.density;
  const dr = (rMax - rMin) / nr;
  const dtheta = (2 * Math.PI) / ntheta;
  const dz = (2 * zMax) / nz;
  const cellVolume = BELT_CELL_SIZE * BELT_CELL_SIZE * BELT_CELL_SIZE;
  let texelSum = 0;
  // Sum density per r-ring first (texel volume depends only on r).
  const perRing = new Float64Array(nr);
  for (let ir = 0; ir < nr; ir += 1) {
    let s = 0;
    const base = ir * ntheta * nz;
    for (let i = 0; i < ntheta * nz; i += 1) {
      s += density[base + i]!;
    }
    perRing[ir] = s;
  }
  for (let ir = 0; ir < nr; ir += 1) {
    const rMid = rMin + (ir + 0.5) * dr;
    // dz spans the bake's normalized z; the runtime squash compresses it vertically.
    const texelVolumeWorld =
      (rMid * dr * dtheta * dz * worldScale * worldScale * worldScale) / beltField.bake.squash;
    texelSum += (perRing[ir]! / 255) * beltField.pPeak * (texelVolumeWorld / cellVolume);
  }
  return Math.round(texelSum);
})();

// The loaded belt derivation (null in legacy hash mode) — handed to consumers that need
// the shared belt math with the server's own bake (ship collision).
export function serverBeltField(): BeltField | null {
  return beltField;
}

export function fieldSummary(): FieldSummary {
  if (beltField !== null) {
    return {
      totalAsteroids: beltTotalAsteroids,
      seed: fieldSeed,
      cellSize: BELT_CELL_SIZE,
      indexKind: "beltBakeV1",
      renderedLimit: renderedLimit(),
      belt: { ...beltFieldInfo(beltField.bake, beltDensityScale()), preset: beltPresetName() },
    };
  }
  return {
    totalAsteroids: cellsPerAxis * cellsPerAxis * cellsPerAxis,
    seed: fieldSeed,
    cellSize,
    indexKind: "cubicCellHierarchy",
    renderedLimit: renderedLimit(),
  };
}

export function queryVirtualAsteroids(
  origin: Vector3,
  radius: number,
  limit = renderedLimit(),
): QueryResult {
  if (beltField !== null) {
    return queryBeltAsteroids(beltField, origin, radius, limit);
  }
  const boundedRadius = Math.max(cellSize, Math.min(radius, cellSize * 120));
  const min = worldToCell({
    x: origin.x - boundedRadius,
    y: origin.y - boundedRadius,
    z: origin.z - boundedRadius,
  });
  const max = worldToCell({
    x: origin.x + boundedRadius,
    y: origin.y + boundedRadius,
    z: origin.z + boundedRadius,
  });

  const candidates: Array<{ asteroid: Asteroid; distance: number }> = [];
  let cellsVisited = 0;

  for (let x = min.x; x <= max.x; x += 1) {
    for (let y = min.y; y <= max.y; y += 1) {
      for (let z = min.z; z <= max.z; z += 1) {
        cellsVisited += 1;
        const asteroid = virtualAsteroidAt({ x, y, z });
        const range = distance(origin, asteroid.position);
        if (range <= boundedRadius) {
          candidates.push({ asteroid, distance: range });
        }
      }
    }
  }

  candidates.sort((left, right) => left.distance - right.distance);

  return {
    asteroids: candidates.slice(0, Math.max(1, limit)).map(({ asteroid }) => asteroid),
    cellsVisited,
    materializedAsteroids: candidates.length,
  };
}

// Per-cell cache of the streamed field. The virtual field is global and fully
// deterministic, so the nearest-`renderedLimit` rocks are a pure function of the
// query cell — compute the (otherwise expensive) cell scan once per cell and
// reuse it. Bounded (LRU) so a roaming fleet can't grow it without limit.
//
// INVARIANT: cached arrays and their Asteroid objects are SHARED across peers and
// ticks and MUST be treated as immutable. The virtual field is read-only (nothing
// mines or mutates a virtual rock); never mutate a returned asteroid in place.
const streamedFieldCache = new Map<string, Asteroid[]>();
const streamedFieldCacheLimit = 64;

// The asteroids streamed to a client for rendering: the nearest `renderedLimit`
// virtual rocks, with the query origin snapped to the ship's CELL CENTER so the set
// is a pure function of the cell. This keeps the set byte-identical across ticks (the
// 30Hz world-stream delta no longer re-sends the static field every frame as the ship
// drifts within a cell) and changes only when the ship crosses a cell boundary.
//
// In belt mode sparse regions (gaps, the inner void) legitimately return fewer than
// `renderedLimit` rocks — emptiness is the terrain.
export function streamedFieldAsteroids(position: Vector3): Asteroid[] {
  const cell = fieldCellOf(position);
  const limit = renderedLimit();
  const key = streamFieldKey(cell, limit);
  const cached = streamedFieldCache.get(key);
  if (cached !== undefined) {
    // LRU touch: re-insert so a frequently-revisited cell isn't evicted while a
    // player oscillates across its boundary.
    streamedFieldCache.delete(key);
    streamedFieldCache.set(key, cached);
    return cached;
  }
  const asteroids =
    beltField !== null
      ? deriveBeltField(beltField, beltCellCenter(cell), limit)
      : queryVirtualAsteroids(cellCenter(cell), 520000, limit).asteroids;
  if (streamedFieldCache.size >= streamedFieldCacheLimit) {
    const oldest = streamedFieldCache.keys().next().value;
    if (oldest !== undefined) {
      streamedFieldCache.delete(oldest);
    }
  }
  streamedFieldCache.set(key, asteroids);
  return asteroids;
}

function fieldCellOf(position: Vector3): Cell {
  if (beltField !== null) {
    const { cx, cy, cz } = beltCellCoords(beltField, position);
    return { x: cx, y: cy, z: cz };
  }
  return worldToCell(position);
}

function streamFieldKey(cell: Cell, limit: number): string {
  return `${cell.x}-${cell.y}-${cell.z}-${limit}`;
}

// Cheap, cell-stable identity of the streamed field a position resolves to. Two
// positions in the same cell (at the same renderedLimit) yield the same token, so the
// world stream can detect "field unchanged this tick" without serializing the
// nearest-`renderedLimit` (up to 100k) rock array. Mirrors the LRU cache key exactly.
export function streamedFieldToken(position: Vector3): string {
  return streamFieldKey(fieldCellOf(position), renderedLimit());
}

function cellCenter(cell: Cell): Vector3 {
  return {
    x: originOffset + cell.x * cellSize + cellSize / 2,
    y: originOffset + cell.y * cellSize + cellSize / 2,
    z: originOffset + cell.z * cellSize + cellSize / 2,
  };
}

function beltCellCenter(cell: Cell): Vector3 {
  const geo = beltField!.bake.geo;
  return {
    x: geo.originXZ + cell.x * geo.cellSize + geo.cellSize / 2,
    y: geo.originY + cell.y * geo.cellSize + geo.cellSize / 2,
    z: geo.originXZ + cell.z * geo.cellSize + geo.cellSize / 2,
  };
}

export function virtualScanHits(
  origin: Vector3,
  scanPower: number,
  radius: number,
  limit: number,
): ScanHit[] {
  return queryVirtualAsteroids(origin, radius, limit).asteroids.map((asteroid) => {
    const range = distance(origin, asteroid.position);
    const strength = Math.min(
      1,
      Math.max(0, (asteroid.signature + asteroid.radius / 900) / (1 + range / (scanPower * 18000))),
    );
    return {
      id: asteroid.id,
      kind: "asteroid",
      label: asteroid.id,
      distance: range,
      strength,
      bearing: unit(subtract(asteroid.position, origin)),
      clue: `${asteroid.rareMineral} virtual return, indexed cell ${asteroid.pocket}`,
    };
  });
}

export function fieldDiagnostic(origin: Vector3, radius: number, limit: number): FieldDiagnostic {
  const result = queryVirtualAsteroids(origin, radius, limit);
  return {
    ...fieldSummary(),
    queryOrigin: origin,
    queryRadius: radius,
    cellsVisited: result.cellsVisited,
    materializedAsteroids: result.materializedAsteroids,
    hits: virtualScanHits(origin, 1.2, radius, limit),
  };
}

// --- legacy hash field (the pure-noise baseline; HAYSTACK_FIELD=hash) -----------------

function virtualAsteroidAt(cell: Cell): Asteroid {
  const seed = hashCell(cell);
  const position = {
    x: originOffset + cell.x * cellSize + noise(seed + 1) * cellSize,
    y: originOffset + cell.y * cellSize + noise(seed + 2) * cellSize,
    z: originOffset + cell.z * cellSize + noise(seed + 3) * cellSize,
  };
  const mineralIndex = Math.floor(noise(seed + 4) * minerals.length) % minerals.length;
  const rareMineral = minerals[mineralIndex] ?? "nickel";
  const radius = 45 + noise(seed + 5) * 310;
  const signature = 0.08 + noise(seed + 6) * 0.7;
  const mineralRichness = 0.18 + noise(seed + 7) * 0.82;

  return {
    id: `v-${cell.x}-${cell.y}-${cell.z}`,
    pocket: pocketForCell(cell),
    position,
    radius,
    signature,
    mineralRichness,
    rareMineral,
    discovered: true,
  };
}

function worldToCell(position: Vector3): Cell {
  return {
    x: clampCell(Math.floor((position.x - originOffset) / cellSize)),
    y: clampCell(Math.floor((position.y - originOffset) / cellSize)),
    z: clampCell(Math.floor((position.z - originOffset) / cellSize)),
  };
}

function clampCell(value: number): number {
  return Math.max(0, Math.min(cellsPerAxis - 1, value));
}

function pocketForCell(cell: Cell): string {
  if (cell.x < 33) {
    return "inner-drift";
  }
  if (cell.x < 66) {
    return "black-thread";
  }
  return "long-echo";
}

function hashCell(cell: Cell): number {
  return fieldSeed + cell.x * 73856093 + cell.y * 19349663 + cell.z * 83492791;
}

function noise(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

function subtract(left: Vector3, right: Vector3): Vector3 {
  return {
    x: left.x - right.x,
    y: left.y - right.y,
    z: left.z - right.z,
  };
}

function unit(vector: Vector3): Vector3 {
  const magnitude = length(vector);
  if (magnitude === 0) {
    return { x: 0, y: 0, z: 0 };
  }
  return {
    x: round(vector.x / magnitude),
    y: round(vector.y / magnitude),
    z: round(vector.z / magnitude),
  };
}

function distance(left: Vector3, right: Vector3): number {
  return length(subtract(left, right));
}

function length(vector: Vector3): number {
  return Math.sqrt(vector.x * vector.x + vector.y * vector.y + vector.z * vector.z);
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
