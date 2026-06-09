// Field-derivation Web Worker. Runs the ~100-300ms nearest-`renderedLimit` virtual-field
// scan/sort OFF the main thread, so a 5 km/s player re-paging cells never blocks a frame
// (item C4). It calls the SAME deriveVirtualField the client/server parity check covers
// (field-core.ts), then packs the result into transferable typed arrays so handing it
// back to the main thread is zero-copy; the main thread only does a ~3ms unpackField.
//
// Imports only field-core + sun-occlusion (pure math) — no DOM, render-stats, or window
// coupling.

import type { FieldSummary, Vector3 } from "../../shared/types";
import { deriveVirtualField, packField, type PackedField } from "./field-core";
import { sunlitForId } from "./sun-occlusion";

export type FieldDeriveRequest = {
  reqId: number;
  key: string;
  position: Vector3;
  field: FieldSummary;
};

export type FieldDeriveResponse = {
  reqId: number;
  key: string;
  packed: PackedField;
  // Per-rock aSunlit (the sun-occlusion march), computed OFF-THREAD alongside the derive —
  // the worker's module cache makes recurring crosses near-free. The main thread primes
  // its cache from this (sun-occlusion.primeSunlitCells), so it never marches 50k cold
  // rocks (~440ms at boot when it did, caught by bench:gpu-cross).
  sunlit: Float64Array;
};

// tsconfig's lib is DOM (not WebWorker), so `self` is typed as Window. Cast to a minimal
// dedicated-worker shape to get the (data, transfer[]) postMessage overload.
type WorkerScope = {
  onmessage: ((event: { data: FieldDeriveRequest }) => void) | null;
  postMessage: (message: FieldDeriveResponse, transfer: Transferable[]) => void;
};

const ctx = self as unknown as WorkerScope;

ctx.onmessage = (event) => {
  const { reqId, key, position, field } = event.data;
  const asteroids = deriveVirtualField(position, field);
  const packed = packField(asteroids);
  const sunlit = new Float64Array(asteroids.length);
  for (let i = 0; i < asteroids.length; i += 1) {
    sunlit[i] = sunlitForId(asteroids[i]!.id);
  }
  ctx.postMessage({ reqId, key, packed, sunlit }, [
    packed.cells.buffer,
    packed.positions.buffer,
    packed.scalars.buffer,
    packed.minerals.buffer,
    sunlit.buffer,
  ]);
};
