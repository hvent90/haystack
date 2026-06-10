import type { FieldSummary } from "../../shared/types";
import { decodeBeltBake } from "../../shared/belt/format";
import { beltReady, setActiveBeltBake } from "./field-core";

// Fetch + register the belt bake artifacts for the field the server published.
// Runs on the main thread AND inside the field worker (fetch + DecompressionStream are
// available in both); each realm registers its own copy of the same committed bytes
// (public/belt/<preset>/), so every derive in every realm reads identical data.

async function fetchBytes(url: string, gzipped: boolean): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok || res.body === null) {
    throw new Error(`belt bake fetch failed: ${url} -> ${res.status}`);
  }
  if (!gzipped) {
    return new Uint8Array(await res.arrayBuffer());
  }
  const stream = res.body.pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
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
      fetchBytes(`${base}/density.bin.gz`, true),
      fetchBytes(`${base}/heroes.bin.gz`, true),
      fetchBytes(`${base}/zones.bin.gz`, true),
      fetchBytes(`${base}/flow.bin.gz`, true),
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
