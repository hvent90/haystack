// CPU MIRROR of the shared count -> scan -> scatter binner
// (docs/gpu-asteroids-architecture.md §2.3, §4.1, §7 step 5).
//
// THIS FILE IS THE EXECUTABLE SPEC. There is no WebGPU in this environment, so the TSL/WebGPU
// kernels in kernels/binner.ts cannot be executed here. This module reimplements the EXACT same
// tiled count -> three-phase work-efficient scan -> scatter algorithm on the CPU so the tiling,
// block-sum, and offset-add logic the GPU kernel performs is fully testable headless
// (tests/integration/gpu-binner-parity.test.ts). The GPU kernel mirrors this structure
// pass-for-pass; this is what validates that structure.
//
// THREE-PHASE TILED SCAN (matches doc §3.1 dispatches 10/11/12):
//   phase A (dispatch 10): per-block exclusive scan (Blelloch up/down sweep), each block's total
//                          recorded into blockSums.
//   phase B (dispatch 11): exclusive-scan blockSums in a SINGLE block. This is only valid when
//                          numBlocks <= ELEMENTS_PER_BLOCK, i.e. G <= ELEMENTS_PER_BLOCK^2
//                          (~1.05M). That covers the collision grid (G = 64^3 = 262144,
//                          numBlocks = 256) and the froxel grid (G = 160*90*64 = 921600,
//                          numBlocks = 900 <= 1024). Both block-sums arrays fit one block.
//   phase C (dispatch 12): add each block's scanned offset to every element in that block.

// GPU workgroup size (lanes per workgroup). Mirrors the TSL kernel dispatch granularity.
export const WORKGROUP = 256;

// Elements processed per scan block. Chosen so numBlocks = ceil(G / 1024) is itself
// <= ELEMENTS_PER_BLOCK for every supported G, letting phase B scan blockSums in a single
// block (the clean 3-phase structure). Requires G <= ELEMENTS_PER_BLOCK^2 (= 1_048_576):
//   collision: G = 64^3   = 262144  -> numBlocks = 256  (<= 1024) ✓
//   froxel:    G = 160*90*64 = 921600 -> numBlocks = 900 (<= 1024) ✓
export const ELEMENTS_PER_BLOCK = 1024;

// Largest grid size for which phase B can scan blockSums in a single block.
export const MAX_GRID = ELEMENTS_PER_BLOCK * ELEMENTS_PER_BLOCK; // 1_048_576

function numBlocksFor(length: number): number {
  return Math.ceil(length / ELEMENTS_PER_BLOCK);
}

// Work-efficient exclusive scan of a SINGLE block (Blelloch up-sweep / down-sweep) over the
// half-open slice [start, end) of `data`, written in place. Returns the block total (the sum
// of all original elements in the slice), which the multi-block driver records into blockSums.
//
// Blelloch operates on a power-of-two array; we pad the working span to the next power of two
// with zeros (zeros are the identity for +, so they do not affect the scan of real elements).
function blellochExclusiveScanBlock(data: Uint32Array, start: number, end: number): number {
  const n = end - start;
  if (n <= 0) return 0;

  // Pad to next power of two.
  let size = 1;
  while (size < n) size *= 2;

  const tmp = new Uint32Array(size); // zero-filled tail acts as identity padding
  for (let i = 0; i < n; i += 1) tmp[i] = data[start + i]!;

  // The total is needed before the down-sweep clobbers the last slot; capture via reduction
  // (also obtainable as scan[last] + original[last], but an explicit sum is unambiguous).
  let total = 0;
  for (let i = 0; i < n; i += 1) total = (total + tmp[i]!) >>> 0;

  // Up-sweep (reduce): build partial sums in a balanced tree.
  for (let stride = 1; stride < size; stride *= 2) {
    for (let i = stride * 2 - 1; i < size; i += stride * 2) {
      tmp[i] = (tmp[i]! + tmp[i - stride]!) >>> 0;
    }
  }

  // Clear the last element (exclusive-scan identity at the root), then down-sweep.
  tmp[size - 1] = 0;
  for (let stride = size / 2; stride >= 1; stride /= 2) {
    for (let i = stride * 2 - 1; i < size; i += stride * 2) {
      const left = i - stride;
      const t = tmp[left]!;
      tmp[left] = tmp[i]!;
      tmp[i] = (tmp[i]! + t) >>> 0;
    }
  }

  for (let i = 0; i < n; i += 1) data[start + i] = tmp[i]!;
  return total >>> 0;
}

