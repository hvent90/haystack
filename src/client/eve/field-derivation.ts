import type { Asteroid, FieldSummary, Vector3, WorldSnapshot } from "../../shared/types";
import { renderStats } from "./render-stats";
import { cellCoords, deriveVirtualField, indexByCell, unpackField } from "./field-core";
import type { FieldDeriveRequest, FieldDeriveResponse } from "./field-worker";

// Client-side reconstruction of the deterministic virtual asteroid field. The field math
// itself lives in field-core.ts (shared with the derivation Web Worker); this module owns
// the stateful, reference-stable merge of the streamed seeded set with the derived virtual
// field, and offloads the heavy per-cross derive to the worker so it never blocks a frame.
//
// Re-exported so scripts/bench/parity-check.ts (and any other client-side caller) keep
// importing deriveVirtualField from here.
export { deriveVirtualField } from "./field-core";

function cellKeyFor(position: Vector3, field: FieldSummary): string {
  const { cx, cy, cz } = cellCoords(position, field);
  return `${cx}-${cy}-${cz}-${field.renderedLimit}-${field.seed}-${field.cellSize}`;
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
//
// The heavy nearest-`renderedLimit` derive (~100-300ms at 100k) is run in a Web Worker
// (field-worker.ts). On a cell crossing asteroidsFor returns the PREVIOUS (stale-by-≤1-
// cell) merged field immediately and posts the new cell to the worker; when the worker
// returns, the field is rebuilt from transferable typed arrays (~3ms) and the registered
// update listener re-renders. So the field updates a few frames late instead of blocking
// the main thread — and never blinks, because the old field stays on screen meanwhile.
// The very first derive (no prior field) and any environment without Worker fall back to a
// synchronous derive, preserving the original behaviour exactly.
export class FieldDeriver {
  private seeded: Asteroid[] = [];
  private cellKey: string | null = null;
  private virtual: Asteroid[] = [];
  private merged: Asteroid[] = [];
  private mergedSeededRef: Asteroid[] | null = null;

  private worker: Worker | null = null;
  private workerTried = false;
  private reqId = 0;
  private acceptedReqId = -1;
  // At most ONE derive in flight. A 5 km/s player can cross cells faster than the worker
  // derives; rather than queue a request (and a wasted ~5ms reconstruct) per crossed cell,
  // we keep showing the stale field and, when the in-flight derive returns, immediately
  // request the ship's CURRENT cell. So work is bounded to ~one reconstruct per round-trip
  // regardless of crossing rate, and the field always chases the latest position.
  private inFlight = false;
  // Previous cross's cellKey -> Asteroid, so a new derive reuses the unchanged objects
  // (95%+ on a 1-cell cross) instead of re-allocating the whole 100k set each crossing.
  private virtualByCell: Map<number, Asteroid> | null = null;
  private updateListener: (() => void) | null = null;

  // Registered by the app so a worker-delivered field triggers a re-render. Cleared on
  // teardown.
  setUpdateListener(listener: (() => void) | null): void {
    this.updateListener = listener;
  }

  dispose(): void {
    if (this.worker !== null) {
      this.worker.terminate();
      this.worker = null;
    }
    this.updateListener = null;
  }

  // True while a worker derive is outstanding. Used by the benchmark drift control to pace
  // synthetic flight to the derive rate (one cell per completed crossing).
  isBusy(): boolean {
    return this.inFlight;
  }

  // Record the latest streamed seeded set. Reuses the prior reference when the
  // render-relevant content (id + discovered) is identical so a 4s HTTP re-poll that
  // brings a fresh-but-equal array doesn't force a rebuild.
  setSeeded(seeded: Asteroid[]): void {
    if (this.seeded !== seeded && sameSeededSet(this.seeded, seeded)) {
      return;
    }
    this.seeded = seeded;
  }

  private ensureWorker(): Worker | null {
    if (this.worker !== null) {
      return this.worker;
    }
    if (this.workerTried) {
      return null;
    }
    this.workerTried = true;
    if (typeof Worker === "undefined") {
      return null;
    }
    try {
      const worker = new Worker(new URL("./field-worker.ts", import.meta.url), { type: "module" });
      worker.onmessage = (event: MessageEvent<FieldDeriveResponse>) => {
        this.handleWorkerResult(event.data);
      };
      this.worker = worker;
      return worker;
    } catch {
      return null;
    }
  }

  private rebuildMerged(): void {
    this.merged = this.seeded.length === 0 ? this.virtual : [...this.seeded, ...this.virtual];
    this.mergedSeededRef = this.seeded;
  }

  private handleWorkerResult(response: FieldDeriveResponse): void {
    // Out-of-order / superseded result (the worker is FIFO, so this is just a guard).
    if (response.reqId <= this.acceptedReqId) {
      return;
    }
    this.acceptedReqId = response.reqId;
    this.inFlight = false;
    const start = performance.now();
    const unpacked = unpackField(response.packed, this.virtualByCell);
    this.virtual = unpacked.asteroids;
    this.virtualByCell = unpacked.byCell;
    this.cellKey = response.key;
    this.rebuildMerged();
    // The reconstruct is the ONLY main-thread cost of the derive now (the scan/sort ran in
    // the worker); record it as the cell-cross field work so the benchmark sees the real
    // per-frame main-thread stall.
    renderStats.recordDerive(performance.now() - start, this.merged.length);
    this.updateListener?.();
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
    const key = cellKeyFor(position, field);
    if (key === this.cellKey) {
      if (this.mergedSeededRef !== this.seeded) {
        this.rebuildMerged();
      }
      renderStats.setDerivedCount(this.merged.length);
      return this.merged;
    }

    // Cell changed. With no prior field (first paint) or no Worker support, derive
    // synchronously — there is nothing to show otherwise. Otherwise offload to the worker
    // and keep showing the previous (stale-by-≤1-cell) field until it returns.
    const worker = this.virtual.length === 0 ? null : this.ensureWorker();
    if (worker === null) {
      const start = performance.now();
      this.virtual = deriveVirtualField(position, field);
      // Seed the reuse index so the first subsequent worker cross reuses these objects.
      this.virtualByCell = indexByCell(this.virtual);
      this.cellKey = key;
      this.rebuildMerged();
      renderStats.recordDerive(performance.now() - start, this.merged.length);
      return this.merged;
    }

    if (!this.inFlight) {
      this.reqId += 1;
      this.inFlight = true;
      const request: FieldDeriveRequest = { reqId: this.reqId, key, position, field };
      worker.postMessage(request);
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
