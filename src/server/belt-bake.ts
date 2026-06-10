import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

import { BELT_WORLD_SCALE, type BeltBake, decodeBeltBake } from "../shared/belt/format";

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

export function loadBeltBakeSync(preset: string, cellSize: number): BeltBake | null {
  const dir = join(PUBLIC_BELT_DIR, preset);
  if (!existsSync(join(dir, "belt-meta.json"))) {
    return null;
  }
  const read = (name: string): Uint8Array => {
    const raw = readFileSync(join(dir, name));
    return name.endsWith(".gz") ? new Uint8Array(gunzipSync(raw)) : new Uint8Array(raw);
  };
  return decodeBeltBake(
    {
      metaJson: readFileSync(join(dir, "belt-meta.json"), "utf8"),
      density: read("density.bin.gz"),
      heroes: read("heroes.bin.gz"),
      zones: read("zones.bin.gz"),
      flow: read("flow.bin.gz"),
    },
    cellSize,
  );
}
