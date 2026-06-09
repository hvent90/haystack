// On-GPU verification harness (docs/gpu-asteroids-impl-log.md "HOW TO VERIFY THE GPU HALF").
//
// PURPOSE: turn the CPU-verified work (base parity §3.2, binner scan §2.3) into push-button
// END-STATE gates that run on a REAL WebGPU device. This file holds the logic; verify-entry.ts
// boots a renderer and calls runGpuVerification, rendering the report to the page.
//
// STATUS: authored + typechecked, but NOT executed here (no navigator.gpu in this env). Run it
// in a real Chrome via /gpu-verify.html (see the impl log). A couple of three@0.177 API spots
// (the getArrayBufferAsync argument shape; whether compute needs an explicit await) are marked
// with NOTE comments — adjust if the device run surfaces a mismatch.

import * as THREE from "three/webgpu";

import type { FieldSummary, Vector3 } from "../../../shared/types";
import { base as baseBuffer, MAX_RESIDENT, pos as posBuffer } from "./buffers";
import { deriveBase, seedBaseFromCPU } from "./base-derive";
import { binCPU, ELEMENTS_PER_BLOCK } from "./binner-cpu";
import { makeBinnerKernels } from "./kernels/binner";
import { genFieldOverlay } from "./kernels/overlay";
import { makeCullPipeline } from "./kernels/cull";
import { originMeters } from "./kernels/render-node";
import {
  cullCPU,
  extractFrustumPlanes,
  LOD_BANDS_SCENE,
  LOD_COUNT,
  MAX_DRAW_SCENE,
  METERS_PER_SCENE_UNIT,
} from "./cull-cpu";
import { uint } from "three/tsl";

type Renderer = InstanceType<typeof THREE.WebGPURenderer>;

export type GateResult = { name: string; pass: boolean; detail: string };

const FIELD: FieldSummary = {
  totalAsteroids: 1_000_000,
  seed: 424_242,
  cellSize: 1130,
  indexKind: "cubicCellHierarchy",
  renderedLimit: MAX_RESIDENT,
};

// Read a storage node's GPU buffer back to the CPU. NOTE: three@0.177
// `WebGPURenderer.getArrayBufferAsync(attribute)` takes the BufferAttribute; for a TSL
// instancedArray that is `node.value`. If the device run rejects this, try passing the node
// itself (the doc §8.6 snippet writes `getArrayBufferAsync(base)`).
async function readBackFloat32(renderer: Renderer, node: unknown): Promise<Float32Array> {
  const attribute = (node as { value?: unknown }).value;
  const buf = await renderer.getArrayBufferAsync(
    attribute as Parameters<Renderer["getArrayBufferAsync"]>[0],
  );
  return new Float32Array(buf);
}

async function readBackUint32(renderer: Renderer, node: unknown): Promise<Uint32Array> {
  const attribute = (node as { value?: unknown }).value;
  const buf = await renderer.getArrayBufferAsync(
    attribute as Parameters<Renderer["getArrayBufferAsync"]>[0],
  );
  return new Uint32Array(buf);
}

