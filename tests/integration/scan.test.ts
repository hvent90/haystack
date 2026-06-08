import { describe, expect, test } from "bun:test";
import {
  scanPulseActive,
  scanPulseDurationSeconds,
  scanPulseEnvelope,
  scanPulseMaxRadius,
  scanPulseProgress,
  scanPulseRadius,
} from "../../src/client/eve/scan";

describe("scanPulseProgress", () => {
  test("is 0 at the start", () => {
    expect(scanPulseProgress(0, scanPulseDurationSeconds)).toBeCloseTo(0, 6);
  });

  test("is 0.5 at the midpoint", () => {
    expect(scanPulseProgress(scanPulseDurationSeconds / 2, scanPulseDurationSeconds)).toBeCloseTo(
      0.5,
      6,
    );
  });

  test("clamps to 1 past the duration", () => {
    expect(scanPulseProgress(scanPulseDurationSeconds * 4, scanPulseDurationSeconds)).toBe(1);
  });

  test("clamps to 0 for negative elapsed", () => {
    expect(scanPulseProgress(-2, scanPulseDurationSeconds)).toBe(0);
  });
});

describe("scanPulseActive", () => {
  test("is active during the pulse window", () => {
    expect(scanPulseActive(scanPulseDurationSeconds / 2, scanPulseDurationSeconds)).toBe(true);
  });

  test("is inactive once the pulse completes", () => {
    expect(scanPulseActive(scanPulseDurationSeconds, scanPulseDurationSeconds)).toBe(false);
    expect(scanPulseActive(scanPulseDurationSeconds + 1, scanPulseDurationSeconds)).toBe(false);
  });

  test("is inactive before it begins", () => {
    expect(scanPulseActive(-0.1, scanPulseDurationSeconds)).toBe(false);
  });
});

describe("scanPulseRadius", () => {
  test("starts at the player (0) and reaches the max radius", () => {
    expect(scanPulseRadius(0, scanPulseMaxRadius)).toBeCloseTo(0, 6);
    expect(scanPulseRadius(1, scanPulseMaxRadius)).toBeCloseTo(scanPulseMaxRadius, 6);
  });

  test("expands monotonically outward", () => {
    expect(scanPulseRadius(0.5, scanPulseMaxRadius)).toBeGreaterThan(
      scanPulseRadius(0.25, scanPulseMaxRadius),
    );
  });
});

describe("scanPulseEnvelope", () => {
  test("fades in from 0 and out to 0", () => {
    expect(scanPulseEnvelope(0)).toBeCloseTo(0, 6);
    expect(scanPulseEnvelope(1)).toBeCloseTo(0, 6);
  });

  test("peaks at full strength mid-flight", () => {
    expect(scanPulseEnvelope(0.5)).toBeCloseTo(1, 6);
  });

  test("is symmetric around the midpoint", () => {
    expect(scanPulseEnvelope(0.25)).toBeCloseTo(scanPulseEnvelope(0.75), 6);
  });
});
