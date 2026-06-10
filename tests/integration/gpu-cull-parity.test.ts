// CPU executable spec for the GPU cull/LOD compaction (architecture §7 step 4): per-slot
// frustum + distance cull and LOD banding, compacting visible slots into per-LOD draw
// lists. cull-cpu.ts is the reference the TSL kernel (kernels/cull.ts) mirrors pass-for-pass;
// the on-device gate (verify-gpu.ts) compares GPU output against THIS implementation.

import { describe, expect, test } from "bun:test";
import { Frustum, Matrix4, PerspectiveCamera, Sphere, Vector3 } from "three";
import {
  cullCPU,
  extractFrustumPlanes,
  LOD_BANDS_SCENE,
  LOD_COUNT,
  lodBandFor,
  MAX_DRAW_SCENE,
} from "../../src/client/eve/gpu/cull-cpu";

function makeCamera(): PerspectiveCamera {
  const camera = new PerspectiveCamera(68, 16 / 9, 0.01, 20000);
  camera.position.set(0, 0.12, 0);
  camera.lookAt(new Vector3(0, 0.1, -1));
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  return camera;
}

function projScreen(camera: PerspectiveCamera): Matrix4 {
  return new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
}

describe("extractFrustumPlanes", () => {
  test("matches THREE.Frustum sphere tests over random spheres", () => {
    const camera = makeCamera();
    const m = projScreen(camera);
    const planes = extractFrustumPlanes(m);
    expect(planes.length).toBe(24);

    const frustum = new Frustum().setFromProjectionMatrix(m);
    let seed = 424242;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    let inside = 0;
    for (let i = 0; i < 2000; i += 1) {
      const center = new Vector3((rand() - 0.5) * 40, (rand() - 0.5) * 40, (rand() - 0.5) * 40);
      const radius = rand() * 0.4;
      const expected = frustum.intersectsSphere(new Sphere(center, radius));
      let actual = true;
      for (let p = 0; p < 6; p += 1) {
        const d =
          planes[p * 4]! * center.x +
          planes[p * 4 + 1]! * center.y +
          planes[p * 4 + 2]! * center.z +
          planes[p * 4 + 3]!;
        if (d < -radius) {
          actual = false;
          break;
        }
      }
      expect(actual).toBe(expected);
      if (expected) inside += 1;
    }
    // The sample must actually exercise both halves of the predicate.
    expect(inside).toBeGreaterThan(100);
    expect(inside).toBeLessThan(1900);
  });
});

describe("lodBandFor", () => {
  test("bands by nearest distance against LOD_BANDS_SCENE", () => {
    expect(lodBandFor(0)).toBe(0);
    expect(lodBandFor(LOD_BANDS_SCENE[0]! - 0.01)).toBe(0);
    expect(lodBandFor(LOD_BANDS_SCENE[0]!)).toBe(1);
    expect(lodBandFor(LOD_BANDS_SCENE[1]!)).toBe(2);
    expect(lodBandFor(LOD_BANDS_SCENE[2]!)).toBe(3);
    expect(lodBandFor(MAX_DRAW_SCENE - 0.01)).toBe(3);
  });
});

describe("cullCPU", () => {
  test("culls dead slots, far rocks, and out-of-frustum rocks; bands the rest", () => {
    const camera = makeCamera();
    const planes = extractFrustumPlanes(projScreen(camera));
    const origin = { x: 7000, y: 20, z: 250 };

    // Slot layout (positions in METERS, absolute; origin-relative scene = (p-origin)/1000).
    // Distances calibrated to the ED-ring bands LOD_BANDS_SCENE = [2.5, 5, 8], draw 11:
    // 0: dead slot (radius 0)            -> culled
    // 1: 1.5 units ahead                 -> band 0
    // 2: 4 units ahead                   -> band 1
    // 3: 6.5 units ahead                 -> band 2
    // 4: 10 units ahead                  -> band 3
    // 5: 30 units ahead (beyond draw)    -> culled
    // 6: 4 units BEHIND the camera       -> KEPT, band 1 (off-frustum but inside the
    //    shadow-caster bubble — the shadow depth pass needs off-screen up-sun casters)
    // 7: 17.5 units BEHIND the camera    -> culled (off-frustum, outside the bubble)
    const ahead = new Vector3(0, 0.1, -1).normalize();
    const mk = (units: number, radius: number) => ({
      x: origin.x + ahead.x * units * 1000,
      y: origin.y + ahead.y * units * 1000,
      z: origin.z + ahead.z * units * 1000,
      r: radius,
    });
    const rocks = [
      { ...mk(2, 0), r: 0 },
      mk(1.5, 200),
      mk(4, 200),
      mk(6.5, 200),
      mk(10, 200),
      mk(30, 200),
      mk(-4, 200),
      mk(-17.5, 200),
    ];
    const pos = new Float32Array(rocks.length * 4);
    rocks.forEach((rock, i) => {
      pos[i * 4] = rock.x;
      pos[i * 4 + 1] = rock.y;
      pos[i * 4 + 2] = rock.z;
      pos[i * 4 + 3] = rock.r;
    });

    const result = cullCPU(pos, rocks.length, origin, planes);
    expect(result.lists.length).toBe(LOD_COUNT);
    expect([...result.lists[0]!]).toEqual([1]);
    expect([...result.lists[1]!]).toEqual([2, 6]);
    expect([...result.lists[2]!]).toEqual([3]);
    expect([...result.lists[3]!]).toEqual([4]);
  });

  test("band edges use nearest distance (dist - radius), like the legacy chunk cull", () => {
    const camera = makeCamera();
    const planes = extractFrustumPlanes(projScreen(camera));
    const origin = { x: 0, y: 0, z: 0 };
    const ahead = new Vector3(0, 0.1, -1).normalize();
    // Center at 2.6 units (past the 2.5 band edge) with a 0.3-unit (300m) radius ->
    // nearest 2.3 -> band 0.
    const pos = new Float32Array(4);
    pos[0] = ahead.x * 2600;
    pos[1] = ahead.y * 2600;
    pos[2] = ahead.z * 2600;
    pos[3] = 300;
    const result = cullCPU(pos, 1, origin, planes);
    expect([...result.lists[0]!]).toEqual([0]);
  });
});