// THREE-PHASE work-efficient exclusive scan of `counts` (NOT a trivial loop). Mirrors the GPU
// kernel's dispatches 10/11/12 exactly so the parity test validates the tiling + block-offset
// logic, not just a scan oracle.
//
//   phase A: per-block Blelloch exclusive scan; record each block total into blockSums.
//   phase B: exclusive-scan blockSums in a single block (numBlocks <= ELEMENTS_PER_BLOCK).
//   phase C: add the scanned block offset to every element of that block.
//
// Returns a fresh Uint32Array (input is not mutated).
export function exclusiveScanTiled(counts: Uint32Array): Uint32Array {
  const G = counts.length;
  const numBlocks = numBlocksFor(G);
  if (numBlocks > ELEMENTS_PER_BLOCK) {
    throw new Error(
      `exclusiveScanTiled: G=${G} requires numBlocks=${numBlocks} > ELEMENTS_PER_BLOCK=` +
        `${ELEMENTS_PER_BLOCK}; G must be <= ${MAX_GRID} for the single-block phase-B scan.`,
    );
  }

  const out = new Uint32Array(counts); // work copy; scanned in place below
  const blockSums = new Uint32Array(numBlocks);

  // phase A — per-block exclusive scan; capture each block's total.
  for (let b = 0; b < numBlocks; b += 1) {
    const start = b * ELEMENTS_PER_BLOCK;
    const end = Math.min(start + ELEMENTS_PER_BLOCK, G);
    blockSums[b] = blellochExclusiveScanBlock(out, start, end);
  }

  // phase B — exclusive-scan blockSums in a single block.
  blellochExclusiveScanBlock(blockSums, 0, numBlocks);

  // phase C — add each block's scanned offset to every element of the block.
  for (let b = 0; b < numBlocks; b += 1) {
    const offset = blockSums[b]!;
    if (offset === 0) continue;
    const start = b * ELEMENTS_PER_BLOCK;
    const end = Math.min(start + ELEMENTS_PER_BLOCK, G);
    for (let i = start; i < end; i += 1) out[i] = (out[i]! + offset) >>> 0;
  }

  return out;
}

// The obvious O(G) exclusive-scan reference, used only to validate exclusiveScanTiled in the
// parity test. Single running accumulator, no tiling.
export function naiveExclusiveScan(counts: Uint32Array): Uint32Array {
  const out = new Uint32Array(counts.length);
  let acc = 0;
  for (let i = 0; i < counts.length; i += 1) {
    out[i] = acc >>> 0;
    acc = (acc + counts[i]!) >>> 0;
  }
  return out;
}

export type BinResult = {
  // per-cell occupancy histogram (the `count` pass result), length G.
  cellCount: Uint32Array;
  // exclusive prefix-sum of cellCount, length G. This is the SCAN RESULT, restored after
  // scatter consumed it as the write cursor (see §2.3 + note below). Callers use THIS.
  cellStart: Uint32Array;
  // item ids grouped by cell; a permutation of [0..items.length). length = items.length.
  sortedItems: Uint32Array;
};

// Full count -> scan(tiled) -> scatter mirror (doc §2.3 / §4.1), exercising the three-phase
// scan above.
//
// `cellIndexOf(item, itemIndex) -> uint in [0, G)` is the inlined-per-instantiation cell map;
// the GPU kernel inlines the equivalent TSL Fn (§2.3 forbids runtime indirection on the hot
// path). On the CPU it is an ordinary callback.
//
// SCATTER CURSOR SEMANTICS (§2.3: "cellStart doubles as the atomic write cursor during
// scatter"): scatter starts from a COPY of the exclusive scan and increments it per write
// (mirroring the GPU `atomicAdd(cellStart[c], 1)`), so after scatter that cursor copy has been
// advanced to scan[c] + cellCount[c] for every cell. We therefore return the PRE-scatter scan
// (`cellStart`) so callers get usable cell offsets; the mutated cursor is discarded. Equivalent
// to "restore cellStart to the scan result after scatter".
export function binCPU<T>(
  items: readonly T[],
  G: number,
  cellIndexOf: (item: T, itemIndex: number) => number,
): BinResult {
  if (G <= 0 || G > MAX_GRID) {
    throw new Error(`binCPU: G=${G} must be in (0, ${MAX_GRID}].`);
  }

  // --- count pass: per-cell histogram (GPU: atomicAdd(cellCount[c], 1)). ---
  const cellCount = new Uint32Array(G);
  for (let i = 0; i < items.length; i += 1) {
    const c = cellIndexOf(items[i]!, i);
    if (c < 0 || c >= G) {
      throw new Error(`binCPU: cellIndexOf returned ${c} out of range [0, ${G}) for item ${i}.`);
    }
    cellCount[c] = (cellCount[c]! + 1) >>> 0;
  }

  // --- scan pass (THREE-PHASE TILED): exclusive prefix-sum of cellCount. ---
  const cellStart = exclusiveScanTiled(cellCount);

  // --- scatter pass: cellStart doubles as the write cursor (GPU: atomicAdd(cellStart[c], 1)). ---
  // Work on a COPY so the returned cellStart stays the scan result.
  const cursor = new Uint32Array(cellStart);
  const sortedItems = new Uint32Array(items.length);
  for (let i = 0; i < items.length; i += 1) {
    const c = cellIndexOf(items[i]!, i);
    const slot = cursor[c]!;
    cursor[c] = (slot + 1) >>> 0;
    sortedItems[slot] = i >>> 0; // store the item index, as the GPU stores the slot id
  }

  return { cellCount, cellStart, sortedItems };
}
