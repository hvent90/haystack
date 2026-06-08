import type { Asteroid, FieldSummary, Mineral, Vector3, WorldSnapshot } from "../../shared/types";
import { renderStats } from "./render-stats";

// Client-side reconstruction of the deterministic virtual asteroid field.
//
// The server no longer streams the (up to 100k) static virtual rocks every cell
// crossing — it sends only the small mutable seeded set. The field is a pure function of
// the seed + the ship's cell, so the client regenerates it locally here, exactly
// mirroring src/server/field.ts's generator. This removes the per-crossing O(field)
// server scan and the multi-MB field re-send from the broadcast path entirely.
//
// Constants the server bakes in (and which the `field` snapshot descriptor does not
// carry) are hardcoded to match field.ts. Math.sin is not bit-portable across JS
// engines, but nothing compares these client-derived rocks against the server — the
// client is now the sole source of virtual rocks, and scan hits carry their own
// server-computed bearing/distance — so any engine ULP difference is purely cosmetic
// (sub-nanometre) and never a correctness issue.

const MINERALS: Mineral[] = ["nickel", "waterIce", "cobalt", "silicates", "platinum", "xenotime"];

function hashCell(seed: number, x: number, y: number, z: number): number {
  return seed + x * 73856093 + y * 19349663 + z * 83492791;
}

function noise(seed: number): number {
  const value = Math.sin(seed * 12.9898) * 43758.5453;
  return value - Math.floor(value);
}

function pocketForCell(cellX: number): string {
  if (cellX < 33) {
    return "inner-drift";
  }
  if (cellX < 66) {
    return "black-thread";
  }
  return "long-echo";
}

type FieldGeometry = {
  seed: number;
  cellSize: number;
  cellsPerAxis: number;
  originOffset: number;
  limit: number;
};

function geometryOf(field: FieldSummary): FieldGeometry {
  const cellsPerAxis = Math.max(1, Math.round(Math.cbrt(field.totalAsteroids)));
  return {
    seed: field.seed,
    cellSize: field.cellSize,
    cellsPerAxis,
    originOffset: -(cellsPerAxis * field.cellSize) / 2,
    limit: Math.max(1, field.renderedLimit),
  };
}

function clampCell(value: number, cellsPerAxis: number): number {
  return Math.max(0, Math.min(cellsPerAxis - 1, value));
}

function virtualAsteroidAt(geo: FieldGeometry, cx: number, cy: number, cz: number): Asteroid {
  const seed = hashCell(geo.seed, cx, cy, cz);
  return {
    id: `v-${cx}-${cy}-${cz}`,
    pocket: pocketForCell(cx),
    position: {
      x: geo.originOffset + cx * geo.cellSize + noise(seed + 1) * geo.cellSize,
      y: geo.originOffset + cy * geo.cellSize + noise(seed + 2) * geo.cellSize,
      z: geo.originOffset + cz * geo.cellSize + noise(seed + 3) * geo.cellSize,
    },
    radius: 45 + noise(seed + 5) * 310,
    signature: 0.08 + noise(seed + 6) * 0.7,
    mineralRichness: 0.18 + noise(seed + 7) * 0.82,
    rareMineral:
      MINERALS[Math.floor(noise(seed + 4) * MINERALS.length) % MINERALS.length] ?? "nickel",
    discovered: true,
  };
}

// The nearest `renderedLimit` virtual rocks to the ship's CELL CENTER, sorted nearest
// first (matching the server's old streamedFieldAsteroids). Snapping the query to the
// cell center makes the result a pure function of the cell, so it only changes when the
// ship crosses a cell boundary — not as it drifts within a cell.
//
// A cube of cells grown around the ship is scanned until it provably contains the global
// nearest `renderedLimit` (the limit-th rock is closer than any unscanned cell) or spans
// the whole field. This is O(rendered) rather than the server's old O(field) full scan.
export function deriveVirtualField(position: Vector3, field: FieldSummary): Asteroid[] {
  const geo = geometryOf(field);
  const last = geo.cellsPerAxis - 1;
  const cx = clampCell(
    Math.floor((position.x - geo.originOffset) / geo.cellSize),
    geo.cellsPerAxis,
  );
  const cy = clampCell(
    Math.floor((position.y - geo.originOffset) / geo.cellSize),
    geo.cellsPerAxis,
  );
  const cz = clampCell(
    Math.floor((position.z - geo.originOffset) / geo.cellSize),
    geo.cellsPerAxis,
  );
  const ox = geo.originOffset + cx * geo.cellSize + geo.cellSize / 2;
  const oy = geo.originOffset + cy * geo.cellSize + geo.cellSize / 2;
  const oz = geo.originOffset + cz * geo.cellSize + geo.cellSize / 2;

  let half = Math.max(1, Math.ceil(Math.cbrt(geo.limit) / 2));
  let candidates: Array<{ asteroid: Asteroid; d2: number }> = [];
  for (;;) {
    const minX = Math.max(0, cx - half);
    const maxX = Math.min(last, cx + half);
    const minY = Math.max(0, cy - half);
    const maxY = Math.min(last, cy + half);
    const minZ = Math.max(0, cz - half);
    const maxZ = Math.min(last, cz + half);
    candidates = [];
    for (let x = minX; x <= maxX; x += 1) {
      for (let y = minY; y <= maxY; y += 1) {
        for (let z = minZ; z <= maxZ; z += 1) {
          const asteroid = virtualAsteroidAt(geo, x, y, z);
          const dx = asteroid.position.x - ox;
          const dy = asteroid.position.y - oy;
          const dz = asteroid.position.z - oz;
          candidates.push({ asteroid, d2: dx * dx + dy * dy + dz * dz });
        }
      }
    }
    const spansField =
      minX === 0 && maxX === last && minY === 0 && maxY === last && minZ === 0 && maxZ === last;
    if (candidates.length >= geo.limit) {
      candidates.sort((a, b) => a.d2 - b.d2);
      // The nearest unscanned cell sits one layer beyond the cube; its closest possible
      // rock is (half + 0.5) cells away. If the limit-th rock is nearer than that, the
      // cube already holds the true global nearest set.
      const safe = (half + 0.5) * geo.cellSize;
      const limitRock = candidates[geo.limit - 1];
      if (spansField || (limitRock !== undefined && Math.sqrt(limitRock.d2) <= safe)) {
        break;
      }
    } else if (spansField) {
      candidates.sort((a, b) => a.d2 - b.d2);
      break;
    }
    half += Math.max(2, Math.ceil(half * 0.5));
  }

  const count = Math.min(candidates.length, geo.limit);
  const result: Asteroid[] = new Array(count);
  for (let i = 0; i < count; i += 1) {
    result[i] = candidates[i]!.asteroid;
  }
  return result;
}

