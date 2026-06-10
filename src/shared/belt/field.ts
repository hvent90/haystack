import type { Asteroid, Mineral, Vector3 } from "../types";
import { type BeltBake, BELT_P_MAX, beltCellKey } from "./format";

// THE deterministic belt derivation — the single source of rock structure for the
// server (field.ts), the client derive (field-core.ts / field-worker.ts), ship collision
// (shared/collision.ts) and sun occlusion. Same cell + same bake bytes -> same rock,
// always, in f64 CPU math (the GPU only ever receives uploads of this output; see
// docs/gpu-asteroids-architecture.md §3.2).
//
// Structure model (docs/asteroid-sim-impl-log.md "Phase 3 design"):
//  - ≤ 1 rock per field cell. A cell's rock EXISTS iff a seeded hash roll clears the
//    baked density probability at the cell center. Dense band ≈ 0.85 rocks/cell (the
//    pre-belt field's feel); resonance gaps fall to nearly zero. The bake carries the
//    sim's macro-structure; the hash supplies everything below bake resolution.
//  - Hero asteroids (literal sim survivors) override their containing cell's rock:
//    same id shape `v-cx-cy-cz`, but position/radius/family come from the artifact.
//  - Pocket + mineral assignment is zone-driven (baked radial band/gap labels), no
//    longer hardcoded coordinate bands.

const MINERALS: Mineral[] = ["nickel", "waterIce", "cobalt", "silicates", "platinum", "xenotime"];

// Per-zone-kind mineral CDFs (sum to 1). Gaps are sparse but mineral-rich — risk/reward:
// hiding in a gap means fewer rocks but better odds of platinum/xenotime.
const BAND_CDF = [0.3, 0.45, 0.6, 0.9, 0.97, 1.0];
const GAP_CDF = [0.15, 0.25, 0.45, 0.65, 0.85, 1.0];
const VOID_CDF = [0.25, 0.6, 0.7, 0.85, 0.95, 1.0];

const BAND_NAMES = ["inner-drift", "long-echo", "veil-reach", "outer-shoal"];
const GAP_NAMES = ["black-thread", "korr-line", "silent-lane"];

export function pocketForZone(zone: number): string {
  if (zone === 0) {
    return "deep-void";
  }
  if (zone % 2 === 1) {
    return BAND_NAMES[((zone + 1) / 2 - 1) % BAND_NAMES.length] ?? "inner-drift";
  }
  return GAP_NAMES[(zone / 2 - 1) % GAP_NAMES.length] ?? "black-thread";
}

function hashCell(seed: number, x: number, y: number, z: number): number {
  return seed + x * 73856093 + y * 19349663 + z * 83492791;
}

function noise(seed: number): number {
  const value = Math.sin(seed * 12.9898) * 43758.5453;
  return value - Math.floor(value);
}

// Background rock radius from a uniform roll: truncated power law N(>r) ∝ r^-2 between
// 55 m and the legacy 355 m cap — swarms of small rocks punctuated by rare big ones
// (real-belt size statistics; the uniform legacy 45..355 read as uniformly mid-sized).
// ~2.4% of rocks saturate the cap; everything above 355 m is hero territory. Same noise
// channel (+5) as the legacy formula, so positions/attributes are unchanged.
const RADIUS_MIN = 55;
const RADIUS_MAX = 355;
function backgroundRadius(u: number): number {
  return Math.min(RADIUS_MAX, RADIUS_MIN / Math.sqrt(1 - u * 0.999999));
}

export type BeltField = {
  bake: BeltBake;
  seed: number;
  // pMax * densityScale, premultiplied: expected rocks/cell at density 255.
  pPeak: number;
};

export function makeBeltField(bake: BeltBake, seed: number, densityScale: number): BeltField {
  return { bake, seed, pPeak: densityScale * BELT_P_MAX };
}

// --- density sampling --------------------------------------------------------------

