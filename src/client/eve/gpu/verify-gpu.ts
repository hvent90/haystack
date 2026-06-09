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
import { base as baseBuffer, MAX_RESIDENT } from "./buffers";
import { deriveBase, seedBaseFromCPU } from "./base-derive";
import { binCPU, ELEMENTS_PER_BLOCK } from "./binner-cpu";
import { makeBinnerKernels } from "./kernels/binner";
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

export async function runGpuVerification(renderer: Renderer): Promise<GateResult[]> {
  const results: GateResult[] = [];
  results.push(await verifyBaseRoundTrip(renderer));
  results.push(await verifyBinnerScan(renderer));
  return results;
}