function sameSeededSet(
  a: ReadonlyArray<{ id: string; discovered: boolean }>,
  b: ReadonlyArray<{ id: string; discovered: boolean }>,
): boolean {
  if (a === b) {
    return true;
  }
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    if (x === undefined || y === undefined || x.id !== y.id || x.discovered !== y.discovered) {
      return false;
    }
  }
  return true;
}

// Merges the streamed seeded asteroids with the locally derived virtual field, keeping
// the merged `asteroids` array REFERENCE-STABLE while the ship stays in its cell and the
// seeded set is unchanged. Downstream identity memos (notably the instanced-field matrix
// rebuild) therefore only fire on a real visible-set change (a cell crossing or a seeded
// discovery flip), exactly as they did when the field was streamed.
export class FieldDeriver {
  private seeded: Asteroid[] = [];
  private cellKey: string | null = null;
  private virtual: Asteroid[] = [];
  private merged: Asteroid[] = [];
  private mergedSeededRef: Asteroid[] | null = null;

  // Record the latest streamed seeded set. Reuses the prior reference when the
  // render-relevant content (id + discovered) is identical so a 4s HTTP re-poll that
  // brings a fresh-but-equal array doesn't force a rebuild.
  setSeeded(seeded: Asteroid[]): void {
    if (this.seeded !== seeded && sameSeededSet(this.seeded, seeded)) {
      return;
    }
    this.seeded = seeded;
  }

  private rebuildMerged(): void {
    this.merged = this.seeded.length === 0 ? this.virtual : [...this.seeded, ...this.virtual];
    this.mergedSeededRef = this.seeded;
  }

  asteroidsFor(position: Vector3 | null, field: FieldSummary): Asteroid[] {
    if (position === null) {
      if (this.cellKey !== "none" || this.mergedSeededRef !== this.seeded) {
        this.cellKey = "none";
        this.virtual = [];
        this.rebuildMerged();
      }
      return this.merged;
    }
    const geo = geometryOf(field);
    const cx = clampCell(
      Math.floor((position.x - geo.originOffset) / geo.cellSize),
      geo.cellsPerAxis,
    );
    const cy = clampCell(
      Math.floor((position.y - geo.originOffset) / geo.cellSize),
      geo.cellsPerAxis,
    );
    const cz = clampCell(
      Math.floor((position.z - geo.originOffset) / geo.cellSize),
      geo.cellsPerAxis,
    );
    const key = `${cx}-${cy}-${cz}-${field.renderedLimit}-${field.seed}-${field.cellSize}`;
    const cellChanged = key !== this.cellKey;
    if (cellChanged) {
      const start = performance.now();
      this.virtual = deriveVirtualField(position, field);
      this.cellKey = key;
      if (cellChanged || this.mergedSeededRef !== this.seeded) {
        this.rebuildMerged();
      }
      renderStats.recordDerive(performance.now() - start, this.merged.length);
      return this.merged;
    }
    if (this.mergedSeededRef !== this.seeded) {
      this.rebuildMerged();
    }
    renderStats.setDerivedCount(this.merged.length);
    return this.merged;
  }
}

// Replaces a snapshot's seeded-only `asteroids` with the seeded set merged with the
// locally derived virtual field. The seeded set must already have been handed to the
// deriver via setSeeded (only when the wire actually delivered it) so this never mistakes
// a previously-merged array for the seeded set.
export function withDerivedField(
  snapshot: WorldSnapshot,
  deriver: FieldDeriver,
  pilotId: string,
): WorldSnapshot {
  const ship = snapshot.ships.find((candidate) => candidate.pilotId === pilotId) ?? null;
  const asteroids = deriver.asteroidsFor(ship?.position ?? null, snapshot.field);
  if (asteroids === snapshot.asteroids) {
    return snapshot;
  }
  return { ...snapshot, asteroids };
}
