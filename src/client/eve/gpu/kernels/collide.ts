// Step-7 inter-asteroid collisions — TSL/WebGPU compute kernels (architecture §4, §7 step 7).
//
// Per frame (when the collision graph is active):
//   binner instance (clearCounts → count → 3-phase scan → initCursor → scatter) over the
//   collidable subset — the SHARED step-5 binner behind an inlined world-grid cellIndexOf
//   (§2.3), with an itemActive predicate so dead ring slots / out-of-window bodies never
//   enter a cell —
//   then `narrow` (27-cell deferred-apply: each lane accumulates ONLY its own dp/dv —
//   race-free by construction, §4.2), then `apply` (fold dp/dv into the persistent
//   offset/vel state with damping + hard caps).
//
// THE COSMETIC-TIER BOUND (§4.5 #1): there is NO free-running integrator. Collisions
// accumulate into `collOffset`, hard-capped at COLLISION_OFFSET_CAP_METERS, with a damped,
// speed-capped velocity — so `pos = base + wobble + wells + collOffset` stays inside the
// radius+1400 m mine slack no matter how long a pile-up lasts. Gameplay reads `base`; only
// the renderer reads `pos`. The CPU executable spec is ../collide-cpu.ts; the on-device
// gate (../verify-gpu.ts) compares GPU dp/dv against it on a synthetic dense belt.
//
// GRID (§4.1): 64³ cells of 768 m over a ship-cell-snapped near-window (~49 km). The FIELD
// id-space (100³, cellsPerAxis=100) and this COLLISION grid (64³) are DIFFERENT grids —
// the documented off-by-one trap.

import * as THREE from "three/webgpu";
import {
  atomicLoad,
  float,
  Fn,
  If,
  instancedArray,
  instanceIndex,
  int,
  ivec3,
  Loop,
  normalize,
  uint,
  uniform,
  vec3,
  vec4,
} from "three/tsl";

import { MAX_RESIDENT, pos } from "../buffers";
import {
  COLLISION_CELL_METERS,
  COLLISION_DAMPING,
  COLLISION_GRID_AXIS,
  COLLISION_MAX_SPEED,
  COLLISION_OFFSET_CAP_METERS,
  COLLISION_WINDOW_METERS,
  RESTITUTION,
} from "../collide-cpu";
import { makeBinnerKernels, type BinnerKernels, type ComputeKernel } from "./binner";

const WORKGROUP = 256;
const G = COLLISION_GRID_AXIS ** 3;

// Persistent per-slot collision state (vec4 SoA, §2.1): accumulated displacement (meters)
// and cosmetic velocity (m/s). GPU-owned; the ring streamer zeroes recycled slots via the
// CPU backing + update ranges (collide pipeline reads happen after the upload).
export const collOffset = instancedArray(MAX_RESIDENT, "vec4");
export const collVel = instancedArray(MAX_RESIDENT, "vec4");

// Deferred-apply accumulators (§2.4): each lane writes ONLY its own dp[i]/dv[i].
const dp = instancedArray(MAX_RESIDENT, "vec4");
const dv = instancedArray(MAX_RESIDENT, "vec4");

// Ship-cell-snapped origin of the collision near-window (world meters), updated per frame.
export const gridOrigin = uniform(new THREE.Vector3());
// Fixed timestep seconds for the apply integration (§4.4: fixed dt, externally clamped).
export const collisionDt = uniform(1 / 60);

// Snap the window so the ship sits at its center, aligned to collision cells (CPU helper).
export function snapGridOrigin(shipMeters: { x: number; y: number; z: number }): {
  x: number;
  y: number;
  z: number;
} {
  const half = COLLISION_WINDOW_METERS / 2;
  const snap = (v: number): number =>
    Math.floor((v - half) / COLLISION_CELL_METERS) * COLLISION_CELL_METERS;
  return { x: snap(shipMeters.x), y: snap(shipMeters.y), z: snap(shipMeters.z) };
}