// Trilinear sample of the baked polar density at a WORLD position, in rocks-per-cell.
// f64 throughout; the operation order is fixed — this exact function runs on server,
// client main thread and worker.
export function sampleDensity(field: BeltField, x: number, y: number, z: number): number {
  const { meta, worldScale, density } = field.bake;
  const { nr, ntheta, nz, rMin, rMax, zMax } = meta.density;
  // World axis mapping (see format.ts): belt plane = x–z, vertical = y.
  const r = Math.hypot(x, z) / worldScale;
  if (r <= rMin || r >= rMax) {
    return 0;
  }
  const zn = y / worldScale;
  if (zn <= -zMax || zn >= zMax) {
    return 0;
  }
  const theta = Math.atan2(z, x); // [-pi, pi]

  const fr = ((r - rMin) / (rMax - rMin)) * nr - 0.5;
  const ft = ((theta + Math.PI) / (2 * Math.PI)) * ntheta - 0.5;
  const fz = ((zn + zMax) / (2 * zMax)) * nz - 0.5;

  let r0 = Math.floor(fr);
  let t0 = Math.floor(ft);
  let z0 = Math.floor(fz);
  const tr = fr - r0;
  const tt = ft - t0;
  const tz = fz - z0;
  let r1 = r0 + 1;
  let z1 = z0 + 1;
  if (r0 < 0) r0 = 0;
  if (r1 > nr - 1) r1 = nr - 1;
  if (z0 < 0) z0 = 0;
  if (z1 > nz - 1) z1 = nz - 1;
  const t0w = ((t0 % ntheta) + ntheta) % ntheta;
  const t1w = (t0w + 1) % ntheta;

  const at = (ir: number, it: number, iz: number): number => density[(ir * ntheta + it) * nz + iz]!;

  const c00 = at(r0, t0w, z0) + (at(r1, t0w, z0) - at(r0, t0w, z0)) * tr;
  const c10 = at(r0, t1w, z0) + (at(r1, t1w, z0) - at(r0, t1w, z0)) * tr;
  const c01 = at(r0, t0w, z1) + (at(r1, t0w, z1) - at(r0, t0w, z1)) * tr;
  const c11 = at(r0, t1w, z1) + (at(r1, t1w, z1) - at(r0, t1w, z1)) * tr;
  const c0 = c00 + (c10 - c00) * tt;
  const c1 = c01 + (c11 - c01) * tt;
  const value = c0 + (c1 - c0) * tz;
  return (value / 255) * field.pPeak;
}

export function zoneAtRadius(field: BeltField, x: number, z: number): number {
  const { meta, worldScale, zones } = field.bake;
  const { nr, rMin, rMax } = meta.density;
  const r = Math.hypot(x, z) / worldScale;
  const ir = Math.floor(((r - rMin) / (rMax - rMin)) * nr);
  if (ir < 0 || ir >= nr) {
    return 0;
  }
  return zones[ir]!;
}

// --- per-cell derivation --------------------------------------------------------------

function mineralFor(roll: number, zone: number): Mineral {
  const cdf = zone === 0 ? VOID_CDF : zone % 2 === 1 ? BAND_CDF : GAP_CDF;
  for (let i = 0; i < cdf.length; i += 1) {
    if (roll < cdf[i]!) {
      return MINERALS[i]!;
    }
  }
  return "nickel";
}

// The rock of a field cell, or null when the density roll leaves the cell empty.
// EXISTENCE uses noise(seed + 11) so the position/attribute seed channels (+1..+7) stay
// identical to the legacy formula — a cell that exists places its rock exactly where the
// legacy hash field would have.
export function beltRockAt(field: BeltField, cx: number, cy: number, cz: number): Asteroid | null {
  const geo = field.bake.geo;
  const seed = hashCell(field.seed, cx, cy, cz);

  const heroIndex = field.bake.heroes.byCell.get(beltCellKey(cx, cy, cz));
  if (heroIndex !== undefined) {
    const pr = field.bake.heroes.posRadius;
    const o = heroIndex * 4;
    const hx = pr[o]!;
    const hy = pr[o + 1]!;
    const hz = pr[o + 2]!;
    const family = field.bake.heroes.family[heroIndex]!;
    const zone = zoneAtRadius(field, hx, hz);
    const mineral =
      family >= 0 ? MINERALS[family % MINERALS.length]! : mineralFor(noise(seed + 4), zone);
    return {
      id: `v-${cx}-${cy}-${cz}`,
      pocket: pocketForZone(zone),
      position: { x: hx, y: hy, z: hz },
      radius: pr[o + 3]!,
      signature: Math.min(0.9, 0.23 + noise(seed + 6) * 0.7),
      mineralRichness: Math.min(1, 0.43 + noise(seed + 7) * 0.57),
      rareMineral: mineral,
      discovered: true,
    };
  }

  const centerX = geo.originXZ + cx * geo.cellSize + geo.cellSize / 2;
  const centerY = geo.originY + cy * geo.cellSize + geo.cellSize / 2;
  const centerZ = geo.originXZ + cz * geo.cellSize + geo.cellSize / 2;
  const p = sampleDensity(field, centerX, centerY, centerZ);
  if (p <= 0 || noise(seed + 11) >= p) {
    return null;
  }
  const zone = zoneAtRadius(field, centerX, centerZ);
  return {
    id: `v-${cx}-${cy}-${cz}`,
    pocket: pocketForZone(zone),
    position: {
      x: geo.originXZ + cx * geo.cellSize + noise(seed + 1) * geo.cellSize,
      y: geo.originY + cy * geo.cellSize + noise(seed + 2) * geo.cellSize,
      z: geo.originXZ + cz * geo.cellSize + noise(seed + 3) * geo.cellSize,
    },
    radius: backgroundRadius(noise(seed + 5)),
    signature: 0.08 + noise(seed + 6) * 0.7,
    mineralRichness: 0.18 + noise(seed + 7) * 0.82,
    rareMineral: mineralFor(noise(seed + 4), zone),
    discovered: true,
  };
}

