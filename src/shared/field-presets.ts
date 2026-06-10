import type { ArchetypeParams, FieldPreset } from "./field-factory";

// ---------------------------------------------------------------------------
// Archetype library — data-driven cluster presets. Each is a pure params
// object; the factory turns them into geometry. Tune freely: nothing here is
// load-bearing beyond "same params + same seed → same field".
// ---------------------------------------------------------------------------

// Dense spherical clump: a few big anchor rocks at the core, gravel halo.
export const pocket: ArchetypeParams = {
  name: "pocket",
  kind: "pocket",
  countScale: 14,
  radiusFrac: [0.35, 0.6],
  sharpness: 0.55,
  radius: { kind: "bimodal", small: [18, 70], big: [180, 360], bigChance: 0.12 },
  spinRange: [0.02, 0.12],
  mineralWeights: [2, 1, 3, 2, 2, 1],
};

// String of rocks along a line — reads as a flow/stream.
export const filament: ArchetypeParams = {
  name: "filament",
  kind: "filament",
  countScale: 18,
  radiusFrac: [0.9, 1.4],
  thickness: 150,
  sharpness: 0.9,
  radius: { kind: "power", min: 25, max: 160, alpha: 2.2 },
  spinRange: [0.08, 0.3],
  mineralWeights: [3, 3, 1, 3, 1, 1],
};

// Flat disc of rocks — a collision plane / debris sheet.
export const sheet: ArchetypeParams = {
  name: "sheet",
  kind: "sheet",
  countScale: 9,
  radiusFrac: [0.7, 1.1],
  thickness: 120,
  sharpness: 0.7,
  radius: { kind: "power", min: 20, max: 140, alpha: 2.6 },
  spinRange: [0.05, 0.2],
  mineralWeights: [3, 2, 2, 4, 1, 0.5],
};

// Fragment of a ring — an arc of rocks, like a broken orbit.
export const ringArc: ArchetypeParams = {
  name: "ring-arc",
  kind: "ring",
  countScale: 14,
  radiusFrac: [0.8, 1.2],
  thickness: 140,
  ringRadiusFrac: 0.8,
  arcFraction: 0.55,
  sharpness: 0.9,
  radius: { kind: "power", min: 30, max: 200, alpha: 2.0 },
  spinRange: [0.1, 0.3],
  mineralWeights: [2, 1, 2, 2, 3, 2],
};

// Sparse drift — widely spaced mid-size loners between structures.
export const drift: ArchetypeParams = {
  name: "drift",
  kind: "drift",
  countScale: 1.1,
  radiusFrac: [0.6, 1.0],
  sharpness: 0.05,
  radius: { kind: "uniform", min: 60, max: 280 },
  spinRange: [0.02, 0.08],
  mineralWeights: [4, 3, 1, 3, 0.5, 0.5],
};

// Dense swarm of small gravel — a hazard/mining field with no anchors.
export const gravelSwarm: ArchetypeParams = {
  name: "gravel-swarm",
  kind: "pocket",
  countScale: 20,
  radiusFrac: [0.4, 0.7],
  sharpness: 0.35,
  radius: { kind: "power", min: 12, max: 60, alpha: 2.8 },
  spinRange: [0.2, 0.5],
  mineralWeights: [4, 2, 2, 4, 0.5, 0.5],
};

// A few colossal landmark rocks, slow and far apart.
export const cathedral: ArchetypeParams = {
  name: "cathedral",
  kind: "pocket",
  countScale: 0.5,
  radiusFrac: [0.25, 0.4],
  sharpness: 0.8,
  radius: { kind: "uniform", min: 380, max: 700 },
  spinRange: [0.005, 0.03],
  mineralWeights: [2, 1, 2, 2, 3, 3],
};

export const ARCHETYPES: Record<string, ArchetypeParams> = {
  pocket,
  filament,
  sheet,
  "ring-arc": ringArc,
  drift,
  "gravel-swarm": gravelSwarm,
  cathedral,
};

// ---------------------------------------------------------------------------
// Field presets
// ---------------------------------------------------------------------------

// Exact reproduction of the pre-factory uniform jittered scatter (A/B baseline).
export const legacyUniform: FieldPreset = {
  name: "legacy-uniform",
  legacy: true,
  macro: { wavelength: 20000, octaves: 1, voidThreshold: 0, gamma: 1, floor: 1 },
  clusterCells: 3,
  archetypes: [],
  baseDensity: 1,
  maxRocksPerCell: 1,
};

// Single-archetype debug presets: one archetype at full weight, no macro
// shaping, so a contact sheet shows the archetype's pure character.
function soloPreset(params: ArchetypeParams, weight = 0.08): FieldPreset {
  return {
    name: `solo-${params.name}`,
    macro: { wavelength: 22000, octaves: 1, voidThreshold: 0, gamma: 1, floor: 1 },
    clusterCells: 3,
    archetypes: [{ params, weight }],
    baseDensity: 0.02,
    maxRocksPerCell: 8,
  };
}

