// GPU cull/LOD compaction — TSL/WebGPU compute kernels (architecture §7 step 4).
//
// Per frame: `clearCull` zeroes the per-LOD indirect instanceCounts, then `cull` runs one
// lane per resident slot — dead-slot check (radius 0, a ring hole), floating-origin rebase
// to scene units, nearest-distance draw cull, bounding-sphere frustum test, LOD banding —
// and compacts survivors into per-LOD slot lists + bumps the matching indirect
// instanceCount atomically. The renderer then issues 4 `drawIndirect` calls (one per LOD
// geometry) whose instance counts the GPU just wrote: zero CPU involvement in culling.
//
// The CPU executable spec is ../cull-cpu.ts (same banding/planes/predicates); the on-device
// gate in ../verify-gpu.ts compares the two as SETS (the compaction order is an atomic
// race). The compacted slot order is also non-deterministic per frame — temporal per-rock
// state must key on slotMeta, NEVER the compacted draw index (§2.2).

import * as THREE from "three/webgpu";
import {
  atomicAdd,
  atomicLoad,
  atomicStore,
  float,
  Fn,
  If,
  instancedArray,
  instanceIndex,
  Loop,
  storage,
  uint,
  uniformArray,
} from "three/tsl";

import { MAX_RESIDENT, pos } from "../buffers";
import { LOD_BANDS_SCENE, LOD_COUNT, MAX_DRAW_SCENE, METERS_PER_SCENE_UNIT } from "../cull-cpu";
import { originMeters } from "./render-node";

const WORKGROUP = 256;

export type ComputeKernel = ReturnType<ReturnType<ReturnType<typeof Fn>>["compute"]>;

export type CullPipeline = {
  // Per-LOD compacted slot lists (uint, MAX_RESIDENT capacity each). The render material
  // indexes `pos` through these: slot = lodList.element(instanceIndex).
  lodLists: ReturnType<typeof instancedArray>[];
  // Per-LOD indirect draw args [vertexCount, instanceCount, firstVertex, firstInstance];
  // attach to each LOD geometry via geometry.setIndirect(). instanceCount is GPU-written.
  indirectAttrs: InstanceType<typeof THREE.IndirectStorageBufferAttribute>[];
  // 6 scene-space frustum planes (xyz=n, w=d); update from the camera every frame via
  // updatePlanes().
  updatePlanes(projScreen: THREE.Matrix4): void;
  clearCull: ComputeKernel;
  cull: ComputeKernel;
  // Copies the per-band counters into the four indirect args' instanceCount fields. A
  // separate dispatch because the cull kernel binding pos + 4 lists + 4 indirect args
  // would need 9 storage buffers — over the WebGPU default maxStorageBuffersPerShaderStage
  // of 8 (device-caught). cull binds 6; publish binds 5.
  publishCounts: ComputeKernel;
};

