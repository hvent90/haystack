import { describe, expect, test } from "bun:test";

import {
  defaultOrbitDistance,
  maxOrbitDistance,
  maxOrbitPitchRad,
  minOrbitDistance,
  OrbitCameraState,
  orbitRadiansPerPixel,
} from "../../src/client/eve/cameraStore";

describe("orbit camera state", () => {
  test("drag orbits yaw freely through 360° and wraps", () => {
    const orbit = new OrbitCameraState();
    const startYaw = orbit.yawRad;
    const fullTurnPx = (Math.PI * 2) / orbitRadiansPerPixel;
    orbit.orbitBy(fullTurnPx, 0);
    expect(orbit.yawRad).toBeCloseTo(startYaw, 5);
    expect(Math.abs(orbit.yawRad)).toBeLessThanOrEqual(Math.PI);
  });

  test("pitch clamps short of the poles", () => {
    const orbit = new OrbitCameraState();
    orbit.orbitBy(0, 1e6);
    expect(orbit.pitchRad).toBe(maxOrbitPitchRad);
    orbit.orbitBy(0, -1e6);
    expect(orbit.pitchRad).toBe(-maxOrbitPitchRad);
  });

  test("zoom is exponential: equal notches multiply distance equally", () => {
    const orbit = new OrbitCameraState();
    const before = orbit.distance;
    orbit.zoomBy(100);
    const ratio = orbit.distance / before;
    orbit.zoomBy(100);
    expect(orbit.distance / (before * ratio)).toBeCloseTo(ratio, 6);
    expect(ratio).toBeGreaterThan(1);
  });

  test("zoom clamps to hull and visibility bounds", () => {
    const orbit = new OrbitCameraState();
    orbit.zoomBy(-1e6);
    expect(orbit.distance).toBe(minOrbitDistance);
    orbit.zoomBy(1e6);
    expect(orbit.distance).toBe(maxOrbitDistance);
  });

  test("offset places the camera at yaw/pitch/distance around the origin", () => {
    const orbit = new OrbitCameraState();
    orbit.yawRad = 0;
    orbit.pitchRad = 0;
    orbit.distance = 2;
    const out = { x: 0, y: 0, z: 0 };
    orbit.offsetInto(out);
    expect(out.x).toBeCloseTo(0, 6);
    expect(out.y).toBeCloseTo(0, 6);
    expect(out.z).toBeCloseTo(2, 6);
    orbit.yawRad = Math.PI / 2;
    orbit.pitchRad = Math.PI / 4;
    orbit.offsetInto(out);
    expect(out.x).toBeCloseTo(2 * Math.cos(Math.PI / 4), 6);
    expect(out.y).toBeCloseTo(2 * Math.sin(Math.PI / 4), 6);
    expect(out.z).toBeCloseTo(0, 6);
  });

  test("seeding from a chase offset adopts angles but keeps the zoom distance", () => {
    const orbit = new OrbitCameraState();
    orbit.distance = defaultOrbitDistance * 3;
    orbit.seedAnglesFromOffset(1, 1, 0);
    expect(orbit.yawRad).toBeCloseTo(Math.PI / 2, 6);
    expect(orbit.pitchRad).toBeCloseTo(Math.asin(1 / Math.hypot(1, 1, 0)), 6);
    expect(orbit.distance).toBe(defaultOrbitDistance * 3);
    // Round-trips: offsetInto at the seeded angles points back along the seed direction.
    const out = { x: 0, y: 0, z: 0 };
    orbit.offsetInto(out);
    const length = Math.hypot(out.x, out.y, out.z);
    expect(out.x / length).toBeCloseTo(1 / Math.hypot(1, 1, 0), 6);
    expect(out.y / length).toBeCloseTo(1 / Math.hypot(1, 1, 0), 6);
    expect(out.z / length).toBeCloseTo(0, 6);
  });
});
