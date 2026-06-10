import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

import {
  BELT_WORLD_SCALE,
  type BeltBake,
  type BeltBakeMeta,
  beltVerticalSquash,
  decodeBeltBake,
} from "../shared/belt/format";

// Server-side belt bake loading: read the committed artifacts from public/belt/<preset>/
// (the SAME files vite serves to the client) and decode them with the shared decoder.
// Sync on purpose — this runs once at module init, before the first tick.

const PUBLIC_BELT_DIR = join(import.meta.dir, "..", "..", "public", "belt");

export function beltPresetName(): string {
  // `saturn` is the shipped belt (hv-approved promotion): Saturn-scale rings at
  // worldScale 7.45e7. The pre-Saturn 1M bake stays available as HAYSTACK_BELT_PRESET=
  // default, alongside shepherd-moat.
  return process.env["HAYSTACK_BELT_PRESET"] ?? "saturn";
}

export function beltDensityScale(): number {
  const raw = Number(process.env["HAYSTACK_BELT_DENSITY"] ?? "1");
  return Number.isFinite(raw) && raw > 0 ? raw : 1;
}

// "belt" (default) derives structure from the bake; "hash" keeps the legacy seeded-hash
// field — retained as the pure-noise baseline for comparison captures and as a fallback.
export function fieldMode(): "belt" | "hash" {
  return process.env["HAYSTACK_FIELD"] === "hash" ? "hash" : "belt";
}

// The active bake's world scale, from the meta alone (cheap: no binary decode). Presets
// without a world block (default, shepherd-moat) keep the legacy BELT_WORLD_SCALE.
export function beltWorldScaleSync(): number {
  if (fieldMode() !== "belt") {
    return BELT_WORLD_SCALE;
  }
  try {
    const raw = readFileSync(join(PUBLIC_BELT_DIR, beltPresetName(), "belt-meta.json"), "utf8");
    const meta = JSON.parse(raw) as { world?: { worldScale?: number } };
    return meta.world?.worldScale ?? BELT_WORLD_SCALE;
  } catch {
    return BELT_WORLD_SCALE;
  }
}

// How much the seeded world layout (station, relay, pockets — authored against the
// legacy worldScale 1e6) stretches IN-PLANE for the active bake. Vertical (y) offsets
// are NOT scaled: belt thickness follows the bake's inc_sigma/zMax, not worldScale.
export function beltLayoutScale(): number {
  return beltWorldScaleSync() / BELT_WORLD_SCALE;
}

// Vertical-slab toggle (the ED-ring squash, shared/belt/format.ts beltVerticalSquash):
//   unset                -> ED slab (BELT_SLAB_HALF_METERS, ~±4.1 km)
//   HAYSTACK_BELT_SLAB=native (or off/0) -> the bake's true vertical structure (squash 1
//                            — e.g. main's saturn rings at their full ±447 km)
//   HAYSTACK_BELT_SLAB=<meters> -> that slab half-thickness
// The resolved squash is published in FieldSummary.belt.squash, so the client always
// decodes with the server's value and parity holds for every setting.
function resolveSquash(metaJson: string): number | undefined {
  const raw = process.env["HAYSTACK_BELT_SLAB"];
  if (raw === undefined || raw === "") {
    return undefined; // decode default: the ED slab target
  }
  if (raw === "native" || raw === "off" || raw === "0") {
    return 1;
  }
  const meters = Number(raw);
  if (!Number.isFinite(meters) || meters <= 0) {
    return undefined;
  }
  const meta = JSON.parse(metaJson) as BeltBakeMeta;
  const worldScale = meta.world?.worldScale ?? BELT_WORLD_SCALE;
  return beltVerticalSquash(meta, worldScale, meters);
}

export function loadBeltBakeSync(preset: string, cellSize: number): BeltBake | null {
  const dir = join(PUBLIC_BELT_DIR, preset);
  if (!existsSync(join(dir, "belt-meta.json"))) {
    return null;
  }
  const read = (name: string): Uint8Array => {
    const raw = readFileSync(join(dir, name));
    return name.endsWith(".gz") ? new Uint8Array(gunzipSync(raw)) : new Uint8Array(raw);
  };
  const metaJson = readFileSync(join(dir, "belt-meta.json"), "utf8");
  return decodeBeltBake(
    {
      metaJson,
      density: read("density.bin.gz"),
      heroes: read("heroes.bin.gz"),
      zones: read("zones.bin.gz"),
      flow: read("flow.bin.gz"),
    },
    cellSize,
    undefined,
    resolveSquash(metaJson),
  );
}
