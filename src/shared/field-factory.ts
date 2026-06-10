import type { Vector3 } from "./types";

// ---------------------------------------------------------------------------
// Deterministic asteroid field factory.
//
// The field is virtual and streamed: rocks are generated on demand per fine
// cell with no global pass, so every level of structure must be a pure
// function of (seed, coords). Three octaves:
//
//   macro   (10-30 km)  — belt-scale density: thick regions, thin regions,
//                         true voids. Tri-linear value noise over world space.
//   cluster (1-5 km)    — a coarse grid where each coarse cell hashes to a
//                         cluster archetype (or none): pocket, filament,
//                         sheet, ring arc, drift. The archetype modulates
//                         fine-cell occupancy, radius distribution, position
//                         warping and rotation character.
//   rock    (per cell)  — 0..N rocks per fine cell (the legacy 1-rock-per-cell
//                         invariant is gone): jittered position pulled toward
//                         the dominant cluster's geometry, radius from the
//                         archetype's distribution, gameplay scalars, spin.
//
// All randomness comes from integer hashing (imul/xor-shift) — bit-exact on
// every JS engine, unlike the legacy frac(sin(seed)) noise. The legacy field
// stays available behind the "legacy-uniform" preset (exact reproduction,
// including its sin-based noise) for A/B.
//
// This module is imported by the server (field.ts), the client field worker
// (field-core.ts) and the offline preview harness. It must stay free of DOM,
// Three.js and node imports.
// ---------------------------------------------------------------------------

export type FieldGeometry = {
  seed: number;
  cellSize: number; // fine cell edge, meters
  cellsPerAxis: number;
  originOffset: number; // world coord of cell (0,0,0) corner
};

export const DEFAULT_GEOMETRY: FieldGeometry = {
  seed: 424242,
  cellSize: 1130,
  cellsPerAxis: 100,
  originOffset: -(100 * 1130) / 2,
};

// A generated rock, pre-gameplay-schema. The integration layer maps this onto
// the wire `Asteroid` shape (id, pocket, discovered) — the factory itself only
// knows physical + gameplay-scalar properties so the preview harness can stay
// schema-free.
export type RockSpec = {
  cx: number;
  cy: number;
  cz: number;
  index: number; // rock index within its fine cell
  position: Vector3; // world meters
  radius: number; // meters
  archetype: string; // archetype name that shaped this rock ("base" if none)
  role: 0 | 1 | 2; // 0 gravel, 1 mid, 2 anchor — for palette/material tiers
  spinRate: number; // rad/s cosmetic tumble rate
  signature: number;
  mineralRichness: number;
  mineralIndex: number; // index into the shared 6-mineral table
};

// ---------------------------------------------------------------------------
// Hashing — all integer math, bit-exact across engines.
// ---------------------------------------------------------------------------

function mix32(h: number): number {
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  return (h ^ (h >>> 16)) >>> 0;
}

function hash4(seed: number, x: number, y: number, z: number, salt: number): number {
  let h = seed | 0;
  h = (h ^ Math.imul(x | 0, 0x9e3779b1)) | 0;
  h = (h ^ Math.imul(y | 0, 0x85ebca77)) | 0;
  h = (h ^ Math.imul(z | 0, 0xc2b2ae3d)) | 0;
  h = (h ^ Math.imul(salt | 0, 0x27d4eb2f)) | 0;
  return mix32(h);
}

// uniform [0,1) from a 32-bit hash
function u01(h: number): number {
  return h / 4294967296;
}

// salts — one per independent random channel
const S_MACRO = 11;
const S_ARCH = 21;
const S_CLUSTER_JIT = 22;
const S_CLUSTER_AXIS = 23;
const S_CLUSTER_RAD = 24;
const S_CLUSTER_PHASE = 25;
const S_COUNT = 31;
const S_ROCK = 41; // rock channels offset by index*16 + channel

// ---------------------------------------------------------------------------
// Macro octave — tri-linear value noise (fBm) over world space.
// ---------------------------------------------------------------------------

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

