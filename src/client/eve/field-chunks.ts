import type { Asteroid } from "../../shared/types";

// Pure spatial-chunk partitioning for the asteroid field — no three.js / React deps, so it
// can be exercised both by the renderer (WorldView) and by the in-process per-cross
// micro-bench (scripts/bench/client-render.ts). Partitioning the derived field into
// individually-cullable cubic chunks is the per-cross main-thread work that item C4 bounds.

// Spatial chunk edge length (meters). The derived field is partitioned into cubic chunks,
// each rendered as its own InstancedMesh with its own bounding sphere so three frustum-culls
// them INDIVIDUALLY (vs. the old single mesh + single bounding sphere, all-or-nothing).
// ~7.5 km balances cull tightness against a small, bounded visible-chunk (draw-call) count.
export const CHUNK_METERS = 7500;

export type AsteroidChunkData = {
  key: string;
  cx: number;
  cy: number;
  cz: number;
  asteroids: Asteroid[];
  // Lazily-built id set, used by reconcileChunks for an exact, ORDER-INDEPENDENT match
  // against the next cross's partition (the derive re-sorts rocks by distance to the new
  // cell center every cross, so per-chunk order changes even when the membership doesn't).
  idSet?: Set<string>;
};

// Numeric chunk key: chunk coords span ~[-8, 7] (a ±56.5 km field in 7.5 km cubes), so
// offset into the non-negative range and pack into one integer. Avoids allocating a
// `${cx}|${cy}|${cz}` string per rock (100k string allocations were ~half the partition
// cost on a cell cross); the human-readable string key is built once per chunk instead.
const CHUNK_KEY_OFFSET = 1024;
const CHUNK_KEY_BASE = 4096;
function chunkKeyOf(cx: number, cy: number, cz: number): number {
  return (
    ((cx + CHUNK_KEY_OFFSET) * CHUNK_KEY_BASE + (cy + CHUNK_KEY_OFFSET)) * CHUNK_KEY_BASE +
    (cz + CHUNK_KEY_OFFSET)
  );
}

// Bucket the derived rocks into cubic spatial chunks, preserving per-chunk order. Each
// bucket becomes one frustum- and distance-cullable InstancedMesh. O(N) over the derived
// set. The integer chunk coords give each chunk a cheap, exact cube center for the distance
// test without scanning its rocks.
export function partitionIntoChunks(asteroids: Asteroid[]): Map<number, AsteroidChunkData> {
  const byKey = new Map<number, AsteroidChunkData>();
  for (const asteroid of asteroids) {
    const cx = Math.floor(asteroid.position.x / CHUNK_METERS);
    const cy = Math.floor(asteroid.position.y / CHUNK_METERS);
    const cz = Math.floor(asteroid.position.z / CHUNK_METERS);
    const numericKey = chunkKeyOf(cx, cy, cz);
    let bucket = byKey.get(numericKey);
    if (bucket === undefined) {
      bucket = { key: `${cx}|${cy}|${cz}`, cx, cy, cz, asteroids: [] };
      byKey.set(numericKey, bucket);
    }
    bucket.asteroids.push(asteroid);
  }
  return byKey;
}

// Does `prior` hold exactly the same rock ids as `fresh` (order-independent)? The field is
// deterministic and instance matrices bake ABSOLUTE positions, so a chunk whose id SET is
// unchanged needs no matrix rebuild — even though the derive re-sorts the rocks by distance
// to the new cell center every cross (so their order within the chunk differs). The prior
// chunk's id set is built once and cached, so a chunk that survives many crosses is only
// hashed once.
export function sameChunkRocks(prior: AsteroidChunkData, fresh: Asteroid[]): boolean {
  if (prior.asteroids === fresh) {
    return true;
  }
  if (prior.asteroids.length !== fresh.length) {
    return false;
  }
  let set = prior.idSet;
  if (set === undefined) {
    set = new Set<string>();
    for (const asteroid of prior.asteroids) {
      set.add(asteroid.id);
    }
    prior.idSet = set;
  }
  for (const asteroid of fresh) {
    if (!set.has(asteroid.id)) {
      return false;
    }
  }
  return true;
}

// Incrementally reconcile a freshly partitioned field against the previous chunk set: for
// every chunk whose rock SET is unchanged, REUSE the previous chunk object (and thus its
// stable `asteroids` array reference) so its AsteroidChunk's build layout-effect — keyed on
// that reference — does NOT re-fire. Only boundary chunks that gained/lost rocks on the
// cell cross rebuild their instance matrices. This turns the old full 100k rebuild-per-
// cross into a rebuild of just the few changed chunks. O(N) to partition + compare.
export function reconcileChunks(
  previous: Map<number, AsteroidChunkData>,
  asteroids: Asteroid[],
): Map<number, AsteroidChunkData> {
  const fresh = partitionIntoChunks(asteroids);
  const reconciled = new Map<number, AsteroidChunkData>();
  for (const [key, chunk] of fresh) {
    const prior = previous.get(key);
    reconciled.set(
      key,
      prior !== undefined && sameChunkRocks(prior, chunk.asteroids) ? prior : chunk,
    );
  }
  return reconciled;
}
