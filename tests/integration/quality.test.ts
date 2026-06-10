import { afterEach, describe, expect, test } from "bun:test";

import { resetTouchDeviceCacheForTests } from "../../src/client/eve/mobile";
import { qualityParams, resetQualityCacheForTests } from "../../src/client/eve/quality";

// Quality tier selection: desktop by default (incl. every windowless test/worker
// context), mobile on touch-only devices, ?tier= override wins over the probe.

const ORIGINAL_WINDOW = (globalThis as { window?: unknown }).window;
const ORIGINAL_NAVIGATOR = (globalThis as { navigator?: unknown }).navigator;

function setEnvironment(options: {
  maxTouchPoints?: number;
  anyPointerFine?: boolean;
  search?: string;
}): void {
  Object.defineProperty(globalThis, "navigator", {
    value: { maxTouchPoints: options.maxTouchPoints ?? 0 },
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "window", {
    value: {
      location: { search: options.search ?? "" },
      matchMedia: (query: string) => ({
        matches: query === "(any-pointer: fine)" ? (options.anyPointerFine ?? false) : false,
      }),
    },
    configurable: true,
    writable: true,
  });
  resetTouchDeviceCacheForTests();
  resetQualityCacheForTests();
}

afterEach(() => {
  Object.defineProperty(globalThis, "window", {
    value: ORIGINAL_WINDOW,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "navigator", {
    value: ORIGINAL_NAVIGATOR,
    configurable: true,
    writable: true,
  });
  resetTouchDeviceCacheForTests();
  resetQualityCacheForTests();
});

describe("qualityParams", () => {
  test("windowless context (tests, workers) resolves to the desktop tier", () => {
    resetQualityCacheForTests();
    // bun test env: no window — this is the load-time context for froxels-cpu fixtures.
    expect(qualityParams().tier).toBe("desktop");
    expect(qualityParams().froxel).toEqual({ w: 160, h: 90, d: 64 });
    expect(qualityParams().renderedLimitCap).toBe(Number.POSITIVE_INFINITY);
  });

  test("touch-only device resolves to the mobile tier", () => {
    setEnvironment({ maxTouchPoints: 5, anyPointerFine: false });
    const params = qualityParams();
    expect(params.tier).toBe("mobile");
    expect(params.renderedLimitCap).toBeLessThan(50000);
    expect(params.dprRange).toEqual([1, 1]);
    expect(params.sunShadowMap).toBe(false);
  });

  test("?tier=mobile overrides a desktop-shaped environment (bench harness knob)", () => {
    setEnvironment({ maxTouchPoints: 0, anyPointerFine: true, search: "?tier=mobile" });
    expect(qualityParams().tier).toBe("mobile");
  });

  test("?tier=desktop overrides a touch device", () => {
    setEnvironment({ maxTouchPoints: 5, anyPointerFine: false, search: "?tier=desktop" });
    expect(qualityParams().tier).toBe("desktop");
  });
});