// Position + radius only — the collision/sun-occlusion fast path (no id string, no
// object churn for empty cells). Returns false when the cell is empty.
export function beltRockShapeAt(
  field: BeltField,
  cx: number,
  cy: number,
  cz: number,
  out: { x: number; y: number; z: number; radius: number },
): boolean {
  const geo = field.bake.geo;
  const heroIndex = field.bake.heroes.byCell.get(beltCellKey(cx, cy, cz));
  if (heroIndex !== undefined) {
    const pr = field.bake.heroes.posRadius;
    const o = heroIndex * 4;
    out.x = pr[o]!;
    out.y = pr[o + 1]!;
    out.z = pr[o + 2]!;
    out.radius = pr[o + 3]!;
    return true;
  }
  const seed = hashCell(field.seed, cx, cy, cz);
  const centerX = geo.originXZ + cx * geo.cellSize + geo.cellSize / 2;
  const centerY = geo.originY + cy * geo.cellSize + geo.cellSize / 2;
  const centerZ = geo.originXZ + cz * geo.cellSize + geo.cellSize / 2;
  const p = sampleDensity(field, centerX, centerY, centerZ);
  if (p <= 0 || noise(seed + 11) >= p) {
    return false;
  }
  out.x = geo.originXZ + cx * geo.cellSize + noise(seed + 1) * geo.cellSize;
  out.y = geo.originY + cy * geo.cellSize + noise(seed + 2) * geo.cellSize;
  out.z = geo.originXZ + cz * geo.cellSize + noise(seed + 3) * geo.cellSize;
  out.radius = backgroundRadius(noise(seed + 5));
  return true;
}

export function beltCellCoords(
  field: BeltField,
  position: Vector3,
): { cx: number; cy: number; cz: number } {
  const geo = field.bake.geo;
  const clampXZ = (v: number): number => Math.max(0, Math.min(geo.cellsXZ - 1, v));
  const clampY = (v: number): number => Math.max(0, Math.min(geo.cellsY - 1, v));
  return {
    cx: clampXZ(Math.floor((position.x - geo.originXZ) / geo.cellSize)),
    cy: clampY(Math.floor((position.y - geo.originY) / geo.cellSize)),
    cz: clampXZ(Math.floor((position.z - geo.originXZ) / geo.cellSize)),
  };
}

// Hard bound on the growing-cube scan (half-width in cells). In a resonance gap or the
// inner void the nearest `limit` rocks may be hundreds of km away; the field then
// legitimately returns FEWER than `limit` rocks (gaps are supposed to be empty) instead
// of scanning forever. 44 -> worst case 89^3 ≈ 705k cell evaluations, on par with the
// legacy field's full 100^3 scan.
export const BELT_DERIVE_MAX_HALF = 44;