function valueNoise3(seed: number, x: number, y: number, z: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const z0 = Math.floor(z);
  const fx = smooth(x - x0);
  const fy = smooth(y - y0);
  const fz = smooth(z - z0);
  const c = (dx: number, dy: number, dz: number): number =>
    u01(hash4(seed, x0 + dx, y0 + dy, z0 + dz, S_MACRO));
  const x00 = c(0, 0, 0) + (c(1, 0, 0) - c(0, 0, 0)) * fx;
  const x10 = c(0, 1, 0) + (c(1, 1, 0) - c(0, 1, 0)) * fx;
  const x01 = c(0, 0, 1) + (c(1, 0, 1) - c(0, 0, 1)) * fx;
  const x11 = c(0, 1, 1) + (c(1, 1, 1) - c(0, 1, 1)) * fx;
  const y0v = x00 + (x10 - x00) * fy;
  const y1v = x01 + (x11 - x01) * fy;
  return y0v + (y1v - y0v) * fz;
}

export type MacroParams = {
  wavelength: number; // meters, dominant octave
  octaves: number; // 1..3
  // density shaping: v below voidThreshold → 0 (true void); above, renormalized
  // and raised to gamma. floor adds an everywhere-present haze fraction.
  voidThreshold: number; // 0..1
  gamma: number;
  floor: number; // 0..1
  // optional classic-belt slab: density falls off with |y| over halfThickness
  // (quadratic, raised to power), turning the cube field into a disk plane.
  slab?: { halfThickness: number; power: number };
};

export function macroDensity(geo: FieldGeometry, macro: MacroParams, p: Vector3): number {
  let v = 0;
  let amp = 0;
  let freq = 1 / macro.wavelength;
  let scale = 1;
  for (let o = 0; o < macro.octaves; o += 1) {
    v += scale * valueNoise3(geo.seed + o * 101, p.x * freq, p.y * freq, p.z * freq);
    amp += scale;
    scale *= 0.5;
    freq *= 2.13; // non-integer lacunarity avoids lattice alignment
  }
  v /= amp;
  let slab = 1;
  if (macro.slab !== undefined) {
    const yt = Math.abs(p.y) / macro.slab.halfThickness;
    slab = yt >= 1 ? 0 : Math.pow(1 - yt * yt, macro.slab.power);
  }
  const t = (v - macro.voidThreshold) / (1 - macro.voidThreshold);
  if (t <= 0) {
    return macro.floor * slab;
  }
  return (macro.floor + (1 - macro.floor) * Math.pow(Math.min(1, t), macro.gamma)) * slab;
}

// ---------------------------------------------------------------------------
// Cluster octave — coarse grid, each coarse cell hashes to an archetype or none.
// ---------------------------------------------------------------------------

export type RadiusDist =
  | { kind: "uniform"; min: number; max: number }
  | { kind: "power"; min: number; max: number; alpha: number } // p(r) ∝ r^-alpha
  | {
      kind: "bimodal";
      small: [number, number];
      big: [number, number];
      // chance of a "big" draw at intensity 1; scales with intensity² so
      // anchors concentrate at cluster cores.
      bigChance: number;
    };

export type ArchetypeParams = {
  name: string;
  kind: "pocket" | "filament" | "sheet" | "ring" | "drift";
  // mean rocks per fine cell at intensity 1 (before macro modulation)
  countScale: number;
  // influence radius as a fraction of the coarse cell size [min, max]
  radiusFrac: [number, number];
  // tube/slab half-thickness in meters (filament, sheet, ring)
  thickness?: number;
  // ring radius as fraction of influence radius; arc coverage 0..1
  ringRadiusFrac?: number;
  arcFraction?: number;
  // 0..1 — how hard rock positions are pulled onto the cluster geometry
  sharpness: number;
  radius: RadiusDist;
  spinRange: [number, number]; // rad/s
  // weights over the 6 shared minerals (nickel, waterIce, cobalt, silicates, platinum, xenotime)
  mineralWeights: [number, number, number, number, number, number];
};

export type FieldPreset = {
  name: string;
  legacy?: boolean; // exact reproduction of the pre-factory uniform field
  macro: MacroParams;
  clusterCells: number; // coarse cell edge, in fine cells (e.g. 3 → 3.39 km)
  // archetype mix: weights need not sum to 1; remainder = no cluster
  archetypes: Array<{ params: ArchetypeParams; weight: number }>;
  // rocks per fine cell baseline outside clusters (before macro modulation)
  baseDensity: number;
  maxRocksPerCell: number;
};