// Build the cull pipeline for the given per-LOD vertex counts (the non-indexed LOD
// geometries' position counts, baked into the indirect args' vertexCount fields).
export function makeCullPipeline(lodVertexCounts: readonly number[]): CullPipeline {
  if (lodVertexCounts.length !== LOD_COUNT) {
    throw new Error(`makeCullPipeline: expected ${LOD_COUNT} LOD vertex counts`);
  }

  const lodLists = Array.from({ length: LOD_COUNT }, () => instancedArray(MAX_RESIDENT, "uint"));
  const indirectAttrs = lodVertexCounts.map(
    (vertexCount) =>
      new THREE.IndirectStorageBufferAttribute(new Uint32Array([vertexCount, 0, 0, 0]), 4),
  );
  // The cull kernel accumulates into ONE atomic per-band counter buffer (not the indirect
  // args directly — that would put 9 storage buffers in one compute stage, over the WebGPU
  // default limit of 8). publishCounts then copies counters -> instanceCount fields.
  const bandCounts = instancedArray(LOD_COUNT, "uint").toAtomic();
  const indirectNodes = indirectAttrs.map((attr) => storage(attr, "uint", 4));

  // Six scene-space frustum planes, refreshed per frame from the camera's projScreen
  // matrix (CPU extraction shared with the spec: cull-cpu.extractFrustumPlanes).
  const planeVectors = Array.from({ length: 6 }, () => new THREE.Vector4());
  const planes = uniformArray(planeVectors);

  const updatePlanes = (projScreen: THREE.Matrix4): void => {
    const e = projScreen.elements;
    const row = (i: number, j: number): number => e[j * 4 + i]!;
    const set = (p: number, a: number, b: number, c: number, d: number): void => {
      const inv = 1 / Math.hypot(a, b, c);
      planeVectors[p]!.set(a * inv, b * inv, c * inv, d * inv);
    };
    /* eslint-disable prettier/prettier */
    set(
      0,
      row(3, 0) + row(0, 0),
      row(3, 1) + row(0, 1),
      row(3, 2) + row(0, 2),
      row(3, 3) + row(0, 3),
    );
    set(
      1,
      row(3, 0) - row(0, 0),
      row(3, 1) - row(0, 1),
      row(3, 2) - row(0, 2),
      row(3, 3) - row(0, 3),
    );
    set(
      2,
      row(3, 0) + row(1, 0),
      row(3, 1) + row(1, 1),
      row(3, 2) + row(1, 2),
      row(3, 3) + row(1, 3),
    );
    set(
      3,
      row(3, 0) - row(1, 0),
      row(3, 1) - row(1, 1),
      row(3, 2) - row(1, 2),
      row(3, 3) - row(1, 3),
    );
    set(
      4,
      row(3, 0) + row(2, 0),
      row(3, 1) + row(2, 1),
      row(3, 2) + row(2, 2),
      row(3, 3) + row(2, 3),
    );
    set(
      5,
      row(3, 0) - row(2, 0),
      row(3, 1) - row(2, 1),
      row(3, 2) - row(2, 2),
      row(3, 3) - row(2, 3),
    );
    /* eslint-enable prettier/prettier */
  };

  // Zero the four band counters (lane 0; 4 stores — not worth 4 lanes' bookkeeping).
  const clearCull = Fn(() => {
    If(instanceIndex.equal(uint(0)), () => {
      for (let band = 0; band < LOD_COUNT; band += 1) {
        atomicStore(bandCounts.element(uint(band)), uint(0));
      }
    });
  })().compute(WORKGROUP, [WORKGROUP]);

  // Copy the per-band counters into each indirect args' instanceCount (element 1).
  const publishCounts = Fn(() => {
    If(instanceIndex.equal(uint(0)), () => {
      for (let band = 0; band < LOD_COUNT; band += 1) {
        indirectNodes[band]!.element(uint(1)).assign(atomicLoad(bandCounts.element(uint(band))));
      }
    });
  })().compute(WORKGROUP, [WORKGROUP]);

  // One lane per slot. Mirrors cull-cpu.cullCPU exactly.
  const cull = Fn(() => {
    If(instanceIndex.lessThan(uint(MAX_RESIDENT)), () => {
      const body = pos.element(instanceIndex);
      const radius = body.w;
      If(radius.greaterThan(float(0)), () => {
        const rel = body.xyz.sub(originMeters).div(float(METERS_PER_SCENE_UNIT)).toVar();
        const radiusScene = radius.div(float(METERS_PER_SCENE_UNIT)).toVar();
        const nearest = rel.length().sub(radiusScene).toVar();
        If(nearest.lessThan(float(MAX_DRAW_SCENE)), () => {
          const outside = uint(0).toVar();
          Loop({ start: uint(0), end: uint(6), type: "uint", condition: "<" }, ({ i }) => {
            const plane = planes.element(i);
            If(plane.xyz.dot(rel).add(plane.w).lessThan(radiusScene.negate()), () => {
              outside.assign(uint(1));
            });
          });
          If(outside.equal(uint(0)), () => {
            If(nearest.lessThan(float(LOD_BANDS_SCENE[0])), () => {
              const at = atomicAdd(bandCounts.element(uint(0)), uint(1));
              lodLists[0]!.element(at).assign(instanceIndex);
            })
              .ElseIf(nearest.lessThan(float(LOD_BANDS_SCENE[1])), () => {
                const at = atomicAdd(bandCounts.element(uint(1)), uint(1));
                lodLists[1]!.element(at).assign(instanceIndex);
              })
              .ElseIf(nearest.lessThan(float(LOD_BANDS_SCENE[2])), () => {
                const at = atomicAdd(bandCounts.element(uint(2)), uint(1));
                lodLists[2]!.element(at).assign(instanceIndex);
              })
              .Else(() => {
                const at = atomicAdd(bandCounts.element(uint(3)), uint(1));
                lodLists[3]!.element(at).assign(instanceIndex);
              });
          });
        });
      });
    });
  })().compute(MAX_RESIDENT, [WORKGROUP]);

  return { lodLists, indirectAttrs, updatePlanes, clearCull, cull, publishCounts };
}