// END-STATE step-3 gate (§8.6 #3): getArrayBufferAsync(base) === the CPU deriveBase bytes,
// bit-identical. The CPU half is already proven in tests; this closes the GPU round-trip.
export async function verifyBaseRoundTrip(
  renderer: Renderer,
  shipPos: Vector3 = { x: 0, y: 0, z: 0 },
): Promise<GateResult> {
  try {
    const { base: cpuBytes, count } = deriveBase(shipPos, FIELD, MAX_RESIDENT);
    seedBaseFromCPU(baseBuffer, cpuBytes);
    // getArrayBufferAsync on a storage node that was never used in a pass throws
    // ("'size' of undefined") — the GPU buffer isn't created until something touches it. The
    // overlay kernel READS base (writing pos), so this uploads the seeded bytes; base itself is
    // unchanged, so the round-trip still proves the upload path is bit-exact.
    renderer.compute(genFieldOverlay);
    const gpuBytes = await readBackFloat32(renderer, baseBuffer);
    let mismatches = 0;
    let firstBad = -1;
    const checked = count * 4;
    for (let i = 0; i < checked; i += 1) {
      if (gpuBytes[i] !== cpuBytes[i]) {
        mismatches += 1;
        if (firstBad < 0) firstBad = i;
      }
    }
    const pass = mismatches === 0;
    return {
      name: "base round-trip (§8.6 #3): getArrayBufferAsync(base) === deriveBase",
      pass,
      detail: pass
        ? `bit-identical over ${count} rocks (${checked} floats)`
        : `${mismatches} mismatches; first at float ${firstBad} (gpu=${gpuBytes[firstBad]} cpu=${cpuBytes[firstBad]})`,
    };
  } catch (err) {
    return {
      name: "base round-trip (§8.6 #3)",
      pass: false,
      detail: `threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// END-STATE step-5 gate: run the GPU binner SCAN (clearCounts → count → 3-phase scan) and
// confirm cellStart === binCPU's exclusive scan. cellIndexOf is `i % G` on BOTH sides so the
// histogram is identical and the comparison is exact. NOTE: the GPU `scatter` is intentionally
// NOT run here — it atomicAdds the non-atomic cellStart node (known gap, see kernels/binner.ts);
// fix that with an atomic buffer view before adding a GPU scatter gate.
export async function verifyBinnerScan(renderer: Renderer): Promise<GateResult> {
  try {
    const G = 64 * 64 * 64; // 262144, the collision grid (§4.1)
    const numItems = 500_000;
    const cellIndexOfCPU = (_item: number, i: number): number => i % G;

    const items = new Array<number>(numItems);
    for (let i = 0; i < numItems; i += 1) items[i] = i;
    const cpu = binCPU(items, G, cellIndexOfCPU);

    const kernels = makeBinnerKernels(G, numItems, (i) => i.mod(uint(G)));
    // One submission each; getArrayBufferAsync below flushes the queue before readback.
    renderer.compute(kernels.clearCounts);
    renderer.compute(kernels.count);
    renderer.compute(kernels.scanPerBlock);
    renderer.compute(kernels.scanBlockSums);
    renderer.compute(kernels.addBlockOffsets);

    const gpuCellStart = await readBackUint32(renderer, kernels.buffers.cellStart);
    let mismatches = 0;
    let firstBad = -1;
    for (let c = 0; c < G; c += 1) {
      if (gpuCellStart[c] !== cpu.cellStart[c]) {
        mismatches += 1;
        if (firstBad < 0) firstBad = c;
      }
    }
    const pass = mismatches === 0;
    return {
      name: `binner scan GPU-vs-CPU (§2.3): exclusive scan over G=${G}, ${numItems} items, block=${ELEMENTS_PER_BLOCK}`,
      pass,
      detail: pass
        ? `cellStart bit-identical over ${G} cells`
        : `${mismatches} cell mismatches; first at cell ${firstBad} (gpu=${gpuCellStart[firstBad]} cpu=${cpu.cellStart[firstBad]})`,
    };
  } catch (err) {
    return {
      name: "binner scan GPU-vs-CPU (§2.3)",
      pass: false,
      detail: `threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// END-STATE step-5 scatter gate: run the full GPU binner (scan + initCursor + scatter) and verify
// sortedItems is a VALID grouping. Within-cell order is a non-deterministic atomic race, so we do
// NOT compare to binCPU byte-for-byte; instead we assert the invariants binner-cpu's test checks:
// every item appears exactly once (permutation) and lands inside its cell's [start, start+count).
export async function verifyBinnerScatter(renderer: Renderer): Promise<GateResult> {
  try {
    const G = 64 * 64 * 64;
    const numItems = 500_000;
    const kernels = makeBinnerKernels(G, numItems, (i) => i.mod(uint(G)));
    renderer.compute(kernels.clearCounts);
    renderer.compute(kernels.count);
    renderer.compute(kernels.scanPerBlock);
    renderer.compute(kernels.scanBlockSums);
    renderer.compute(kernels.addBlockOffsets);
    renderer.compute(kernels.initCursor);
    renderer.compute(kernels.scatter);

    const cellStart = await readBackUint32(renderer, kernels.buffers.cellStart);
    const cellCount = await readBackUint32(renderer, kernels.buffers.cellCount);
    const sortedItems = await readBackUint32(renderer, kernels.buffers.sortedItems);

    const seen = new Uint8Array(numItems);
    let dupes = 0;
    let outOfRange = 0;
    let firstBad = -1;
    for (let s = 0; s < numItems; s += 1) {
      const item = sortedItems[s]!;
      if (item >= numItems) {
        outOfRange += 1;
        if (firstBad < 0) firstBad = s;
        continue;
      }
      if (seen[item]) dupes += 1;
      seen[item] = 1;
      const c = item % G;
      const lo = cellStart[c]!;
      const hi = lo + cellCount[c]!;
      if (s < lo || s >= hi) {
        outOfRange += 1;
        if (firstBad < 0) firstBad = s;
      }
    }
    let missing = 0;
    for (let i = 0; i < numItems; i += 1) if (!seen[i]) missing += 1;
    const pass = dupes === 0 && outOfRange === 0 && missing === 0;
    return {
      name: `binner scatter GPU (§2.3): permutation + in-cell-range over ${numItems} items, G=${G}`,
      pass,
      detail: pass
        ? `valid grouping: every item once, each inside its cell range`
        : `dupes=${dupes} missing=${missing} outOfRange=${outOfRange} (first bad slot ${firstBad})`,
    };
  } catch (err) {
    return {
      name: "binner scatter GPU (§2.3)",
      pass: false,
      detail: `threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// END-STATE step-4 gate: run the GPU cull/LOD compaction over a real derived 50k field and
// verify it against the CPU spec (cull-cpu.ts) on the SAME pos bytes (read back from the
// device, so both sides see identical f32 inputs). The compaction ORDER is an atomic race,
// so per-band membership is compared as sets. GPU f32 vs CPU f64 arithmetic can flip rocks
// sitting exactly on a band/draw/frustum boundary, so mismatches are accepted ONLY within
// an epsilon of a decision boundary — every other slot must agree exactly.
export async function verifyCullLod(renderer: Renderer): Promise<GateResult> {
  try {
    const shipPos: Vector3 = { x: 0, y: 0, z: 0 };
    const { base: cpuBytes } = deriveBase(shipPos, FIELD, MAX_RESIDENT);
    seedBaseFromCPU(baseBuffer, cpuBytes);
    originMeters.value.set(shipPos.x, shipPos.y, shipPos.z);
    renderer.compute(genFieldOverlay); // writes pos = base + wobble
    const posBytes = await readBackFloat32(renderer, posBuffer);

    // A representative camera: cockpit offset, looking down -Z, the game's projection.
    const camera = new THREE.PerspectiveCamera(68, 16 / 9, 0.01, 20000);
    camera.position.set(0, 0.12, 0);
    camera.lookAt(new THREE.Vector3(0, 0.1, -1));
    camera.updateMatrixWorld(true);
    camera.updateProjectionMatrix();
    const projScreen = new THREE.Matrix4().multiplyMatrices(
      camera.projectionMatrix,
      camera.matrixWorldInverse,
    );

    const pipeline = makeCullPipeline([108, 60, 24, 12]);
    pipeline.updatePlanes(projScreen);
    renderer.compute(pipeline.clearCull);
    renderer.compute(pipeline.cull);
    renderer.compute(pipeline.publishCounts);

    const counts: number[] = [];
    const gpuLists: Uint32Array[] = [];
    for (let band = 0; band < LOD_COUNT; band += 1) {
      const args = new Uint32Array(
        await renderer.getArrayBufferAsync(
          pipeline.indirectAttrs[band] as Parameters<Renderer["getArrayBufferAsync"]>[0],
        ),
      );
      counts.push(args[1]!);
      const list = await readBackUint32(renderer, pipeline.lodLists[band]);
      gpuLists.push(list.subarray(0, args[1]!));
    }

    const planes = extractFrustumPlanes(projScreen);
    const cpu = cullCPU(posBytes, MAX_RESIDENT, shipPos, planes);

    // Epsilon (scene units) for boundary-flip tolerance between GPU f32 and CPU f64.
    const EPS = 1e-2;
    const nearBoundary = (slot: number): boolean => {
      const o = slot * 4;
      const x = (posBytes[o]! - shipPos.x) / METERS_PER_SCENE_UNIT;
      const y = (posBytes[o + 1]! - shipPos.y) / METERS_PER_SCENE_UNIT;
      const z = (posBytes[o + 2]! - shipPos.z) / METERS_PER_SCENE_UNIT;
      const radiusScene = posBytes[o + 3]! / METERS_PER_SCENE_UNIT;
      const nearest = Math.hypot(x, y, z) - radiusScene;
      if (Math.abs(nearest - MAX_DRAW_SCENE) < EPS) return true;
      for (const edge of LOD_BANDS_SCENE) {
        if (Math.abs(nearest - edge) < EPS) return true;
      }
      for (let p = 0; p < 6; p += 1) {
        const d =
          planes[p * 4]! * x + planes[p * 4 + 1]! * y + planes[p * 4 + 2]! * z + planes[p * 4 + 3]!;
        if (Math.abs(d + radiusScene) < EPS) return true;
      }
      return false;
    };

    const cpuBand = new Int8Array(MAX_RESIDENT).fill(-1);
    let cpuVisible = 0;
    for (let band = 0; band < LOD_COUNT; band += 1) {
      for (const slot of cpu.lists[band]!) {
        cpuBand[slot] = band;
        cpuVisible += 1;
      }
    }
    const gpuBand = new Int8Array(MAX_RESIDENT).fill(-1);
    let dupes = 0;
    let gpuVisible = 0;
    for (let band = 0; band < LOD_COUNT; band += 1) {
      for (const slot of gpuLists[band]!) {
        if (gpuBand[slot] !== -1) dupes += 1;
        gpuBand[slot] = band;
        gpuVisible += 1;
      }
    }
    let hardMismatches = 0;
    let boundaryFlips = 0;
    let firstBad = -1;
    for (let slot = 0; slot < MAX_RESIDENT; slot += 1) {
      if (cpuBand[slot] === gpuBand[slot]) continue;
      if (nearBoundary(slot)) {
        boundaryFlips += 1;
      } else {
        hardMismatches += 1;
        if (firstBad < 0) firstBad = slot;
      }
    }
    const pass = dupes === 0 && hardMismatches === 0 && cpuVisible > 1000;
    return {
      name: `cull/LOD GPU-vs-CPU (§7 step 4): ${MAX_RESIDENT} slots, 4 bands, frustum+distance`,
      pass,
      detail: pass
        ? `bands match (gpu=[${counts.join(",")}] visible=${gpuVisible} cpu=${cpuVisible}; ${boundaryFlips} eps-boundary flips)`
        : `dupes=${dupes} hardMismatches=${hardMismatches} (first slot ${firstBad}: cpu band ${firstBad >= 0 ? cpuBand[firstBad] : "?"} gpu band ${firstBad >= 0 ? gpuBand[firstBad] : "?"}) cpuVisible=${cpuVisible}`,
    };
  } catch (err) {
    return {
      name: "cull/LOD GPU-vs-CPU (§7 step 4)",
      pass: false,
      detail: `threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function runGpuVerification(renderer: Renderer): Promise<GateResult[]> {
  const results: GateResult[] = [];
  results.push(await verifyBaseRoundTrip(renderer));
  results.push(await verifyBinnerScan(renderer));
  results.push(await verifyBinnerScatter(renderer));
  results.push(await verifyCullLod(renderer));
  return results;
}