type ClusterSpec = {
  params: ArchetypeParams;
  center: Vector3;
  radius: number; // influence radius, meters
  axis: Vector3; // unit — filament direction / sheet+ring normal
  phase: number; // 0..1 — arc start angle
};

function unitVectorFrom(h1: number, h2: number): Vector3 {
  const z = 2 * u01(h1) - 1;
  const theta = 2 * Math.PI * u01(h2);
  const s = Math.sqrt(Math.max(0, 1 - z * z));
  return { x: s * Math.cos(theta), y: s * Math.sin(theta), z };
}

function clusterAt(
  geo: FieldGeometry,
  preset: FieldPreset,
  kx: number,
  ky: number,
  kz: number,
): ClusterSpec | null {
  if (preset.archetypes.length === 0) {
    return null;
  }
  const coarseSize = preset.clusterCells * geo.cellSize;
  const jx = u01(hash4(geo.seed, kx, ky, kz, S_CLUSTER_JIT));
  const jy = u01(hash4(geo.seed, kx, ky, kz, S_CLUSTER_JIT + 1));
  const jz = u01(hash4(geo.seed, kx, ky, kz, S_CLUSTER_JIT + 2));
  const center = {
    x: geo.originOffset + (kx + 0.25 + 0.5 * jx) * coarseSize,
    y: geo.originOffset + (ky + 0.25 + 0.5 * jy) * coarseSize,
    z: geo.originOffset + (kz + 0.25 + 0.5 * jz) * coarseSize,
  };
  // Macro gates cluster EXISTENCE, not cluster intensity: thick belt regions
  // grow more clusters, voids grow none, and every cluster that does exist is
  // fully formed (multiplying intensities instead left faint half-clusters
  // everywhere and crisp ones nowhere).
  const macroHere = macroDensity(geo, preset.macro, center);
  const roll = u01(hash4(geo.seed, kx, ky, kz, S_ARCH));
  // roll over [0,1): macro-scaled archetypes stacked first, "none" = remainder
  let acc = 0;
  let chosen: ArchetypeParams | null = null;
  for (const entry of preset.archetypes) {
    acc += entry.weight * macroHere;
    if (roll < acc) {
      chosen = entry.params;
      break;
    }
  }
  if (chosen === null) {
    return null;
  }
  const radT = u01(hash4(geo.seed, kx, ky, kz, S_CLUSTER_RAD));
  const radius =
    coarseSize * (chosen.radiusFrac[0] + (chosen.radiusFrac[1] - chosen.radiusFrac[0]) * radT);
  const axis = unitVectorFrom(
    hash4(geo.seed, kx, ky, kz, S_CLUSTER_AXIS),
    hash4(geo.seed, kx, ky, kz, S_CLUSTER_AXIS + 1),
  );
  const phase = u01(hash4(geo.seed, kx, ky, kz, S_CLUSTER_PHASE));
  return { params: chosen, center, radius, axis, phase };
}

