// Froxel volumetric lighting — CPU executable-spec pins (architecture §6, §2.5).
//
// These tests pin src/client/eve/gpu/froxels-cpu.ts, the f64 reference the TSL kernels
// mirror (kernels/froxels.ts). The on-device gate (verify-gpu.ts) compares the GPU
// kernels against THIS spec on identical inputs; these headless tests make the spec
// itself trustworthy first (same discipline as binner-cpu / collide-cpu / cull-cpu).

import { describe, expect, test } from "bun:test";
import { PerspectiveCamera, Matrix4, Vector3, Vector4 } from "three";

import {
  FROXEL_COUNT,
  FROXEL_D,
  FROXEL_FADE_START,
  FROXEL_FAR,
  FROXEL_H,
  FROXEL_NEAR,
  FROXEL_W,
  froxelCenterWorldMeters,
  froxelIndexOf,
  froxelIntegrateCPU,
  froxelScatterCPU,
  froxelSigmaT,
  sampleDensity,
  sliceFarEdge,
  zOfDistance,
  type DensityGrid,
  type FroxelMediumParams,
} from "../../src/client/eve/gpu/froxels-cpu";

describe("froxel grid geometry", () => {
  test("log-depth slices span exactly [NEAR, FAR] and grow monotonically", () => {
    expect(sliceFarEdge(FROXEL_D - 1)).toBeCloseTo(FROXEL_FAR, 9);
    let prev = FROXEL_NEAR;
    for (let z = 0; z < FROXEL_D; z += 1) {
      const edge = sliceFarEdge(z);
      expect(edge).toBeGreaterThan(prev);
      prev = edge;
    }
  });

  test("zOfDistance inverts sliceFarEdge (the depth-aware lookup coordinate)", () => {
    for (let z = 0; z < FROXEL_D; z += 1) {
      expect(zOfDistance(sliceFarEdge(z))).toBeCloseTo(z + 1, 9);
    }
    expect(zOfDistance(FROXEL_NEAR)).toBeCloseTo(0, 9);
  });

  test("index packing matches the §2.5 schema (z*W*H + y*W + x)", () => {
    expect(froxelIndexOf(0, 0, 0)).toBe(0);
    expect(froxelIndexOf(FROXEL_W - 1, FROXEL_H - 1, FROXEL_D - 1)).toBe(FROXEL_COUNT - 1);
    expect(froxelIndexOf(3, 2, 1)).toBe(FROXEL_W * FROXEL_H + 2 * FROXEL_W + 3);
  });
});

// A small synthetic polar grid where every bin holds a distinct, predictable byte.
function syntheticGrid(): DensityGrid {
  const nr = 8;
  const ntheta = 16;
  const nz = 4;
  const data = new Uint8Array(nr * ntheta * nz);
  for (let ir = 0; ir < nr; ir += 1) {
    for (let it = 0; it < ntheta; it += 1) {
      for (let iz = 0; iz < nz; iz += 1) {
        data[(ir * ntheta + it) * nz + iz] = (ir * 31 + it * 7 + iz * 11) % 256;
      }
    }
  }
  return { data, nr, ntheta, nz, rMin: 0.5, rMax: 3.25, zMax: 0.09, worldScale: 1e6 };
}

// World position (meters) of the exact CENTER of bin (ir, it, iz) — where trilinear
// weights collapse to a single tap.
function binCenterWorld(
  g: DensityGrid,
  ir: number,
  it: number,
  iz: number,
): { x: number; y: number; z: number } {
  const r = (g.rMin + ((ir + 0.5) / g.nr) * (g.rMax - g.rMin)) * g.worldScale;
  const theta = ((it + 0.5) / g.ntheta) * 2 * Math.PI - Math.PI;
  const z = (-g.zMax + ((iz + 0.5) / g.nz) * 2 * g.zMax) * g.worldScale;
  return { x: r * Math.cos(theta), y: z, z: r * Math.sin(theta) };
}

