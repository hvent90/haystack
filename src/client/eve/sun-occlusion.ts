import { beltRockShapeAt } from "../../shared/belt/field";
import { activeBeltField } from "./field-core";
import { sunDirection } from "./lighting";

// Per-instance sun-occlusion ("aSunlit"): how much of the sun an asteroid can see, given
// the other rocks up-sun of it. Because the sun direction is fixed and the field is fully
// deterministic, this is a pure function of a rock's cell — computed once per rock, cached,
// and read for free in the shader at any distance. This is what lets hundreds of thousands
// of rocks shadow each other without a per-rock render cost.
//
// Field constants mirror src/server/field.ts exactly (the same deterministic generator).
// Kept client-side only: Math.sin is not bit-portable across JS engines, so this is a
// visual-only value and is never shared with or compared against the server.
const CELL_SIZE = 1130;
const CELLS_PER_AXIS = 100;
const ORIGIN_OFFSET = -(CELLS_PER_AXIS * CELL_SIZE) / 2;
const FIELD_SEED = 424242;

// March tunables (validated). MARCH_LAYERS is the field brightness dial — fewer layers =>
// brighter field (the field is angularly dense, so a long march drives it nearly black).
// Raising NEIGH above 1 changes nothing (a max-radius rock cannot reach a cell two columns
// off the ray) but triples the cost — leave it at 1.
const MARCH_LAYERS = 5;
const NEIGH = 1;
const SUN_ANGULAR_RADIUS = (0.5 * Math.PI) / 180; // ~1 degree sun disc
const PENUMBRA_CAP = 120; // metres
const TRANS_FLOOR = 0.002; // early-out once essentially fully shadowed

const Sx = sunDirection.x;
const Sy = sunDirection.y;
const Sz = sunDirection.z;

function hashCell(x: number, y: number, z: number): number {
  return FIELD_SEED + x * 73856093 + y * 19349663 + z * 83492791;
}

function noise(seed: number): number {
  const value = Math.sin(seed * 12.9898) * 43758.5453;
  return value - Math.floor(value);
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

// Scratch for belt occluder lookups (avoid an allocation per visited cell).
const shape = { x: 0, y: 0, z: 0, radius: 0 };

// aSunlit in [0,1]: 1 = fully sunlit, 0 = fully shadowed by up-sun rocks.
//
// Belt mode: occluder positions/radii come from the SAME shared belt derivation the
// field uses (beltRockShapeAt — density-gated cells, literal heroes), over the belt's
// non-cubic grid. Legacy mode keeps the original mirrored hash formula. Both are
// visual-only (never compared against the server).
export function computeSunlit(cx: number, cy: number, cz: number): number {
  const belt = activeBeltField();
  const cellSize = belt !== null ? belt.bake.geo.cellSize : CELL_SIZE;
  const originXZ = belt !== null ? belt.bake.geo.originXZ : ORIGIN_OFFSET;
  const originY = belt !== null ? belt.bake.geo.originY : ORIGIN_OFFSET;
  const cellsXZ = belt !== null ? belt.bake.geo.cellsXZ : CELLS_PER_AXIS;
  const cellsY = belt !== null ? belt.bake.geo.cellsY : CELLS_PER_AXIS;
  const keyBase = 8192; // > cellsXY in both modes; packed visited-cell key
  const marchM = MARCH_LAYERS * cellSize;

  let px: number;
  let py: number;
  let pz: number;
  if (belt !== null && beltRockShapeAt(belt, cx, cy, cz, shape)) {
    px = shape.x;
    py = shape.y;
    pz = shape.z;
  } else {
    const selfSeed = hashCell(cx, cy, cz);
    px = originXZ + cx * cellSize + noise(selfSeed + 1) * cellSize;
    py = originY + cy * cellSize + noise(selfSeed + 2) * cellSize;
    pz = originXZ + cz * cellSize + noise(selfSeed + 3) * cellSize;
  }

  let trans = 1;
  const seen = new Set<number>();
  const steps = Math.ceil(marchM / cellSize);

  for (let i = 1; i <= steps; i += 1) {
    const t = i * cellSize;
    const rx = px + Sx * t;
    const ry = py + Sy * t;
    const rz = pz + Sz * t;
    const ccx = Math.floor((rx - originXZ) / cellSize);
    const ccy = Math.floor((ry - originY) / cellSize);
    const ccz = Math.floor((rz - originXZ) / cellSize);

    for (let dx = -NEIGH; dx <= NEIGH; dx += 1) {
      for (let dy = -NEIGH; dy <= NEIGH; dy += 1) {
        for (let dz = -NEIGH; dz <= NEIGH; dz += 1) {
          const x = ccx + dx;
          const y = ccy + dy;
          const z = ccz + dz;
          if (x < 0 || x >= cellsXZ) continue;
          if (y < 0 || y >= cellsY) continue;
          if (z < 0 || z >= cellsXZ) continue;
          const key = (x * keyBase + y) * keyBase + z;
          if (seen.has(key)) continue;
          seen.add(key);
          if (x === cx && y === cy && z === cz) continue;

          let qx: number;
          let qy: number;
          let qz: number;
          let qr: number;
          if (belt !== null) {
            if (!beltRockShapeAt(belt, x, y, z, shape)) continue;
            qx = shape.x;
            qy = shape.y;
            qz = shape.z;
            qr = shape.radius;
          } else {
            const seed = hashCell(x, y, z);
            qx = originXZ + x * cellSize + noise(seed + 1) * cellSize;
            qy = originY + y * cellSize + noise(seed + 2) * cellSize;
            qz = originXZ + z * cellSize + noise(seed + 3) * cellSize;
            qr = 45 + noise(seed + 5) * 310;
          }

          const wx = qx - px;
          const wy = qy - py;
          const wz = qz - pz;
          const along = wx * Sx + wy * Sy + wz * Sz;
          if (along <= 0 || along > marchM) continue;

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

// aSunlit for an asteroid id. Virtual field ids encode the cell as "v-x-y-z"; any other id
// (e.g. a seeded gameplay asteroid) has no cell and is treated as fully sunlit. Cached so
// steady-state cost is ~0 — only newly seen rocks are marched.
export function sunlitForId(id: string): number {
  const cached = cache.get(id);
  if (cached !== undefined) {
    return cached;
  }
  let value = 1;
  const parts = id.split("-");
  if (parts.length === 4 && parts[0] === "v") {
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
