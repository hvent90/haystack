import type { FieldSummary } from "../../shared/types";
import {
  createFieldContext,
  DEFAULT_GEOMETRY,
  rocksInCell,
  type FieldContext,
  type FieldGeometry,
  type FieldPreset,
} from "../../shared/field-factory";
import { PRESETS } from "../../shared/field-presets";
import { sunDirection } from "./lighting";

// Per-instance sun-occlusion ("aSunlit"): how much of the sun an asteroid can see, given
// the other rocks up-sun of it. Because the sun direction is fixed and the field is fully
// deterministic, this is a pure function of a rock's cell — computed once per rock, cached,
// and read for free in the shader at any distance. This is what lets hundreds of thousands
// of rocks shadow each other without a per-rock render cost.
//
// Rocks come from the shared field factory with the ACTIVE preset (configureSunOcclusion;
// defaults to legacy-uniform), so shadows always march against the field actually rendered.
// Kept client-side only: this is a visual-only value and is never shared with or compared
// against the server.
const CELL_SIZE = DEFAULT_GEOMETRY.cellSize;
const CELLS_PER_AXIS = DEFAULT_GEOMETRY.cellsPerAxis;
const ORIGIN_OFFSET = DEFAULT_GEOMETRY.originOffset;

let activeGeo: FieldGeometry = DEFAULT_GEOMETRY;
let activePreset: FieldPreset = PRESETS["legacy-uniform"]!;
let factoryCtx: FieldContext = createFieldContext();

// Switch the occlusion march to the server-announced field. Resets every cache —
// they are all preset-derived. No-op when nothing changed (the common path:
// called once per session when the first world snapshot lands).
export function configureSunOcclusion(field: FieldSummary): void {
  const preset = PRESETS[field.preset] ?? PRESETS["legacy-uniform"]!;
  if (preset === activePreset && field.seed === activeGeo.seed) {
    return;
  }
  activeGeo = {
    seed: field.seed,
    cellSize: field.cellSize,
    cellsPerAxis: Math.max(1, Math.round(Math.cbrt(field.totalAsteroids))),
    originOffset: -(Math.max(1, Math.round(Math.cbrt(field.totalAsteroids))) * field.cellSize) / 2,
  };
  activePreset = preset;
  factoryCtx = createFieldContext();
  occluderByCell.clear();
  cache.clear();
  primedByCell.clear();
}

// Per-cell occluder memo: flat [x,y,z,radius]*n. The march re-visits the same
// cells constantly across neighbouring rocks (each march only dedups within
// itself), and factory cell generation is ~10× the old inline noise math.
const occluderByCell = new Map<number, Float64Array>();
const NO_OCCLUDERS = new Float64Array(0);

function occludersAt(x: number, y: number, z: number, key: number): Float64Array {
  const hit = occluderByCell.get(key);
  if (hit !== undefined) {
    return hit;
  }
  const rocks = rocksInCell(activeGeo, activePreset, factoryCtx, x, y, z);
  let packed: Float64Array;
  if (rocks.length === 0) {
    packed = NO_OCCLUDERS;
  } else {
    packed = new Float64Array(rocks.length * 4);
    for (let i = 0; i < rocks.length; i += 1) {
      const rock = rocks[i]!;
      packed[i * 4] = rock.position.x;
      packed[i * 4 + 1] = rock.position.y;
      packed[i * 4 + 2] = rock.position.z;
      packed[i * 4 + 3] = rock.radius;
    }
  }
  occluderByCell.set(key, packed);
  return packed;
}

// March tunables (validated). MARCH_LAYERS is the field brightness dial — fewer layers =>
// brighter field (the field is angularly dense, so a long march drives it nearly black).
// Raising NEIGH above 1 changes nothing (a max-radius rock cannot reach a cell two columns
// off the ray) but triples the cost — leave it at 1.
const MARCH_LAYERS = 5;
const NEIGH = 1;
const SUN_ANGULAR_RADIUS = (0.5 * Math.PI) / 180; // ~1 degree sun disc
const PENUMBRA_CAP = 120; // metres
const TRANS_FLOOR = 0.002; // early-out once essentially fully shadowed
const MARCH_M = MARCH_LAYERS * CELL_SIZE;

const Sx = sunDirection.x;
const Sy = sunDirection.y;
const Sz = sunDirection.z;

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