describe("sampleDensity (polar trilinear)", () => {
  const g = syntheticGrid();

  test("bin centers return the exact byte", () => {
    for (const [ir, it, iz] of [
      [0, 0, 0],
      [3, 5, 2],
      [7, 15, 3],
      [4, 8, 1],
    ] as const) {
      const p = binCenterWorld(g, ir, it, iz);
      const expected = g.data[(ir * g.ntheta + it) * g.nz + iz]! / 255;
      expect(sampleDensity(g, p.x, p.y, p.z)).toBeCloseTo(expected, 9);
    }
  });

  test("outside the bake volume is hard zero", () => {
    expect(sampleDensity(g, 0.49 * g.worldScale, 0, 0)).toBe(0); // r < rMin
    expect(sampleDensity(g, 3.26 * g.worldScale, 0, 0)).toBe(0); // r > rMax
    const p = binCenterWorld(g, 4, 8, 1);
    expect(sampleDensity(g, p.x, 0.1 * g.worldScale, p.z)).toBe(0); // |z| > zMax
  });

  test("theta wraps across the -pi/+pi seam by interpolation, not a cliff", () => {
    // Halfway between the last theta bin's center and the first's, across the seam:
    // theta = -pi exactly. Expect the average of the two bins (same ir/iz).
    const ir = 3;
    const iz = 2;
    const r = (g.rMin + ((ir + 0.5) / g.nr) * (g.rMax - g.rMin)) * g.worldScale;
    const z = (-g.zMax + ((iz + 0.5) / g.nz) * 2 * g.zMax) * g.worldScale;
    const theta = -Math.PI;
    const a = g.data[(ir * g.ntheta + (g.ntheta - 1)) * g.nz + iz]!;
    const b = g.data[(ir * g.ntheta + 0) * g.nz + iz]!;
    const got = sampleDensity(g, r * Math.cos(theta), z, r * Math.sin(theta));
    expect(got).toBeCloseTo((a + b) / 2 / 255, 9);
  });

  test("radial midpoints interpolate between adjacent r bins", () => {
    const it = 5;
    const iz = 1;
    const theta = ((it + 0.5) / g.ntheta) * 2 * Math.PI - Math.PI;
    const z = (-g.zMax + ((iz + 0.5) / g.nz) * 2 * g.zMax) * g.worldScale;
    const r = (g.rMin + (3 / g.nr) * (g.rMax - g.rMin)) * g.worldScale; // edge between ir 2|3
    const a = g.data[(2 * g.ntheta + it) * g.nz + iz]!;
    const b = g.data[(3 * g.ntheta + it) * g.nz + iz]!;
    const got = sampleDensity(g, r * Math.cos(theta), z, r * Math.sin(theta));
    expect(got).toBeCloseTo((a + b) / 2 / 255, 9);
  });
});

function cameraParams(originMeters: { x: number; y: number; z: number }): FroxelMediumParams {
  const camera = new PerspectiveCamera(68, 16 / 9, 0.01, 20000);
  camera.position.set(0, 0.12, 0);
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();
  return {
    projectionMatrixInverse: camera.projectionMatrixInverse.elements,
    cameraWorldMatrix: camera.matrixWorld.elements,
    originMeters,
    sigmaScale: 0.3,
    sigmaFloor: 0.012,
    albedo: { x: 0.62, y: 0.68, z: 0.82 },
    ambient: 0.07,
  };
}

describe("froxelCenterWorldMeters (floating-origin ray reconstruction)", () => {
  test("froxel centers sit on the camera ray at the log slice-center distance", () => {
    const origin = { x: 1_500_000, y: 0, z: 0 };
    const p = cameraParams(origin);
    const projInv = new Matrix4().fromArray(Array.from(p.projectionMatrixInverse));
    const camWorld = new Matrix4().fromArray(Array.from(p.cameraWorldMatrix));
    for (const [x, y, z] of [
      [0, 0, 0],
      [80, 45, 32],
      [159, 89, 63],
      [40, 70, 10],
    ] as const) {
      const c = froxelCenterWorldMeters(x, y, z, p);
      // Independent reconstruction via three's own Matrix4/Vector math.
      const ndc = new Vector4(
        ((x + 0.5) / FROXEL_W) * 2 - 1,
        ((y + 0.5) / FROXEL_H) * 2 - 1,
        0.5,
        1,
      );
      const v = ndc.applyMatrix4(projInv);
      const dir = new Vector3(v.x / v.w, v.y / v.w, v.z / v.w).normalize();
      const dist = FROXEL_NEAR * Math.pow(FROXEL_FAR / FROXEL_NEAR, (z + 0.5) / FROXEL_D);
      const scene = dir.multiplyScalar(dist).applyMatrix4(camWorld);
      expect(c.dist).toBeCloseTo(dist, 9);
      expect(c.x).toBeCloseTo(origin.x + scene.x * 1000, 6);
      expect(c.y).toBeCloseTo(origin.y + scene.y * 1000, 6);
      expect(c.z).toBeCloseTo(origin.z + scene.z * 1000, 6);
    }
  });

  test("center-screen froxels look down -Z (scene == camera frame at identity yaw)", () => {
    const p = cameraParams({ x: 0, y: 0, z: 0 });
    const near = froxelCenterWorldMeters(80, 45, 0, p);
    const far = froxelCenterWorldMeters(80, 45, FROXEL_D - 1, p);
    expect(far.z).toBeLessThan(near.z); // -z is forward
    expect(Math.abs(far.x)).toBeLessThan(2000); // near the view axis (within a tile)
  });
});

