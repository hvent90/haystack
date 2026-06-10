import type {
  Asteroid,
  FieldDiagnostic,
  FieldSummary,
  Mineral,
  ScanHit,
  Vector3,
} from "../shared/types";
import {
  createFieldContext,
  rocksInCell,
  type FieldGeometry,
  type RockSpec,
} from "../shared/field-factory";
import { PRESETS } from "../shared/field-presets";

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
const cellSize = 1130; // ~6000 / ∛150 for 150x asteroid density
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

// The field-factory preset shaping the virtual field. belt-natural is the
// hv-approved direction (pockets + drift + voids, guaranteed home pocket at
// spawn); env-overridable for A/B against legacy-uniform and the alternates.
function fieldPresetName(): string {
  const name = process.env["HAYSTACK_FIELD_PRESET"] ?? "belt-natural";
  return PRESETS[name] !== undefined ? name : "legacy-uniform";
}

const factoryGeometry: FieldGeometry = {
  seed: fieldSeed,
  cellSize,
  cellsPerAxis,
  originOffset,
};

export function fieldSummary(): FieldSummary {
  return {
    totalAsteroids: cellsPerAxis * cellsPerAxis * cellsPerAxis,
    seed: fieldSeed,
    cellSize,
    indexKind: "cubicCellHierarchy",
    renderedLimit: renderedLimit(),
    preset: fieldPresetName(),
  };
}

// Wire `Asteroid` from a factory RockSpec. Rock 0 keeps the legacy `v-x-y-z` id
// (byte-compatible with the pre-factory field); siblings append their index.
function asteroidFromRock(rock: RockSpec): Asteroid {
  return {
    id:
      rock.index === 0
        ? `v-${rock.cx}-${rock.cy}-${rock.cz}`
        : `v-${rock.cx}-${rock.cy}-${rock.cz}-${rock.index}`,
    pocket: pocketForCell({ x: rock.cx, y: rock.cy, z: rock.cz }),
    position: rock.position,
    radius: rock.radius,
    signature: rock.signature,
    mineralRichness: rock.mineralRichness,
    rareMineral: minerals[rock.mineralIndex] ?? "nickel",
    discovered: true,
  };
}

export function queryVirtualAsteroids(
  origin: Vector3,
  radius: number,
  limit = renderedLimit(),
): QueryResult {
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
  const preset = PRESETS[fieldPresetName()]!;
  const ctx = createFieldContext();

  for (let x = min.x; x <= max.x; x += 1) {
    for (let y = min.y; y <= max.y; y += 1) {
      for (let z = min.z; z <= max.z; z += 1) {
        cellsVisited += 1;
        for (const rock of rocksInCell(factoryGeometry, preset, ctx, x, y, z)) {
          const asteroid = asteroidFromRock(rock);
          const range = distance(origin, asteroid.position);
          if (range <= boundedRadius) {
            candidates.push({ asteroid, distance: range });
          }
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
// query cell — compute the (otherwise expensive) cubic cell scan once per cell and
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
export function streamedFieldAsteroids(position: Vector3): Asteroid[] {
  const cell = worldToCell(position);
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
  const asteroids = queryVirtualAsteroids(cellCenter(cell), 520000, limit).asteroids;
  if (streamedFieldCache.size >= streamedFieldCacheLimit) {
    const oldest = streamedFieldCache.keys().next().value;
    if (oldest !== undefined) {
      streamedFieldCache.delete(oldest);
    }
  }
  streamedFieldCache.set(key, asteroids);
  return asteroids;
}

function streamFieldKey(cell: Cell, limit: number): string {
  return `${cell.x}-${cell.y}-${cell.z}-${limit}`;
}

// Cheap, cell-stable identity of the streamed field a position resolves to. Two
// positions in the same cell (at the same renderedLimit) yield the same token, so the
// world stream can detect "field unchanged this tick" without serializing the
// nearest-`renderedLimit` (up to 100k) rock array. Mirrors the LRU cache key exactly.
export function streamedFieldToken(position: Vector3): string {
  return streamFieldKey(worldToCell(position), renderedLimit());
}

function cellCenter(cell: Cell): Vector3 {
  return {
    x: originOffset + cell.x * cellSize + cellSize / 2,
    y: originOffset + cell.y * cellSize + cellSize / 2,
    z: originOffset + cell.z * cellSize + cellSize / 2,
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