// aSunlit in [0,1]: 1 = fully sunlit, 0 = fully shadowed by up-sun rocks. Cell-granular:
// siblings in a multi-rock cell share rock 0's march (and never self-shadow within the
// cell), matching the legacy one-rock-per-cell behavior.
export function computeSunlit(cx: number, cy: number, cz: number): number {
  const selfKey = (cx * CELLS_PER_AXIS + cy) * CELLS_PER_AXIS + cz;
  const self = occludersAt(cx, cy, cz, selfKey);
  const px = self.length > 0 ? self[0]! : ORIGIN_OFFSET + (cx + 0.5) * CELL_SIZE;
  const py = self.length > 0 ? self[1]! : ORIGIN_OFFSET + (cy + 0.5) * CELL_SIZE;
  const pz = self.length > 0 ? self[2]! : ORIGIN_OFFSET + (cz + 0.5) * CELL_SIZE;

  let trans = 1;
  const seen = new Set<number>();
  const steps = Math.ceil(MARCH_M / CELL_SIZE);

  for (let i = 1; i <= steps; i += 1) {
    const t = i * CELL_SIZE;
    const rx = px + Sx * t;
    const ry = py + Sy * t;
    const rz = pz + Sz * t;
    const ccx = Math.floor((rx - ORIGIN_OFFSET) / CELL_SIZE);
    const ccy = Math.floor((ry - ORIGIN_OFFSET) / CELL_SIZE);
    const ccz = Math.floor((rz - ORIGIN_OFFSET) / CELL_SIZE);

    for (let dx = -NEIGH; dx <= NEIGH; dx += 1) {
      for (let dy = -NEIGH; dy <= NEIGH; dy += 1) {
        for (let dz = -NEIGH; dz <= NEIGH; dz += 1) {
          const x = ccx + dx;
          const y = ccy + dy;
          const z = ccz + dz;
          if (x < 0 || x >= CELLS_PER_AXIS) continue;
          if (y < 0 || y >= CELLS_PER_AXIS) continue;
          if (z < 0 || z >= CELLS_PER_AXIS) continue;
          const key = (x * CELLS_PER_AXIS + y) * CELLS_PER_AXIS + z;
          if (seen.has(key)) continue;
          seen.add(key);
          if (x === cx && y === cy && z === cz) continue;

          const occluders = occludersAt(x, y, z, key);
          for (let q = 0; q < occluders.length; q += 4) {
            const wx = occluders[q]! - px;
            const wy = occluders[q + 1]! - py;
            const wz = occluders[q + 2]! - pz;
            const qr = occluders[q + 3]!;
            const along = wx * Sx + wy * Sy + wz * Sz;
            if (along <= 0 || along > MARCH_M) continue;

            const ex = wx - along * Sx;
            const ey = wy - along * Sy;
            const ez = wz - along * Sz;
            const d = Math.sqrt(ex * ex + ey * ey + ez * ez);
            const penumbra = Math.min(PENUMBRA_CAP, along * Math.tan(SUN_ANGULAR_RADIUS));
            const cover = 1 - smoothstep(qr, qr + penumbra, d);
            if (cover <= 0) continue;
            trans *= 1 - cover;
          }
        }
      }
    }

    if (trans <= TRANS_FLOOR) break;
  }

  return trans;
}

const cache = new Map<string, number>();

// Worker-primed values, keyed by packed cell (same packing idea as field-core's cellKeyOf;
// safe while cellsPerAxis < 8192). The field worker computes sunlit for every rock it
// derives (off-thread) and the main thread primes this map from the transferred typed
// arrays — so sunlitForId never runs the march for worker-delivered rocks (marching 50k
// cold rocks on the main thread cost ~440ms at boot).
const PRIME_KEY_BASE = 8192;
const primedByCell = new Map<number, number>();

function primeKey(cx: number, cy: number, cz: number): number {
  return (cx * PRIME_KEY_BASE + cy) * PRIME_KEY_BASE + cz;
}

// Prime `count` cells' sunlit values from the worker's parallel arrays (cells = 3 ints per
// rock, the PackedField layout). Cheap: one Map.set per rock, no strings.
export function primeSunlitCells(cells: Int32Array, values: Float64Array, count: number): void {
  for (let i = 0; i < count; i += 1) {
    primedByCell.set(primeKey(cells[i * 3]!, cells[i * 3 + 1]!, cells[i * 3 + 2]!), values[i]!);
  }
}

// aSunlit for an asteroid id. Virtual field ids encode the cell as "v-x-y-z" (with an
// optional "-i" in-cell rock index for multi-rock cells); any other id (e.g. a seeded
// gameplay asteroid) has no cell and is treated as fully sunlit. Cached so steady-state
// cost is ~0 — only newly seen rocks are marched. Sibling rocks share the cell's march
// value (the march is cell-granular, not rock-granular).
export function sunlitForId(id: string): number {
  const cached = cache.get(id);
  if (cached !== undefined) {
    return cached;
  }
  let value = 1;
  const parts = id.split("-");
  if ((parts.length === 4 || parts.length === 5) && parts[0] === "v") {
    const cx = Number(parts[1]);
    const cy = Number(parts[2]);
    const cz = Number(parts[3]);
    if (Number.isFinite(cx) && Number.isFinite(cy) && Number.isFinite(cz)) {
      // Prefer a worker-primed value over a main-thread march.
      value = primedByCell.get(primeKey(cx, cy, cz)) ?? computeSunlit(cx, cy, cz);
    }
  }
  cache.set(id, value);
  return value;
}