// intensity ∈ [0,1] of a cluster at point p, plus the nearest point on the
// cluster's geometry (the warp target for rock placement).
//
// minScale floors the thin-direction falloff scale. The COUNT path passes the
// fine cell size: a filament/sheet/ring far thinner than a cell must still
// light up every cell its geometry passes through (the cell center can sit up
// to ~cellSize/√2 off the surface) — placement then squeezes the rocks back
// onto the thin geometry. The placement path passes 0.
function clusterField(
  c: ClusterSpec,
  p: Vector3,
  minScale = 0,
): { intensity: number; nearest: Vector3 } {
  const dx = p.x - c.center.x;
  const dy = p.y - c.center.y;
  const dz = p.z - c.center.z;
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const kind = c.params.kind;

  if (kind === "pocket" || kind === "drift") {
    const t = dist / c.radius;
    const falloff = t >= 1 ? 0 : 1 - t * t;
    return { intensity: falloff * falloff, nearest: c.center };
  }

  // longitudinal coordinate along axis / normal coordinate off plane
  const along = dx * c.axis.x + dy * c.axis.y + dz * c.axis.z;

  if (kind === "filament") {
    // line segment through center, half-length = radius
    const clampedAlong = Math.max(-c.radius, Math.min(c.radius, along));
    const nearest = {
      x: c.center.x + c.axis.x * clampedAlong,
      y: c.center.y + c.axis.y * clampedAlong,
      z: c.center.z + c.axis.z * clampedAlong,
    };
    const lx = p.x - nearest.x;
    const ly = p.y - nearest.y;
    const lz = p.z - nearest.z;
    const lateral = Math.sqrt(lx * lx + ly * ly + lz * lz);
    const thickness = c.params.thickness ?? 400;
    // lateral gaussian-ish falloff over ~3 thicknesses; soft longitudinal ends
    const lt = lateral / Math.max(thickness * 3, minScale);
    const lat = lt >= 1 ? 0 : 1 - lt * lt;
    const at = Math.abs(along) / c.radius;
    const lon = at >= 1.2 ? 0 : Math.min(1, 1.2 - at);
    return { intensity: lat * lat * lon, nearest };
  }

  if (kind === "sheet") {
    // disc of radius `radius` in the plane through center with normal axis
    const px = dx - c.axis.x * along;
    const py = dy - c.axis.y * along;
    const pz = dz - c.axis.z * along;
    const radial = Math.sqrt(px * px + py * py + pz * pz);
    const rClamped = Math.min(radial, c.radius);
    const scale = radial > 0 ? rClamped / radial : 0;
    const nearest = {
      x: c.center.x + px * scale,
      y: c.center.y + py * scale,
      z: c.center.z + pz * scale,
    };
    const thickness = c.params.thickness ?? 300;
    const nt = Math.abs(along) / Math.max(thickness * 3, minScale);
    const norm = nt >= 1 ? 0 : 1 - nt * nt;
    const rt = radial / c.radius;
    const rad = rt >= 1.15 ? 0 : Math.min(1, (1.15 - rt) / 0.4);
    return { intensity: norm * norm * Math.min(1, rad), nearest };
  }

  // ring: circle of radius ringR in the plane through center, normal = axis
  const ringR = c.radius * (c.params.ringRadiusFrac ?? 0.7);
  const px = dx - c.axis.x * along;
  const py = dy - c.axis.y * along;
  const pz = dz - c.axis.z * along;
  const radial = Math.sqrt(px * px + py * py + pz * pz);
  let nearest: Vector3;
  if (radial > 1e-6) {
    const s = ringR / radial;
    nearest = { x: c.center.x + px * s, y: c.center.y + py * s, z: c.center.z + pz * s };
  } else {
    nearest = c.center;
  }
  const dRing = Math.sqrt((radial - ringR) * (radial - ringR) + along * along);
  const thickness = c.params.thickness ?? 350;
  const t = dRing / Math.max(thickness * 3, minScale);
  let intensity = t >= 1 ? 0 : (1 - t * t) * (1 - t * t);
  const arc = c.params.arcFraction ?? 1;
  if (arc < 1 && intensity > 0) {
    // angle of p's projection around the ring, against a basis fixed by axis
    const basis = orthoBasis(c.axis);
    const angle = Math.atan2(
      px * basis.v.x + py * basis.v.y + pz * basis.v.z,
      px * basis.u.x + py * basis.u.y + pz * basis.u.z,
    );
    let frac = (angle / (2 * Math.PI) + 1 - c.phase) % 1;
    if (frac < 0) {
      frac += 1;
    }
    if (frac > arc) {
      intensity = 0;
    } else {
      // soft ends over 10% of the arc
      const endFade = Math.min(frac, arc - frac) / (arc * 0.1);
      intensity *= Math.min(1, endFade);
    }
  }
  return { intensity, nearest };
}

function orthoBasis(n: Vector3): { u: Vector3; v: Vector3 } {
  // stable orthonormal basis perpendicular to n (Duff et al. branchless form)
  const sign = n.z >= 0 ? 1 : -1;
  const a = -1 / (sign + n.z);
  const b = n.x * n.y * a;
  return {
    u: { x: 1 + sign * n.x * n.x * a, y: sign * b, z: -sign * n.x },
    v: { x: b, y: sign + n.y * n.y * a, z: -n.y },
  };
}

// Per-query memo of coarse-cell cluster lookups. A derive visits ~200k fine
// cells; without the memo each would re-hash 27 coarse cells.
export type FieldContext = {
  clusters: Map<number, ClusterSpec | null>;
};

export function createFieldContext(): FieldContext {
  return { clusters: new Map() };
}

const COARSE_KEY_BASE = 4096;
function coarseKey(kx: number, ky: number, kz: number): number {
  return ((kx + 64) * COARSE_KEY_BASE + (ky + 64)) * COARSE_KEY_BASE + (kz + 64);
}