export const soloPocket = soloPreset(pocket);
export const soloFilament = soloPreset(filament);
export const soloSheet = soloPreset(sheet);
export const soloRingArc = soloPreset(ringArc);
export const soloDrift = soloPreset(drift, 0.25);

// First belt composition attempt: macro fBm carves voids and thick bands,
// clusters mix pockets/filaments with occasional sheets and ring arcs.
export const beltV1: FieldPreset = {
  name: "belt-v1",
  macro: { wavelength: 24000, octaves: 2, voidThreshold: 0.45, gamma: 1.8, floor: 0.05 },
  clusterCells: 3,
  archetypes: [
    { params: pocket, weight: 0.16 },
    { params: filament, weight: 0.12 },
    { params: sheet, weight: 0.06 },
    { params: ringArc, weight: 0.05 },
    { params: drift, weight: 0.45 },
  ],
  baseDensity: 0.25,
  maxRocksPerCell: 8,
};

export const soloGravelSwarm = soloPreset(gravelSwarm);
export const soloCathedral = soloPreset(cathedral, 0.15);

// belt-v1 at roughly double density — busier, EVE-style.
export const beltV2: FieldPreset = {
  name: "belt-v2-dense",
  macro: { wavelength: 24000, octaves: 2, voidThreshold: 0.4, gamma: 1.6, floor: 0.06 },
  clusterCells: 3,
  archetypes: [
    { params: pocket, weight: 0.24 },
    { params: filament, weight: 0.18 },
    { params: sheet, weight: 0.09 },
    { params: ringArc, weight: 0.07 },
    { params: drift, weight: 0.42 },
  ],
  baseDensity: 0.5,
  maxRocksPerCell: 8,
};

// Planar/orbital-dominant alternative: sheets and arcs lead, strings support.
export const beltV3: FieldPreset = {
  name: "belt-v3-planar",
  macro: { wavelength: 24000, octaves: 2, voidThreshold: 0.45, gamma: 1.8, floor: 0.05 },
  clusterCells: 3,
  archetypes: [
    { params: sheet, weight: 0.14 },
    { params: ringArc, weight: 0.12 },
    { params: filament, weight: 0.06 },
    { params: pocket, weight: 0.06 },
    { params: cathedral, weight: 0.03 },
    { params: drift, weight: 0.35 },
  ],
  baseDensity: 0.25,
  maxRocksPerCell: 8,
};

// Classic flattened belt: belt-v1's mix confined to a ±14 km disk plane.
export const beltV4: FieldPreset = {
  name: "belt-v4-disk",
  macro: {
    wavelength: 24000,
    octaves: 2,
    voidThreshold: 0.35,
    gamma: 1.5,
    floor: 0.06,
    slab: { halfThickness: 14000, power: 1.4 },
  },
  clusterCells: 3,
  archetypes: [
    { params: pocket, weight: 0.18 },
    { params: filament, weight: 0.14 },
    { params: sheet, weight: 0.05 },
    { params: ringArc, weight: 0.05 },
    { params: cathedral, weight: 0.02 },
    { params: drift, weight: 0.45 },
  ],
  baseDensity: 0.3,
  maxRocksPerCell: 8,
};

// hv-feedback direction (2026-06-09): pockets read as natural gravitational
// clumping; strings/rings/sheets look too authored. A belt of pockets at two
// scales + drift + voids, nothing geometric.
export const beltNatural: FieldPreset = {
  name: "belt-natural",
  macro: { wavelength: 24000, octaves: 2, voidThreshold: 0.4, gamma: 1.6, floor: 0.06 },
  clusterCells: 3,
  archetypes: [
    { params: pocket, weight: 0.22 },
    { params: gravelSwarm, weight: 0.08 },
    { params: cathedral, weight: 0.03 },
    { params: drift, weight: 0.5 },
  ],
  baseDensity: 0.3,
  maxRocksPerCell: 8,
};

export const PRESETS: Record<string, FieldPreset> = {
  "legacy-uniform": legacyUniform,
  "solo-pocket": soloPocket,
  "solo-filament": soloFilament,
  "solo-sheet": soloSheet,
  "solo-ring-arc": soloRingArc,
  "solo-drift": soloDrift,
  "solo-gravel-swarm": soloGravelSwarm,
  "solo-cathedral": soloCathedral,
  "belt-v1": beltV1,
  "belt-v2-dense": beltV2,
  "belt-v3-planar": beltV3,
  "belt-v4-disk": beltV4,
  "belt-natural": beltNatural,
};
