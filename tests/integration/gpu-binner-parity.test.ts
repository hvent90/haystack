import { describe, expect, test } from "bun:test";

import {
  binCPU,
  ELEMENTS_PER_BLOCK,
  exclusiveScanTiled,
  naiveExclusiveScan,
  WORKGROUP,
} from "../../src/client/eve/gpu/binner-cpu";

// docs/gpu-asteroids-architecture.md §7 step 5 — the Blelloch prefix-sum binner spike.
//
// There is NO WebGPU in this environment, so the TSL kernels (src/client/eve/gpu/kernels/
// binner.ts) cannot be executed. binner-cpu.ts is a CPU MIRROR of the EXACT tiled
// count -> three-phase scan -> scatter algorithm those kernels implement; this test validates
// that mirror (the executable spec). The three-phase tiled scan is checked against an
// independent naive O(G) reference, and the full binCPU is checked for the scatter/permutation
// and exclusive-scan invariants the GPU kernel must also satisfy.

// Deterministic 32-bit LCG (Numerical Recipes constants). NOT Math.random, so the histograms
// are byte-reproducible across runs.
function makeLCG(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
}

// Collision grid (64^3) and two other sizes that exercise the tiling: 1024 (exactly one block),
// 70000 (a partial last block), and 921600 (the froxel grid, 900 blocks).
const COLLISION_G = 64 * 64 * 64; // 262144
const G_VALUES = [1024, 70000, COLLISION_G, 160 * 90 * 64];

function assertScansEqual(counts: Uint32Array, label: string): void {
  const tiled = exclusiveScanTiled(counts);
  const naive = naiveExclusiveScan(counts);
  expect(tiled.length).toBe(naive.length);
  let firstMismatch = -1;
  for (let i = 0; i < tiled.length; i += 1) {
    if (tiled[i] !== naive[i]) {
      firstMismatch = i;
      break;
    }
  }
  if (firstMismatch !== -1) {
    throw new Error(
      `${label}: tiled scan != naive scan at index ${firstMismatch} ` +
        `(tiled=${tiled[firstMismatch]}, naive=${naive[firstMismatch]})`,
    );
  }
  expect(firstMismatch).toBe(-1);
}