function clusterAtMemo(
  geo: FieldGeometry,
  preset: FieldPreset,
  ctx: FieldContext,
  kx: number,
  ky: number,
  kz: number,
): ClusterSpec | null {
  const key = coarseKey(kx, ky, kz);
  const hit = ctx.clusters.get(key);
  if (hit !== undefined) {
    return hit;
  }
  const built = clusterAt(geo, preset, kx, ky, kz);
  ctx.clusters.set(key, built);
  return built;
}

// ---------------------------------------------------------------------------
// Rock octave — rocks for one fine cell.
// ---------------------------------------------------------------------------

function sampleRadius(
  dist: RadiusDist,
  u: number,
  intensity: number,
  uBig: number,
): {
  radius: number;
  role: 0 | 1 | 2;
} {
  if (dist.kind === "uniform") {
    const r = dist.min + (dist.max - dist.min) * u;
    return { radius: r, role: r > dist.min + (dist.max - dist.min) * 0.66 ? 1 : 0 };
  }
  if (dist.kind === "power") {
    const a = dist.alpha;
    let r: number;
    if (Math.abs(a - 1) < 1e-6) {
      r = dist.min * Math.pow(dist.max / dist.min, u);
    } else {
      const lo = Math.pow(dist.min, 1 - a);
      const hi = Math.pow(dist.max, 1 - a);
      r = Math.pow(lo + (hi - lo) * u, 1 / (1 - a));
    }
    return { radius: r, role: r > dist.max * 0.5 ? 1 : 0 };
  }
  // bimodal: anchors concentrate where the cluster is most intense
  const chance = dist.bigChance * intensity * intensity;
  if (uBig < chance) {
    return { radius: dist.big[0] + (dist.big[1] - dist.big[0]) * u, role: 2 };
  }
  return { radius: dist.small[0] + (dist.small[1] - dist.small[0]) * u, role: 0 };
}

function pickMineral(weights: [number, number, number, number, number, number], u: number): number {
  let total = 0;
  for (const w of weights) {
    total += w;
  }
  let roll = u * total;
  for (let i = 0; i < 6; i += 1) {
    roll -= weights[i]!;
    if (roll < 0) {
      return i;
    }
  }
  return 0;
}

