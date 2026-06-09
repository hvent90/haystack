// Shared count -> scan -> scatter binner — TSL / WebGPU compute kernels
// (docs/gpu-asteroids-architecture.md §2.3, §3.1 dispatches 8-13, §4.1, §7 step 5).
//
// ============================================================================================
// GPU EXECUTION IS UNVERIFIED. There is NO WebGPU in this environment (no node binding;
// Playwright Chromium exposes no navigator.gpu), so these kernels CANNOT be executed or
// validated here. They are written to TYPECHECK against three@0.177 TSL and to mirror, pass
// for pass, the CPU reference in ../binner-cpu.ts. THE CPU MIRROR (binner-cpu.ts) IS THE
// EXECUTABLE SPEC and is what the parity test (tests/integration/gpu-binner-parity.test.ts)
// validates. When a WebGPU device is available, a GPU-vs-CPU parity gate must be added before
// anything depends on these kernels.
// ============================================================================================
//
// The binner is parameterized over a compile-time-inlined `cellIndexOf(item) -> uint` TSL Fn
// (§2.3 mandates inlining per instantiation, NOT runtime indirection — runtime indirection
// would tax the collision narrow-phase hot path). `makeBinnerKernels` takes a `cellIndexOf`
// builder and bakes it directly into the `count` and `scatter` kernels.
//
// Three-phase work-efficient scan (mirrors binner-cpu.exclusiveScanTiled, doc dispatches
// 10/11/12), using a `blockSums` storage buffer + a `workgroupArray` scratchpad + a
// `storageBarrier` between sweeps. Block size ELEMENTS_PER_BLOCK = 1024 (matches the CPU
// mirror) so numBlocks <= ELEMENTS_PER_BLOCK and phase B scans blockSums in a single block.
//
// The per-block scan is the Blelloch up-sweep / down-sweep (work-efficient), structurally
// identical to binner-cpu.blellochExclusiveScanBlock: one workgroup per block, each of the
// WORKGROUP lanes strides over the ELEMENTS_PER_BLOCK shared-memory cells, with a storageBarrier
// between every sweep step.

import {
  atomicAdd,
  compute,
  Fn,
  If,
  instancedArray,
  instanceIndex,
  Loop,
  storageBarrier,
  uint,
  workgroupArray,
  workgroupId,
} from "three/tsl";

import { ELEMENTS_PER_BLOCK, MAX_GRID, WORKGROUP } from "../binner-cpu";

// Strided passes per lane to cover ELEMENTS_PER_BLOCK shared-memory cells with WORKGROUP lanes.
const STRIDES_PER_LANE = ELEMENTS_PER_BLOCK / WORKGROUP; // 1024 / 256 = 4
// Number of Blelloch sweep steps per block = log2(ELEMENTS_PER_BLOCK).
const LOG2_ELEMENTS_PER_BLOCK = Math.log2(ELEMENTS_PER_BLOCK); // 10

// A builder that emits the inlined cell index for the body/item at `itemIndex`. It MUST return a
// TSL uint node in [0, G). Each binner instantiation bakes its own `cellIndexOf` (world-space
// collision grid now; view-space froxel grid later) — §2.3 / §6.2 "shared kernels, separate
// instances".
export type CellIndexOf = (itemIndex: ReturnType<typeof uint>) => ReturnType<typeof uint>;

export type BinnerBuffers = {
  // per-cell occupancy histogram (atomic uint), length G. Zeroed by clearCounts.
  cellCount: ReturnType<typeof instancedArray>;
  // exclusive prefix-sum of cellCount (uint), length G. Doubles as the atomic scatter cursor.
  cellStart: ReturnType<typeof instancedArray>;
  // item ids grouped by cell (uint), length maxItems.
  sortedItems: ReturnType<typeof instancedArray>;
  // per-block partial sums for the two-level scan (uint), length numBlocks.
  blockSums: ReturnType<typeof instancedArray>;
};

// A dispatchable compute node (the return of `Fn(...)().compute(...)` === `compute(...)`).
export type ComputeKernel = ReturnType<typeof compute>;

export type BinnerKernels = {
  buffers: BinnerBuffers;
  // dispatch 8: zero cellCount (one lane per cell).
  clearCounts: ComputeKernel;
  // dispatch 9: atomicAdd(cellCount[cellIndexOf(i)], 1) (one lane per item).
  count: ComputeKernel;
  // dispatch 10: per-block exclusive scan; write block total into blockSums (one block/group).
  scanPerBlock: ComputeKernel;
  // dispatch 11: exclusive-scan blockSums in a single block.
  scanBlockSums: ComputeKernel;
  // dispatch 12: add each block's scanned offset to every element of the block.
  addBlockOffsets: ComputeKernel;
  // dispatch 13: scatter — atomicAdd(cellStart[c],1) cursor, write item id into sortedItems.
  scatter: ComputeKernel;
};