export type CollisionPipeline = {
  binner: BinnerKernels;
  narrow: ComputeKernel;
  apply: ComputeKernel;
  // The deferred accumulators, exposed for the on-device gate's readback.
  dp: ReturnType<typeof instancedArray>;
  dv: ReturnType<typeof instancedArray>;
  // The per-frame dispatch list, in order (§3.3: submit all via renderer.compute, never
  // computeAsync in the hot loop).
  dispatches: ComputeKernel[];
  // Split lists (§1.3/§6.3): the froxel sun-shadow march READS the collision world grid,
  // so the binner half runs EVERY frame (the grid must exist even when nothing collides);
  // the resolve half (narrow + apply) keeps the §3.4 Nc==0 gate.
  binnerDispatches: ComputeKernel[];
  resolveDispatches: ComputeKernel[];
};

export function makeCollisionPipeline(): CollisionPipeline {
  // Inlined world-grid cell index (§2.3): cell coords clamped to the window. Only called
  // for ACTIVE items (inside the window), so the clamp never actually bites.
  const cellCoordsOf = (i: ReturnType<typeof uint>): ReturnType<typeof ivec3> => {
    const p = pos.element(i);
    return ivec3(p.xyz.sub(gridOrigin).div(float(COLLISION_CELL_METERS)).floor()).clamp(
      int(0),
      int(COLLISION_GRID_AXIS - 1),
    );
  };
  const packCell = (c: ReturnType<typeof ivec3>): ReturnType<typeof uint> =>
    uint(c.x)
      .mul(uint(COLLISION_GRID_AXIS * COLLISION_GRID_AXIS))
      .add(uint(c.y).mul(uint(COLLISION_GRID_AXIS)))
      .add(uint(c.z));

  // Live = real rock (radius > 0) AND inside the near-window.
  const itemActive = (i: ReturnType<typeof uint>) => {
    const p = pos.element(i);
    const rel = p.xyz.sub(gridOrigin);
    return p.w
      .greaterThan(float(0))
      .and(rel.x.greaterThanEqual(float(0)))
      .and(rel.y.greaterThanEqual(float(0)))
      .and(rel.z.greaterThanEqual(float(0)))
      .and(rel.x.lessThan(float(COLLISION_WINDOW_METERS)))
      .and(rel.y.lessThan(float(COLLISION_WINDOW_METERS)))
      .and(rel.z.lessThan(float(COLLISION_WINDOW_METERS)));
  };

  const binner = makeBinnerKernels(G, MAX_RESIDENT, (i) => packCell(cellCoordsOf(i)), itemActive);
  const { cellCount, cellStart, sortedItems } = binner.buffers;

  // Narrow phase (§4.2): EVERY lane scans the 27 neighbor cells of its own cell and
  // accumulates ONLY its own dp[i]/dv[i] — mirrors collide-cpu.narrowPhaseCPU pair-for-pair.
  const narrow = Fn(() => {
    If(instanceIndex.lessThan(uint(MAX_RESIDENT)), () => {
      const dpAcc = vec3(0).toVar();
      const dvAcc = vec3(0).toVar();
      If(itemActive(instanceIndex), () => {
        const pI = pos.element(instanceIndex);
        const rI = pI.w;
        const vI = collVel.element(instanceIndex).xyz;
        const cell = cellCoordsOf(instanceIndex).toVar();
        // ONE flat loop over the 27 neighbor offsets. Nested TSL Loops reuse the same WGSL
        // loop-variable name and WGSL shadowing silently corrupts cross-scope references
        // (device-caught: dp came back subtly wrong) — so every value derived from the
        // outer loop variable is materialized into its own var BEFORE the inner items loop.
        Loop({ start: uint(0), end: uint(27), type: "uint", condition: "<" }, ({ i: ni }) => {
          const nIdx = uint(ni).toVar();
          const offset = ivec3(
            int(nIdx.div(uint(9))).sub(int(1)),
            int(nIdx.div(uint(3)).mod(uint(3))).sub(int(1)),
            int(nIdx.mod(uint(3))).sub(int(1)),
          );
          const n = cell.add(offset).toVar();
          const inGrid = n.x
            .greaterThanEqual(int(0))
            .and(n.y.greaterThanEqual(int(0)))
            .and(n.z.greaterThanEqual(int(0)))
            .and(n.x.lessThan(int(COLLISION_GRID_AXIS)))
            .and(n.y.lessThan(int(COLLISION_GRID_AXIS)))
            .and(n.z.lessThan(int(COLLISION_GRID_AXIS)));
          If(inGrid, () => {
            const cellIdx = packCell(n).toVar();
            // Materialize the loop bounds (an atomicLoad/storage read as a raw Loop `end`
            // emits empty WGSL — device-caught).
            const start = cellStart.element(cellIdx).toVar();
            const occupancy = uint(atomicLoad(cellCount.element(cellIdx))).toVar();
            Loop({ start: uint(0), end: occupancy, type: "uint", condition: "<" }, ({ i: k }) => {
              const j = sortedItems.element(start.add(uint(k))).toVar();
              If(j.notEqual(instanceIndex), () => {
                const pJ = pos.element(j);
                const delta = pJ.xyz.sub(pI.xyz).toVar();
                const dist = delta.length().toVar();
                const sumR = rI.add(pJ.w).toVar();
                If(dist.lessThan(sumR).and(dist.greaterThan(float(1e-3))), () => {
                  const normal = delta.div(dist).toVar();
                  const penetration = sumR.sub(dist);
                  dpAcc.subAssign(normal.mul(penetration.mul(0.5)));
                  const vRel = collVel.element(j).xyz.sub(vI);
                  const vn = vRel.dot(normal).toVar();
                  If(vn.lessThan(float(0)), () => {
                    dvAcc.addAssign(normal.mul(vn.mul(1 + RESTITUTION).mul(0.5)));
                  });
                });
              });
            });
          });
        });
      });
      dp.element(instanceIndex).assign(vec4(dpAcc, 0));
      dv.element(instanceIndex).assign(vec4(dvAcc, 0));
    });
  })().compute(MAX_RESIDENT, [WORKGROUP]);

  // Apply (§4.2 apply pass, with the cosmetic-tier caps): mirrors collide-cpu.stepOffsetsCPU.
  const apply = Fn(() => {
    If(instanceIndex.lessThan(uint(MAX_RESIDENT)), () => {
      const radius = pos.element(instanceIndex).w;
      If(radius.greaterThan(float(0)), () => {
        const vel = collVel
          .element(instanceIndex)
          .xyz.add(dv.element(instanceIndex).xyz)
          .mul(COLLISION_DAMPING)
          .toVar();
        const speed = vel.length();
        If(speed.greaterThan(float(COLLISION_MAX_SPEED)), () => {
          vel.assign(normalize(vel).mul(float(COLLISION_MAX_SPEED)));
        });
        collVel.element(instanceIndex).assign(vec4(vel, 0));

        const offset = collOffset
          .element(instanceIndex)
          .xyz.add(dp.element(instanceIndex).xyz)
          .add(vel.mul(collisionDt))
          .toVar();
        const mag = offset.length();
        If(mag.greaterThan(float(COLLISION_OFFSET_CAP_METERS)), () => {
          offset.assign(normalize(offset).mul(float(COLLISION_OFFSET_CAP_METERS)));
        });
        collOffset.element(instanceIndex).assign(vec4(offset, 0));
      }).Else(() => {
        // Dead slot: drop any stale state so a recycled slot starts at rest.
        collOffset.element(instanceIndex).assign(vec4(0));
        collVel.element(instanceIndex).assign(vec4(0));
      });
    });
  })().compute(MAX_RESIDENT, [WORKGROUP]);

  const binnerDispatches = [
    binner.clearCounts,
    binner.count,
    binner.scanPerBlock,
    binner.scanBlockSums,
    binner.addBlockOffsets,
    binner.initCursor,
    binner.scatter,
  ];
  const resolveDispatches = [narrow, apply];
  const dispatches = [...binnerDispatches, ...resolveDispatches];

  return { binner, narrow, apply, dp, dv, dispatches, binnerDispatches, resolveDispatches };
}
