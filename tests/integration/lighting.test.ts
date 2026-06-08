import { describe, expect, test } from "bun:test";
import { forwardVector, sunDirection } from "../../src/client/eve/lighting";

describe("forwardVector", () => {
  test("identity orientation points down -Z (camera forward)", () => {
    const forward = forwardVector({ x: 0, y: 0, z: 0, w: 1 });
    expect(forward.x).toBeCloseTo(0, 6);
    expect(forward.y).toBeCloseTo(0, 6);
    expect(forward.z).toBeCloseTo(-1, 6);
  });

  test("90 degree yaw about Y rotates forward to -X", () => {
    const half = Math.PI / 4;
    const forward = forwardVector({ x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) });
    expect(forward.x).toBeCloseTo(-1, 6);
    expect(forward.y).toBeCloseTo(0, 6);
    expect(forward.z).toBeCloseTo(0, 6);
  });

  test("90 degree pitch about X rotates forward to +Y", () => {
    const half = Math.PI / 4;
    const forward = forwardVector({ x: Math.sin(half), y: 0, z: 0, w: Math.cos(half) });
    expect(forward.x).toBeCloseTo(0, 6);
    expect(forward.y).toBeCloseTo(1, 6);
    expect(forward.z).toBeCloseTo(0, 6);
  });

  test("returns a unit-length vector for a normalized quaternion", () => {
    const raw = { x: 0.18, y: -0.62, z: 0.27, w: 0.71 };
    const norm = Math.hypot(raw.x, raw.y, raw.z, raw.w);
    const forward = forwardVector({
      x: raw.x / norm,
      y: raw.y / norm,
      z: raw.z / norm,
      w: raw.w / norm,
    });
    const length = Math.sqrt(forward.x ** 2 + forward.y ** 2 + forward.z ** 2);
    expect(length).toBeCloseTo(1, 5);
  });
});

describe("sunDirection", () => {
  test("is a unit vector", () => {
    const length = Math.sqrt(sunDirection.x ** 2 + sunDirection.y ** 2 + sunDirection.z ** 2);
    expect(length).toBeCloseTo(1, 6);
  });
});