describe("froxelSigmaT (far handoff)", () => {
  test("full strength inside FADE_START, exactly zero at FAR", () => {
    expect(froxelSigmaT(1, FROXEL_FADE_START - 1, 0.3, 0.012)).toBeCloseTo(0.312, 9);
    expect(froxelSigmaT(1, FROXEL_FAR, 0.3, 0.012)).toBeCloseTo(0, 9);
    const mid = froxelSigmaT(1, (FROXEL_FADE_START + FROXEL_FAR) / 2, 0.3, 0.012);
    expect(mid).toBeCloseTo(0.312 / 2, 9);
  });
});

describe("scatter + integrate", () => {
  test("zero medium (null grid, zero floor) integrates to the identity", () => {
    const p = { ...cameraParams({ x: 0, y: 0, z: 0 }), sigmaFloor: 0, ambient: 0.07 };
    const accum = new Float32Array(FROXEL_COUNT * 4);
    froxelScatterCPU(null, p, accum);
    froxelIntegrateCPU(accum);
    // Spot-check a spread of froxels: no in-scatter, transmittance 1 everywhere.
    for (const i of [0, 12345, 456789, FROXEL_COUNT - 1]) {
      expect(accum[i * 4]).toBe(0);
      expect(accum[i * 4 + 1]).toBe(0);
      expect(accum[i * 4 + 2]).toBe(0);
      expect(accum[i * 4 + 3]).toBe(1);
    }
  });

  test("uniform floor: cumulative T matches the closed form, in-scatter the geometric sum", () => {
    const p = cameraParams({ x: 0, y: 0, z: 0 });
    const accum = new Float32Array(FROXEL_COUNT * 4);
    froxelScatterCPU(null, p, accum); // density 0 everywhere -> sigma = floor * fade(dist)
    froxelIntegrateCPU(accum);
    const col = froxelIndexOf(80, 45, 0) % (FROXEL_W * FROXEL_H);
    let expectedT = 1;
    let expectedL = 0;
    for (let z = 0; z < FROXEL_D; z += 1) {
      const sliceLen = sliceFarEdge(z) - (z === 0 ? FROXEL_NEAR : sliceFarEdge(z - 1));
      const center = FROXEL_NEAR * Math.pow(FROXEL_FAR / FROXEL_NEAR, (z + 0.5) / FROXEL_D);
      const sigma = froxelSigmaT(0, center, p.sigmaScale, p.sigmaFloor);
      const sliceT = Math.exp(-sigma * sliceLen);
      expectedL += expectedT * p.ambient * (1 - sliceT) * p.albedo.x;
      expectedT *= sliceT;
      const o = (z * FROXEL_W * FROXEL_H + col) * 4;
      expect(accum[o + 3]).toBeCloseTo(expectedT, 5);
      expect(accum[o]).toBeCloseTo(expectedL, 5);
    }
    // The whole 24 km column through the floor-only medium stays nearly clear (a breath).
    const last = (((FROXEL_D - 1) * FROXEL_W * FROXEL_H + col) * 4) as number;
    expect(accum[last + 3]!).toBeGreaterThan(0.75);
  });

  test("belt density makes columns through the belt darker than columns out of it", () => {
    // Constant-255 belt: any ray crossing the bake volume picks up extinction; the
    // origin sits mid-belt so forward rays are inside, and density gates on |z| <= zMax.
    const g = syntheticGrid();
    g.data.fill(255);
    const p = cameraParams({ x: 1_500_000, y: 0, z: 0 }); // inside the belt midplane
    const inBelt = new Float32Array(FROXEL_COUNT * 4);
    froxelScatterCPU(g, p, inBelt);
    froxelIntegrateCPU(inBelt);
    const above = cameraParams({ x: 1_500_000, y: 500_000, z: 0 }); // 500 km above the belt
    const outBelt = new Float32Array(FROXEL_COUNT * 4);
    froxelScatterCPU(g, above, outBelt);
    froxelIntegrateCPU(outBelt);
    const idx = froxelIndexOf(80, 45, FROXEL_D - 1) * 4;
    expect(inBelt[idx + 3]!).toBeLessThan(0.05); // dense belt: heavy extinction
    expect(outBelt[idx + 3]!).toBeGreaterThan(0.75); // out of the belt: the floor only
    expect(inBelt[idx]!).toBeGreaterThan(outBelt[idx]!); // and more in-scatter
  });

  test("transmittance is monotonically non-increasing along every sampled column", () => {
    const g = syntheticGrid();
    const p = cameraParams({ x: 1_500_000, y: 0, z: 0 });
    const accum = new Float32Array(FROXEL_COUNT * 4);
    froxelScatterCPU(g, p, accum);
    froxelIntegrateCPU(accum);
    for (const [x, y] of [
      [0, 0],
      [80, 45],
      [159, 89],
      [25, 60],
    ] as const) {
      let prev = 1;
      for (let z = 0; z < FROXEL_D; z += 1) {
        const t = accum[froxelIndexOf(x, y, z) * 4 + 3]!;
        expect(t).toBeLessThanOrEqual(prev + 1e-7);
        prev = t;
      }
    }
  });
});