// All rocks for one fine cell. Pure function of (geo.seed, preset, cell).
export function rocksInCell(
  geo: FieldGeometry,
  preset: FieldPreset,
  ctx: FieldContext,
  cx: number,
  cy: number,
  cz: number,
): RockSpec[] {
  if (preset.legacy) {
    return [legacyRock(geo, cx, cy, cz)];
  }
  const cellCenter = {
    x: geo.originOffset + (cx + 0.5) * geo.cellSize,
    y: geo.originOffset + (cy + 0.5) * geo.cellSize,
    z: geo.originOffset + (cz + 0.5) * geo.cellSize,
  };
  const macro = macroDensity(geo, preset.macro, cellCenter);
  if (macro <= 0) {
    return [];
  }

  // dominant cluster + total cluster drive at this cell
  const kx = Math.floor((cx + 0.0) / preset.clusterCells);
  const ky = Math.floor((cy + 0.0) / preset.clusterCells);
  const kz = Math.floor((cz + 0.0) / preset.clusterCells);
  let drive = 0;
  let best: ClusterSpec | null = null;
  let bestField: { intensity: number; nearest: Vector3 } | null = null;
  let bestScore = 0;
  for (let dx = -1; dx <= 1; dx += 1) {
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dz = -1; dz <= 1; dz += 1) {
        const cluster = clusterAtMemo(geo, preset, ctx, kx + dx, ky + dy, kz + dz);
        if (cluster === null) {
          continue;
        }
        const field = clusterField(cluster, cellCenter, geo.cellSize);
        if (field.intensity <= 0) {
          continue;
        }
        drive += cluster.params.countScale * field.intensity;
        const score = cluster.params.countScale * field.intensity;
        if (score > bestScore) {
          bestScore = score;
          best = cluster;
          bestField = field;
        }
      }
    }
  }

  // base scatter follows macro density; cluster rocks come at full strength
  // (their existence was already macro-gated at cluster creation)
  const expected = macro * preset.baseDensity + drive;
  if (expected <= 0) {
    return [];
  }
  // deterministic stochastic rounding, capped
  const base = Math.floor(expected);
  const frac = expected - base;
  const extra = u01(hash4(geo.seed, cx, cy, cz, S_COUNT)) < frac ? 1 : 0;
  const count = Math.min(preset.maxRocksPerCell, base + extra);
  if (count === 0) {
    return [];
  }

  const rocks: RockSpec[] = [];
  for (let i = 0; i < count; i += 1) {
    const ch = (channel: number): number => hash4(geo.seed, cx, cy, cz, S_ROCK + i * 16 + channel);
    // jittered position within the cell
    let px = geo.originOffset + (cx + u01(ch(0))) * geo.cellSize;
    let py = geo.originOffset + (cy + u01(ch(1))) * geo.cellSize;
    let pz = geo.originOffset + (cz + u01(ch(2))) * geo.cellSize;

    let intensity = 0;
    let archetypeName = "base";
    let params: ArchetypeParams | null = null;
    if (best !== null && bestField !== null) {
      params = best.params;
      archetypeName = params.name;
      intensity = bestField.intensity;
      // Re-sample this rock's distance from the cluster geometry directly:
      // nearest point on the geometry for the jittered position, then a
      // controlled residual offset along the away-direction. This keeps
      // filaments/rings/sheets crisp instead of cell-quantized (warping by
      // local intensity fails: rocks jittered outside the falloff see
      // intensity 0 and never move).
      const f = clusterField(best, { x: px, y: py, z: pz });
      const ax = px - f.nearest.x;
      const ay = py - f.nearest.y;
      const az = pz - f.nearest.z;
      const away = Math.sqrt(ax * ax + ay * ay + az * az);
      if (away > 1e-6) {
        const scatterScale =
          params.kind === "pocket" || params.kind === "drift"
            ? best.radius
            : (params.thickness ?? 300) * 3;
        const residual = Math.min(away, scatterScale * Math.pow(u01(ch(3)), 1.4));
        const wx = f.nearest.x + (ax / away) * residual;
        const wy = f.nearest.y + (ay / away) * residual;
        const wz = f.nearest.z + (az / away) * residual;
        px += (wx - px) * params.sharpness;
        py += (wy - py) * params.sharpness;
        pz += (wz - pz) * params.sharpness;
      }
    }

    const dist = params?.radius ?? DEFAULT_RADIUS;
    const { radius, role } = sampleRadius(dist, u01(ch(4)), intensity, u01(ch(5)));
    const spinRange = params?.spinRange ?? DEFAULT_SPIN;
    const spinRate = spinRange[0] + (spinRange[1] - spinRange[0]) * u01(ch(6));
    const weights = params?.mineralWeights ?? DEFAULT_MINERALS;

    rocks.push({
      cx,
      cy,
      cz,
      index: i,
      position: { x: px, y: py, z: pz },
      radius,
      archetype: archetypeName,
      role,
      spinRate,
      signature: 0.08 + u01(ch(7)) * 0.7,
      mineralRichness: 0.18 + u01(ch(8)) * 0.82,
      mineralIndex: pickMineral(weights, u01(ch(9))),
    });
  }
  return rocks;
}

const DEFAULT_RADIUS: RadiusDist = { kind: "power", min: 30, max: 240, alpha: 2.4 };
const DEFAULT_SPIN: [number, number] = [0.05, 0.3];
const DEFAULT_MINERALS: [number, number, number, number, number, number] = [3, 2, 2, 3, 1, 1];

// ---------------------------------------------------------------------------
// Legacy field — exact reproduction of the pre-factory uniform scatter,
// including its engine-dependent sin noise. Kept for A/B.
// ---------------------------------------------------------------------------

