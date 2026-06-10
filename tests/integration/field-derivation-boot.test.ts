// The FIRST field derive must go through the worker like every later cross (when Worker is
// available) instead of running the ~160ms nearest-renderedLimit scan/sort synchronously on
// the main thread. Found by the gpu-live gate: the boot derive was the single biggest
// main-thread stall in the whole live loop (fieldDeriveMs ≈ 158-166ms blocking first paint)
// — every RECURRING cross already used the worker; only boot took the synchronous path.
// The synchronous path must remain as the no-Worker fallback.

import { afterEach, describe, expect, test } from "bun:test";
import type { Vector3 } from "../../src/shared/types";
import { FieldDeriver } from "../../src/client/eve/field-derivation";
import { deriveVirtualField, packField } from "../../src/client/eve/field-core";
import type { FieldDeriveRequest, FieldDeriveResponse } from "../../src/client/eve/field-worker";

const FIELD = {
  totalAsteroids: 1_000_000,
  seed: 424242,
  cellSize: 1130,
  indexKind: "cubicCellHierarchy" as const,
  renderedLimit: 200,
};

const POSITION: Vector3 = { x: 10, y: 20, z: 30 };

// Captures construction + postMessage; lets the test deliver a worker response manually.
class FakeWorker {
  static instances: FakeWorker[] = [];
  requests: FieldDeriveRequest[] = [];
  onmessage: ((event: { data: FieldDeriveResponse }) => void) | null = null;
  constructor() {
    FakeWorker.instances.push(this);
  }
  postMessage(request: FieldDeriveRequest): void {
    this.requests.push(request);
  }
  terminate(): void {}
  respondTo(request: FieldDeriveRequest): void {
    const packed = packField(deriveVirtualField(request.position, request.field));
    const sunlit = new Float64Array(packed.count).fill(1);
    this.onmessage?.({ data: { reqId: request.reqId, key: request.key, packed, sunlit } });
  }
}

const realWorker = globalThis.Worker;
afterEach(() => {
  (globalThis as { Worker?: unknown }).Worker = realWorker;
  FakeWorker.instances = [];
});

describe("FieldDeriver boot derive", () => {
  test("first derive is offloaded to the worker; main thread returns seeded-only immediately", () => {
    (globalThis as { Worker?: unknown }).Worker = FakeWorker;
    const deriver = new FieldDeriver();
    let updates = 0;
    deriver.setUpdateListener(() => {
      updates += 1;
    });

    const immediate = deriver.asteroidsFor(POSITION, FIELD);
    // No synchronous derive: nothing to show yet beyond the (empty) seeded set.
    expect(immediate.length).toBe(0);
    expect(FakeWorker.instances.length).toBe(1);
    const worker = FakeWorker.instances[0]!;
    expect(worker.requests.length).toBe(1);

    // Worker returns -> the derived field arrives and the update listener fires.
    worker.respondTo(worker.requests[0]!);
    expect(updates).toBe(1);
    const derived = deriver.asteroidsFor(POSITION, FIELD);
    expect(derived.length).toBe(deriveVirtualField(POSITION, FIELD).length);
    deriver.dispose();
  });

  test("without Worker support the first derive stays synchronous", () => {
    delete (globalThis as { Worker?: unknown }).Worker;
    const deriver = new FieldDeriver();
    const immediate = deriver.asteroidsFor(POSITION, FIELD);
    expect(immediate.length).toBe(deriveVirtualField(POSITION, FIELD).length);
    deriver.dispose();
  });
});
