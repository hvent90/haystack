import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { assertWebGPU, hasWebGPU } from "../../src/client/eve/gpu/capability";

// docs/gpu-asteroids-architecture.md §8.2 / §5 — the WebGPU capability gate.
//
// Pure deterministic unit test: we mock `globalThis.navigator.gpu` (NO real GPU device) to
// drive every branch of the detection. This validates the actually-load-bearing logic; the
// real-browser detection result is GPU-UNVERIFIED (this env has no navigator.gpu).

type AdapterResult = unknown | null;

const UNSUPPORTED_MESSAGE = "This application requires WebGPU; your browser does not support it.";

// Snapshot whatever `navigator` is in scope so we can restore it after each case.
const ORIGINAL_NAVIGATOR = (globalThis as { navigator?: unknown }).navigator;

function setNavigatorGpu(gpu: unknown): void {
  Object.defineProperty(globalThis, "navigator", {
    value: gpu === undefined ? {} : { gpu },
    configurable: true,
    writable: true,
  });
}

function mockGpu(adapter: AdapterResult): { requestAdapter: () => Promise<AdapterResult> } {
  return { requestAdapter: async () => adapter };
}

afterEach(() => {
  Object.defineProperty(globalThis, "navigator", {
    value: ORIGINAL_NAVIGATOR,
    configurable: true,
    writable: true,
  });
});

describe("WebGPU capability detection (§8.2)", () => {
  test("(a) adapter resolved → hasWebGPU true, assertWebGPU resolves", async () => {
    setNavigatorGpu(mockGpu({ name: "mock-adapter" }));
    expect(await hasWebGPU()).toBe(true);
    await expect(assertWebGPU()).resolves.toBeUndefined();
  });

  test("(b) navigator.gpu undefined → hasWebGPU false, assertWebGPU rejects with exact message", async () => {
    setNavigatorGpu(undefined); // navigator exists, but no .gpu
    expect(await hasWebGPU()).toBe(false);
    await expect(assertWebGPU()).rejects.toThrow(UNSUPPORTED_MESSAGE);
  });

  test("(c) requestAdapter resolves null → hasWebGPU false", async () => {
    setNavigatorGpu(mockGpu(null));
    expect(await hasWebGPU()).toBe(false);
    await expect(assertWebGPU()).rejects.toThrow(UNSUPPORTED_MESSAGE);
  });
});

describe("teardown sanity", () => {
  test("navigator is restored after the mocked cases", () => {
    // beforeEach/afterEach hygiene: by the time this runs the original navigator is back.
    expect((globalThis as { navigator?: unknown }).navigator).toBe(ORIGINAL_NAVIGATOR);
  });
});

// Use beforeEach to keep each case isolated even though afterEach restores: ensure no stale
// gpu leaks INTO a case from a prior file's globals.
beforeEach(() => {
  // no-op guard; the per-test setNavigatorGpu calls fully define the navigator for that case.
});