// Build a fully-instantiated set of binner kernels for grid size `G`, `numItems` items, and an
// inlined `cellIndexOf`. Mirrors binner-cpu.binCPU structure exactly.
export function makeBinnerKernels(
  G: number,
  numItems: number,
  cellIndexOf: CellIndexOf,
): BinnerKernels {
  if (G <= 0 || G > MAX_GRID) {
    throw new Error(`makeBinnerKernels: G=${G} must be in (0, ${MAX_GRID}].`);
  }
  const numBlocks = Math.ceil(G / ELEMENTS_PER_BLOCK);
  if (numBlocks > ELEMENTS_PER_BLOCK) {
    throw new Error(
      `makeBinnerKernels: numBlocks=${numBlocks} > ELEMENTS_PER_BLOCK=${ELEMENTS_PER_BLOCK}; ` +
        `phase B requires a single-block blockSums scan (G <= ${MAX_GRID}).`,
    );
  }

  // --- buffers (§2.3). cellCount is atomic; the rest are plain uint. ---
  const cellCount = instancedArray(G, "uint").toAtomic();
  const cellStart = instancedArray(G, "uint");
  const sortedItems = instancedArray(Math.max(numItems, 1), "uint");
  const blockSums = instancedArray(numBlocks, "uint");

  const buffers: BinnerBuffers = { cellCount, cellStart, sortedItems, blockSums };

  // dispatch 8 — clearCounts: zero every cell (one lane per cell).
  const clearCounts = Fn(() => {
    cellCount.element(instanceIndex).assign(uint(0));
  })().compute(G, [WORKGROUP]);

  // dispatch 9 — count: atomicAdd(cellCount[cellIndexOf(i)], 1) (one lane per item).
  const count = Fn(() => {
    const c = cellIndexOf(instanceIndex);
    atomicAdd(cellCount.element(c), uint(1));
  })().compute(numItems, [WORKGROUP]);

  // Shared workgroup scratchpad for the Blelloch in-block sweep (ELEMENTS_PER_BLOCK cells).
  const scratch = workgroupArray("uint", ELEMENTS_PER_BLOCK);

  // dispatch 10 — scanPerBlock: per-block exclusive Blelloch scan of cellCount -> cellStart;
  // record each block total into blockSums. ONE workgroup per block; `lid` strides the block.
  const scanPerBlock = Fn(() => {
    const block = workgroupId.x;
    const lid = uint(instanceIndex.mod(uint(WORKGROUP)));
    const blockBase = block.mul(uint(ELEMENTS_PER_BLOCK));

    // Load this block's cells into shared memory (strided), clamping past-G cells to 0 (the
    // additive identity, so padding does not perturb the scan — mirrors the CPU power-of-two pad).
    Loop({ start: uint(0), end: uint(STRIDES_PER_LANE), type: "uint", condition: "<" }, ({ i }) => {
      const local = lid.add(uint(i).mul(uint(WORKGROUP)));
      const gidx = blockBase.add(local);
      If(gidx.lessThan(uint(G)), () => {
        scratch.element(local).assign(cellCount.element(gidx));
      }).Else(() => {
        scratch.element(local).assign(uint(0));
      });
    });
    storageBarrier();

    // Up-sweep (reduce): for stride = 1,2,4,...,N/2, combine pairs. Each lane handles the indices
    // i = stride*2-1, stride*2-1 + stride*2, ... that fall in its strided range.
    const upStride = uint(1).toVar();
    Loop(
      { start: uint(0), end: uint(LOG2_ELEMENTS_PER_BLOCK), type: "uint", condition: "<" },
      () => {
        const stride = upStride.toVar();
        Loop(
          { start: uint(0), end: uint(STRIDES_PER_LANE), type: "uint", condition: "<" },
          ({ i }) => {
            // Global tree index this lane owns on this pass.
            const k = lid.add(uint(i).mul(uint(WORKGROUP)));
            const idx = k
              .add(uint(1))
              .mul(stride.mul(uint(2)))
              .sub(uint(1));
            If(idx.lessThan(uint(ELEMENTS_PER_BLOCK)), () => {
              const add = scratch.element(idx.sub(stride));
              scratch.element(idx).addAssign(add);
            });
          },
        );
        storageBarrier();
        upStride.assign(stride.mul(uint(2)));
      },
    );

    // Lane 0 records the block total (root of the reduce) into blockSums, then clears the root
    // for the exclusive down-sweep.
    If(lid.equal(uint(0)), () => {
      blockSums.element(block).assign(scratch.element(uint(ELEMENTS_PER_BLOCK - 1)));
      scratch.element(uint(ELEMENTS_PER_BLOCK - 1)).assign(uint(0));
    });
    storageBarrier();

    // Down-sweep: for stride = N/2,...,2,1 swap-and-add to produce the exclusive scan.
    const downStride = uint(ELEMENTS_PER_BLOCK / 2).toVar();
    Loop(
      { start: uint(0), end: uint(LOG2_ELEMENTS_PER_BLOCK), type: "uint", condition: "<" },
      () => {
        const stride = downStride.toVar();
        Loop(
          { start: uint(0), end: uint(STRIDES_PER_LANE), type: "uint", condition: "<" },
          ({ i }) => {
            const k = lid.add(uint(i).mul(uint(WORKGROUP)));
            const idx = k
              .add(uint(1))
              .mul(stride.mul(uint(2)))
              .sub(uint(1));
            If(idx.lessThan(uint(ELEMENTS_PER_BLOCK)), () => {
              const left = idx.sub(stride);
              const t = scratch.element(left).toVar();
              scratch.element(left).assign(scratch.element(idx));
              scratch.element(idx).addAssign(t);
            });
          },
        );
        storageBarrier();
        downStride.assign(stride.div(uint(2)));
      },
    );

    // Write the exclusive scan back into cellStart for in-range cells.
    Loop({ start: uint(0), end: uint(STRIDES_PER_LANE), type: "uint", condition: "<" }, ({ i }) => {
      const local = lid.add(uint(i).mul(uint(WORKGROUP)));
      const gidx = blockBase.add(local);
      If(gidx.lessThan(uint(G)), () => {
        cellStart.element(gidx).assign(scratch.element(local));
      });
    });
  })().compute(numBlocks * WORKGROUP, [WORKGROUP]);

  // dispatch 11 — scanBlockSums: exclusive-scan blockSums in a single block (numBlocks <=
  // ELEMENTS_PER_BLOCK). One workgroup; sequential prefix on lane 0 (numBlocks <= 1024, cheap and
  // matches the CPU mirror's single-block phase B).
  const scanBlockSums = Fn(() => {
    const lid = uint(instanceIndex.mod(uint(WORKGROUP)));
    If(lid.equal(uint(0)), () => {
      const acc = uint(0).toVar();
      Loop({ start: uint(0), end: uint(numBlocks), type: "uint", condition: "<" }, ({ i }) => {
        const idx = uint(i);
        const v = blockSums.element(idx).toVar();
        const prev = acc.toVar();
        blockSums.element(idx).assign(prev);
        acc.assign(prev.add(v));
      });
    });
  })().compute(WORKGROUP, [WORKGROUP]);

  // dispatch 12 — addBlockOffsets: add each block's scanned offset (blockSums[block]) to every
  // element of cellStart in that block (one lane per cell).
  const addBlockOffsets = Fn(() => {
    const gidx = instanceIndex;
    If(gidx.lessThan(uint(G)), () => {
      const block = gidx.div(uint(ELEMENTS_PER_BLOCK));
      const offset = blockSums.element(block);
      cellStart.element(gidx).addAssign(offset);
    });
  })().compute(G, [WORKGROUP]);

  // dispatch 13 — scatter: cellStart doubles as the atomic write cursor (§2.3). Each item bumps
  // its cell's cursor with atomicAdd and writes its id into sortedItems at the returned slot.
  // NOTE: this consumes cellStart; a caller that needs the scan offsets afterward must keep a
  // copy from before scatter (the CPU mirror returns the pre-scatter scan; see binCPU). For this
  // to compile, cellStart is atomically incremented — under WebGPU a separate atomic view of the
  // same buffer is used; here the same node is incremented to express the cursor semantics.
  const scatter = Fn(() => {
    const i = instanceIndex;
    const c = cellIndexOf(i);
    const slot = atomicAdd(cellStart.element(c), uint(1));
    sortedItems.element(slot).assign(i);
  })().compute(numItems, [WORKGROUP]);

  return {
    buffers,
    clearCounts,
    count,
    scanPerBlock,
    scanBlockSums,
    addBlockOffsets,
    scatter,
  };
}
