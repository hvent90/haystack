import type { FieldSummary } from "../../shared/types";
import {
  type BeltBakeMeta,
  BELT_P_MAX,
  BELT_WORLD_SCALE,
  beltGridGeometry,
  decodeBeltBake,
} from "../../shared/belt/format";
import { beltReady, setActiveBeltBake } from "./field-core";

// Fetch + register the belt bake artifacts for the field the server published.
// Runs on the main thread AND inside the field worker (fetch + DecompressionStream are
// available in both); each realm registers its own copy of the same committed bytes
// (public/belt/<preset>/), so every derive in every realm reads identical data.

async function fetchBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok || res.body === null) {
    throw new Error(`belt bake fetch failed: ${url} -> ${res.status}`);
  }
  const raw = new Uint8Array(await res.arrayBuffer());
  // Servers differ on .gz handling: vite (and CDNs) mark them Content-Encoding: gzip and
  // the browser transport-decodes the body; a plain static server hands back the gzip
  // bytes. Decompress only when the bytes still carry the gzip magic.
  const transportDecoded = res.headers.get("content-encoding")?.includes("gzip") ?? false;
  if (transportDecoded || raw.length < 2 || raw[0] !== 0x1f || raw[1] !== 0x8b) {
    return raw;
  }
  const stream = new Blob([raw as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Build a belt FieldSummary CLIENT-SIDE from the served artifacts alone — for harnesses
// (gpu-verify) that run against vite without a game server. The real app always uses the
// server-published summary instead.
export async function beltSummaryFromArtifacts(
  preset: string,
  cellSize: number,
  renderedLimit: number,
  seed = 424_242,
): Promise<FieldSummary> {
  const res = await fetch(`/belt/${preset}/belt-meta.json`);
  if (!res.ok) {
    throw new Error(`belt meta fetch failed: ${res.status}`);
  }
  const meta = (await res.json()) as BeltBakeMeta;
  const geo = beltGridGeometry(meta, BELT_WORLD_SCALE, cellSize);
  return {
    totalAsteroids: 0,
    seed,
    cellSize,
    indexKind: "beltBakeV1",
    renderedLimit,
    belt: {
      preset,
      formatVersion: meta.formatVersion,
      worldScale: BELT_WORLD_SCALE,
      pMax: BELT_P_MAX,
      densityScale: 1,
      cellsXZ: geo.cellsXZ,
      cellsY: geo.cellsY,
    },
  };
}

let loadingFor: string | null = null;
let loading: Promise<void> | null = null;

// Idempotent: concurrent/repeat calls for the same preset share one fetch. Resolves once
// the bake is registered with field-core (beltReady(field) flips true).
export function ensureBeltBake(field: FieldSummary): Promise<void> {
  const belt = field.belt;
  if (belt === undefined || beltReady(field)) {
    return Promise.resolve();
  }
  if (loading !== null && loadingFor === belt.preset) {
    return loading;
  }
  loadingFor = belt.preset;
  loading = (async () => {
    const base = `/belt/${belt.preset}`;
    const [metaJson, density, heroes, zones, flow] = await Promise.all([
      fetch(`${base}/belt-meta.json`).then((r) => {
        if (!r.ok) throw new Error(`belt bake fetch failed: ${base}/belt-meta.json -> ${r.status}`);
        return r.text();
      }),
      fetchBytes(`${base}/density.bin.gz`),
      fetchBytes(`${base}/heroes.bin.gz`),
      fetchBytes(`${base}/zones.bin.gz`),
      fetchBytes(`${base}/flow.bin.gz`),
    ]);
    const bake = decodeBeltBake(
      { metaJson, density, heroes, zones, flow },
      field.cellSize,
      belt.worldScale,
    );
    setActiveBeltBake(bake, field);
  })();
  loading.catch(() => {
    // Allow a retry on the next ensure call instead of caching the rejection forever.
    loading = null;
    loadingFor = null;
  });
  return loading;
}