// The nearest ≤`limit` belt rocks to `position`'s CELL CENTER, sorted nearest first —
// the belt successor of field-core's deriveVirtualField (same growing-cube proof: stop
// once the limit-th rock is provably nearer than any unscanned cell). Pure function of
// (bake bytes, seed, cell, limit) on every consumer.
export function deriveBeltField(field: BeltField, position: Vector3, limit: number): Asteroid[] {
  const geo = field.bake.geo;
  const lastXZ = geo.cellsXZ - 1;
  const lastY = geo.cellsY - 1;
  const { cx, cy, cz } = beltCellCoords(field, position);
  const ox = geo.originXZ + cx * geo.cellSize + geo.cellSize / 2;
  const oy = geo.originY + cy * geo.cellSize + geo.cellSize / 2;
  const oz = geo.originXZ + cz * geo.cellSize + geo.cellSize / 2;

  let half = Math.max(2, Math.ceil(Math.cbrt(limit) / 2));
  let candidates: Array<{ asteroid: Asteroid; d2: number }> = [];
  for (;;) {
    const minX = Math.max(0, cx - half);
    const maxX = Math.min(lastXZ, cx + half);
    const minY = Math.max(0, cy - half);
    const maxY = Math.min(lastY, cy + half);
    const minZ = Math.max(0, cz - half);
    const maxZ = Math.min(lastXZ, cz + half);
    candidates = [];
    for (let x = minX; x <= maxX; x += 1) {
      for (let y = minY; y <= maxY; y += 1) {
        for (let z = minZ; z <= maxZ; z += 1) {
          const asteroid = beltRockAt(field, x, y, z);
          if (asteroid === null) {
            continue;
          }
          const dx = asteroid.position.x - ox;
          const dy = asteroid.position.y - oy;
          const dz = asteroid.position.z - oz;
          candidates.push({ asteroid, d2: dx * dx + dy * dy + dz * dz });
        }
      }
    }
    const capped = half >= BELT_DERIVE_MAX_HALF;
    if (candidates.length >= limit) {
      candidates.sort((a, b) => a.d2 - b.d2);
      const safe = (half + 0.5) * geo.cellSize;
      const limitRock = candidates[limit - 1];
      if (capped || (limitRock !== undefined && Math.sqrt(limitRock.d2) <= safe)) {
        break;
      }
    } else if (capped) {
      candidates.sort((a, b) => a.d2 - b.d2);
      break;
    }
    half = Math.min(BELT_DERIVE_MAX_HALF, half + Math.max(2, Math.ceil(half * 0.5)));
  }

  const count = Math.min(candidates.length, limit);
  const result: Asteroid[] = new Array(count);
  for (let i = 0; i < count; i += 1) {
    result[i] = candidates[i]!.asteroid;
  }
  return result;
}

// Box query around an origin (server scan hits / diagnostics). Radius is bounded so the
// scan stays O(bounded box), like the legacy queryVirtualAsteroids.
export function queryBeltAsteroids(
  field: BeltField,
  origin: Vector3,
  radius: number,
  limit: number,
): { asteroids: Asteroid[]; cellsVisited: number; materializedAsteroids: number } {
  const geo = field.bake.geo;
  const bounded = Math.max(geo.cellSize, Math.min(radius, geo.cellSize * 50));
  const min = beltCellCoords(field, {
    x: origin.x - bounded,
    y: origin.y - bounded,
    z: origin.z - bounded,
  });
  const max = beltCellCoords(field, {
    x: origin.x + bounded,
    y: origin.y + bounded,
    z: origin.z + bounded,
  });
  const candidates: Array<{ asteroid: Asteroid; d2: number }> = [];
  let cellsVisited = 0;
  for (let x = min.cx; x <= max.cx; x += 1) {
    for (let y = min.cy; y <= max.cy; y += 1) {
      for (let z = min.cz; z <= max.cz; z += 1) {
        cellsVisited += 1;
        const asteroid = beltRockAt(field, x, y, z);
        if (asteroid === null) {
          continue;
        }
        const dx = asteroid.position.x - origin.x;
        const dy = asteroid.position.y - origin.y;
        const dz = asteroid.position.z - origin.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 <= bounded * bounded) {
          candidates.push({ asteroid, d2 });
        }
      }
    }
  }
  candidates.sort((a, b) => a.d2 - b.d2);
  return {
    asteroids: candidates.slice(0, Math.max(1, limit)).map((c) => c.asteroid),
    cellsVisited,
    materializedAsteroids: candidates.length,
  };
}
