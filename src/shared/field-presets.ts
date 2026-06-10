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
  countScale: 0.5,
  radiusFrac: [0.5, 0.8],
  sharpness: 0.05,
  radius: { kind: "uniform", min: 60, max: 280 },
  spinRange: [0.02, 0.08],
  mineralWeights: [4, 3, 1, 3, 0.5, 0.5],
};

export const ARCHETYPES: Record<string, ArchetypeParams> = {
  pocket,
  filament,
  sheet,
  "ring-arc": ringArc,
  drift,
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
  macro: { wavelength: 18000, octaves: 2, voidThreshold: 0.38, gamma: 1.6, floor: 0.04 },
  clusterCells: 3,
  archetypes: [
    { params: pocket, weight: 0.1 },
    { params: filament, weight: 0.08 },
    { params: sheet, weight: 0.04 },
    { params: ringArc, weight: 0.03 },
    { params: drift, weight: 0.3 },
  ],
  baseDensity: 0.05,
  maxRocksPerCell: 8,
};

export const PRESETS: Record<string, FieldPreset> = {
  "legacy-uniform": legacyUniform,
  "solo-pocket": soloPocket,
  "solo-filament": soloFilament,
  "solo-sheet": soloSheet,
  "solo-ring-arc": soloRingArc,
  "solo-drift": soloDrift,
  "belt-v1": beltV1,
};