function legacyNoise(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

function legacyRock(geo: FieldGeometry, cx: number, cy: number, cz: number): RockSpec {
  const seed = geo.seed + cx * 73856093 + cy * 19349663 + cz * 83492791;
  return {
    cx,
    cy,
    cz,
    index: 0,
    position: {
      x: geo.originOffset + cx * geo.cellSize + legacyNoise(seed + 1) * geo.cellSize,
      y: geo.originOffset + cy * geo.cellSize + legacyNoise(seed + 2) * geo.cellSize,
      z: geo.originOffset + cz * geo.cellSize + legacyNoise(seed + 3) * geo.cellSize,
    },
    radius: 45 + legacyNoise(seed + 5) * 310,
    archetype: "legacy-uniform",
    role: 0,
    spinRate: 0.05 + legacyNoise(seed + 8) * 0.25,
    signature: 0.08 + legacyNoise(seed + 6) * 0.7,
    mineralRichness: 0.18 + legacyNoise(seed + 7) * 0.82,
    mineralIndex: Math.floor(legacyNoise(seed + 4) * 6) % 6,
  };
}

// ---------------------------------------------------------------------------
// Queries — bounded neighborhood scans, shared by preview/parity/integration.
// ---------------------------------------------------------------------------

function clampCell(value: number, cellsPerAxis: number): number {
  return Math.max(0, Math.min(cellsPerAxis - 1, value));
}

// Clusters within `radius` meters of `origin`, nearest first — used by the
// preview harness to frame close-ups on real cluster centers.
export function clustersNear(
  geo: FieldGeometry,
  preset: FieldPreset,
  origin: Vector3,
  radius: number,
): Array<{ name: string; kind: string; center: Vector3; radius: number; axis: Vector3 }> {
  const coarseSize = preset.clusterCells * geo.cellSize;
  const span = Math.ceil(radius / coarseSize);
  const k0 = {
    x: Math.floor((origin.x - geo.originOffset) / coarseSize),
    y: Math.floor((origin.y - geo.originOffset) / coarseSize),
    z: Math.floor((origin.z - geo.originOffset) / coarseSize),
  };
  const found: Array<{
    name: string;
    kind: string;
    center: Vector3;
    radius: number;
    axis: Vector3;
    d2: number;
  }> = [];
  for (let dx = -span; dx <= span; dx += 1) {
    for (let dy = -span; dy <= span; dy += 1) {
      for (let dz = -span; dz <= span; dz += 1) {
        const c = clusterAt(geo, preset, k0.x + dx, k0.y + dy, k0.z + dz);
        if (c === null) {
          continue;
        }
        const ox = c.center.x - origin.x;
        const oy = c.center.y - origin.y;
        const oz = c.center.z - origin.z;
        found.push({
          name: c.params.name,
          kind: c.params.kind,
          center: c.center,
          radius: c.radius,
          axis: c.axis,
          d2: ox * ox + oy * oy + oz * oz,
        });
      }
    }
  }
  found.sort((a, b) => a.d2 - b.d2);
  return found.map(({ d2: _d2, ...rest }) => rest);
}

// All rocks within `radius` meters of `origin` (no sorting, no limit) — the
// preview harness's workhorse.
export function rocksInSphere(
  geo: FieldGeometry,
  preset: FieldPreset,
  origin: Vector3,
  radius: number,
): RockSpec[] {
  const ctx = createFieldContext();
  const minC = {
    x: clampCell(
      Math.floor((origin.x - radius - geo.originOffset) / geo.cellSize),
      geo.cellsPerAxis,
    ),
    y: clampCell(
      Math.floor((origin.y - radius - geo.originOffset) / geo.cellSize),
      geo.cellsPerAxis,
    ),
    z: clampCell(
      Math.floor((origin.z - radius - geo.originOffset) / geo.cellSize),
      geo.cellsPerAxis,
    ),
  };
  const maxC = {
    x: clampCell(
      Math.floor((origin.x + radius - geo.originOffset) / geo.cellSize),
      geo.cellsPerAxis,
    ),
    y: clampCell(
      Math.floor((origin.y + radius - geo.originOffset) / geo.cellSize),
      geo.cellsPerAxis,
    ),
    z: clampCell(
      Math.floor((origin.z + radius - geo.originOffset) / geo.cellSize),
      geo.cellsPerAxis,
    ),
  };
  const out: RockSpec[] = [];
  const r2 = radius * radius;
  for (let x = minC.x; x <= maxC.x; x += 1) {
    for (let y = minC.y; y <= maxC.y; y += 1) {
      for (let z = minC.z; z <= maxC.z; z += 1) {
        for (const rock of rocksInCell(geo, preset, ctx, x, y, z)) {
          const dx = rock.position.x - origin.x;
          const dy = rock.position.y - origin.y;
          const dz = rock.position.z - origin.z;
          if (dx * dx + dy * dy + dz * dz <= r2) {
            out.push(rock);
          }
        }
      }
    }
  }
  return out;
}