describe("GPU binner parity — three-phase tiled scan equals the naive reference (§7 step 5)", () => {
  test("block-size invariants: numBlocks <= ELEMENTS_PER_BLOCK for every supported G", () => {
    expect(WORKGROUP).toBe(256);
    expect(ELEMENTS_PER_BLOCK).toBe(1024);
    for (const G of G_VALUES) {
      const numBlocks = Math.ceil(G / ELEMENTS_PER_BLOCK);
      expect(numBlocks).toBeLessThanOrEqual(ELEMENTS_PER_BLOCK);
    }
  });

  test("all-zeros histogram scans to all-zeros at every G", () => {
    for (const G of G_VALUES) {
      const counts = new Uint32Array(G); // all zero
      assertScansEqual(counts, `all-zeros G=${G}`);
      const tiled = exclusiveScanTiled(counts);
      for (let i = 0; i < G; i += 1) expect(tiled[i]).toBe(0);
    }
  });

  test("all-ones histogram scans to the identity ramp [0,1,2,...] at every G", () => {
    for (const G of G_VALUES) {
      const counts = new Uint32Array(G).fill(1);
      assertScansEqual(counts, `all-ones G=${G}`);
      const tiled = exclusiveScanTiled(counts);
      expect(tiled[0]).toBe(0);
      expect(tiled[1]).toBe(1);
      expect(tiled[G - 1]).toBe(G - 1);
    }
  });

  test("single hot cell (only cell 0) at every G", () => {
    for (const G of G_VALUES) {
      const counts = new Uint32Array(G);
      counts[0] = 7;
      assertScansEqual(counts, `hot-cell-0 G=${G}`);
      const tiled = exclusiveScanTiled(counts);
      expect(tiled[0]).toBe(0);
      // every later cell sits past the 7 items in cell 0.
      expect(tiled[1]).toBe(7);
      expect(tiled[G - 1]).toBe(7);
    }
  });

  test("only the LAST cell is hot at every G", () => {
    for (const G of G_VALUES) {
      const counts = new Uint32Array(G);
      counts[G - 1] = 13;
      assertScansEqual(counts, `hot-last-cell G=${G}`);
      const tiled = exclusiveScanTiled(counts);
      expect(tiled[0]).toBe(0);
      expect(tiled[G - 1]).toBe(0); // nothing before the last cell
    }
  });

  test("a couple of mid hot cells (spanning block boundaries) at every G", () => {
    for (const G of G_VALUES) {
      const counts = new Uint32Array(G);
      // Place hot cells deliberately inside different blocks to exercise block offsets.
      const a = Math.floor(G * 0.25);
      const b = Math.floor(G * 0.6);
      counts[a] = 5;
      counts[b] = 9;
      assertScansEqual(counts, `mid-hot G=${G}`);
      const tiled = exclusiveScanTiled(counts);
      expect(tiled[a]).toBe(0);
      expect(tiled[a + 1]).toBe(5);
      expect(tiled[b]).toBe(5);
      expect(tiled[b + 1]).toBe(14);
      expect(tiled[G - 1]).toBe(14);
    }
  });

  test("seeded-random histograms (deterministic LCG) at every G", () => {
    for (const G of G_VALUES) {
      const rng = makeLCG(0x1234_5678 ^ G);
      const counts = new Uint32Array(G);
      for (let i = 0; i < G; i += 1) counts[i] = rng() % 4; // 0..3 occupants per cell
      assertScansEqual(counts, `random G=${G}`);
    }
  });

  test("exclusiveScanTiled exercises real tiling: a 1024-cell partial-last-block case", () => {
    // 70000 = 68 full blocks + 1 partial (704 cells). Make the partial block hot to prove phase
    // C adds the right offset to a non-full final block.
    const G = 70000;
    const counts = new Uint32Array(G);
    counts[100] = 3; // block 0
    counts[68 * ELEMENTS_PER_BLOCK + 10] = 4; // partial last block (index 69642 < 70000)
    assertScansEqual(counts, `partial-last-block G=${G}`);
    const tiled = exclusiveScanTiled(counts);
    expect(tiled[68 * ELEMENTS_PER_BLOCK + 10]).toBe(3); // 3 from cell 100 precede it
    expect(tiled[G - 1]).toBe(7);
  });

  test("rejects G beyond the single-block phase-B limit", () => {
    const tooBig = ELEMENTS_PER_BLOCK * ELEMENTS_PER_BLOCK + 1; // 1_048_577
    const counts = new Uint32Array(8); // length doesn't matter; we pass a fake big array view
    void counts;
    expect(() => exclusiveScanTiled(new Uint32Array(tooBig))).toThrow();
  });
});

