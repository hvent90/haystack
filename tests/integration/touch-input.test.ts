import { afterEach, describe, expect, test } from "bun:test";

import { isTouchDevice, resetTouchDeviceCacheForTests } from "../../src/client/eve/mobile";
import {
  createTouchFlightState,
  resetTouchFlightAxes,
  squaredAxis,
  stickDeadzone,
  stickRadiusPx,
  stickVector,
  touchFlightEngaged,
} from "../../src/client/eve/touch-input";

// Pure unit coverage for the touch flight input layer: the stick math feeding
// buildFlightInput must be clamped, deadzoned, and continuous, and the device probe
// must be capability-driven (touch points + no fine pointer) with query overrides.

describe("stickVector", () => {
  test("zero offset is exactly zero (no NaN from normalizing a zero vector)", () => {
    expect(stickVector(0, 0)).toEqual({ x: 0, y: 0 });
  });

  test("offsets inside the deadzone read as zero", () => {
    const inside = stickRadiusPx * stickDeadzone * 0.9;
    const v = stickVector(inside, 0);
    expect(v.x).toBe(0);
    expect(v.y).toBe(0);
  });

  test("output is continuous at the deadzone edge and reaches 1 at full radius", () => {
    const justOutside = stickVector(stickRadiusPx * (stickDeadzone + 0.01), 0);
    expect(justOutside.x).toBeGreaterThan(0);
    expect(justOutside.x).toBeLessThan(0.05);
    const full = stickVector(stickRadiusPx, 0);
    expect(full.x).toBeCloseTo(1, 10);
  });

  test("magnitude clamps to 1 beyond the radius and preserves direction", () => {
    const v = stickVector(stickRadiusPx * 3, stickRadiusPx * 4); // 3-4-5 direction
    expect(Math.hypot(v.x, v.y)).toBeCloseTo(1, 10);
    expect(v.x).toBeCloseTo(0.6, 10);
    expect(v.y).toBeCloseTo(0.8, 10);
  });
});

describe("squaredAxis", () => {
  test("preserves sign and softens the center", () => {
    expect(squaredAxis(0.5)).toBeCloseTo(0.25, 10);
    expect(squaredAxis(-0.5)).toBeCloseTo(-0.25, 10);
    expect(squaredAxis(1)).toBe(1);
    expect(squaredAxis(-1)).toBe(-1);
    expect(squaredAxis(0)).toBe(0);
  });
});

describe("touch flight state", () => {
  test("engaged tracks the active pointer count", () => {
    const state = createTouchFlightState();
    expect(touchFlightEngaged(state)).toBe(false);
    state.pointers += 1;
    expect(touchFlightEngaged(state)).toBe(true);
    state.pointers -= 1;
    expect(touchFlightEngaged(state)).toBe(false);
  });

  test("resetTouchFlightAxes zeroes axes but leaves pointer accounting alone", () => {
    const state = createTouchFlightState();
    state.pointers = 2;
    state.throttle = 0.8;
    state.strafeX = -0.4;
    state.rotation = { x: 0.2, y: -0.3, z: 1 };
    state.stabilize = true;
    resetTouchFlightAxes(state);
    expect(state.throttle).toBeNull();
    expect(state.strafeX).toBe(0);
    expect(state.rotation).toEqual({ x: 0, y: 0, z: 0 });
    expect(state.stabilize).toBe(false);
    expect(state.pointers).toBe(2);
  });
});

describe("isTouchDevice", () => {
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
  });

  test("touch points without a fine pointer → touch device (a phone)", () => {
    setEnvironment({ maxTouchPoints: 5, anyPointerFine: false });
    expect(isTouchDevice()).toBe(true);
  });

  test("touch points WITH a fine pointer → desktop scheme (touchscreen laptop)", () => {
    setEnvironment({ maxTouchPoints: 10, anyPointerFine: true });
    expect(isTouchDevice()).toBe(false);
  });

  test("no touch points → desktop", () => {
    setEnvironment({ maxTouchPoints: 0, anyPointerFine: true });
    expect(isTouchDevice()).toBe(false);
  });

  test("?touch=1 forces the touch UI, ?touch=0 forces it off", () => {
    setEnvironment({ maxTouchPoints: 0, anyPointerFine: true, search: "?touch=1" });
    expect(isTouchDevice()).toBe(true);
    setEnvironment({ maxTouchPoints: 5, anyPointerFine: false, search: "?touch=0" });
    expect(isTouchDevice()).toBe(false);
  });
});