describe("GPU binner parity — binCPU scatter is a permutation landing in-cell (§2.3/§4.1)", () => {
  // A deterministic cellIndexOf: hash the item value into [0, G). Mirrors the inlined GPU
  // cellIndexOf (which packs floor((pos-gridOrigin)/cellSize)); here a stable arithmetic hash.
  function cellIndexOf(G: number): (item: number) => number {
    return (item: number) => {
      const h = (Math.imul(item ^ 0x9e3779b9, 2654435761) >>> 0) % G;
      return h;
    };
  }

  test("50k items into the collision grid: sorted is a permutation; each item lands in its cell", () => {
    const G = COLLISION_G;
    const N = 50_000;
    const rng = makeLCG(0xc0ffee);
    const items: number[] = new Array<number>(N);
    for (let i = 0; i < N; i += 1) items[i] = rng() % 1_000_000; // arbitrary item payloads
    const idx = cellIndexOf(G);

    const { cellCount, cellStart, sortedItems } = binCPU(items, G, idx);

    // sortedItems holds ITEM INDICES (binCPU stores the index, mirroring the GPU slot id).
    expect(sortedItems.length).toBe(N);

    // (1) sortedItems is a permutation of [0, N): every index appears exactly once.
    const seen = new Uint8Array(N);
    for (let s = 0; s < N; s += 1) {
      const itemIndex = sortedItems[s]!;
      expect(itemIndex).toBeLessThan(N);
      expect(seen[itemIndex]).toBe(0);
      seen[itemIndex] = 1;
    }
    for (let i = 0; i < N; i += 1) expect(seen[i]).toBe(1);

    // (2) every stored slot lies inside its cell's [cellStart, cellStart+cellCount) range.
    for (let c = 0; c < G; c += 1) {
      const start = cellStart[c]!;
      const cnt = cellCount[c]!;
      for (let s = start; s < start + cnt; s += 1) {
        const itemIndex = sortedItems[s]!;
        expect(idx(items[itemIndex]!)).toBe(c);
      }
    }

    // (3) multiset of payloads preserved: sum of payloads via sortedItems == direct sum.
    let directSum = 0;
    for (let i = 0; i < N; i += 1) directSum += items[i]!;
    let sortedSum = 0;
    for (let s = 0; s < N; s += 1) sortedSum += items[sortedItems[s]!]!;
    expect(sortedSum).toBe(directSum);
  });

  test("exclusive-scan invariants on the binned grid (§2.3)", () => {
    const G = COLLISION_G;
    const N = 50_000;
    const rng = makeLCG(0xbeef);
    const items: number[] = new Array<number>(N);
    for (let i = 0; i < N; i += 1) items[i] = rng() % 1_000_000;
    const idx = cellIndexOf(G);

    const { cellCount, cellStart } = binCPU(items, G, idx);

    // cellStart is the exclusive scan of cellCount: start[0]==0 and start[c+1]==start[c]+count[c].
    expect(cellStart[0]).toBe(0);
    for (let c = 0; c + 1 < G; c += 1) {
      expect(cellStart[c + 1]).toBe((cellStart[c]! + cellCount[c]!) >>> 0);
    }
    // start[last] + count[last] == total items.
    expect((cellStart[G - 1]! + cellCount[G - 1]!) >>> 0).toBe(N);

    // total occupancy equals N (no item dropped/double-counted).
    let total = 0;
    for (let c = 0; c < G; c += 1) total += cellCount[c]!;
    expect(total).toBe(N);

    // cellStart equals the standalone tiled scan of cellCount (binCPU restored it post-scatter).
    const scanned = exclusiveScanTiled(cellCount);
    for (let c = 0; c < G; c += 1) expect(cellStart[c]).toBe(scanned[c]!);
  });

  test("degenerate cell maps: all items into one cell, and items spread one-per-cell", () => {
    const G = 1024;

    // All into cell 0.
    {
      const N = 300;
      const items = Array.from({ length: N }, (_, i) => i);
      const { cellCount, cellStart, sortedItems } = binCPU(items, G, () => 0);
      expect(cellCount[0]).toBe(N);
      expect(cellStart[0]).toBe(0);
      expect(cellStart[1]).toBe(N);
      // every item index present once.
      const seen = new Uint8Array(N);
      for (let s = 0; s < N; s += 1) seen[sortedItems[s]!] = 1;
      for (let i = 0; i < N; i += 1) expect(seen[i]).toBe(1);
    }

    // One item per cell (item i -> cell i), first 1024 items.
    {
      const N = G;
      const items = Array.from({ length: N }, (_, i) => i);
      const { cellCount, cellStart, sortedItems } = binCPU(items, G, (item) => item);
      for (let c = 0; c < G; c += 1) {
        expect(cellCount[c]).toBe(1);
        expect(cellStart[c]).toBe(c);
        expect(sortedItems[c]).toBe(c); // item i sits in slot i
      }
    }
  });
});
