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
import {
  frameCounter,
  genFieldOverlay,
  setGravityWells,
  WOBBLE_AMPLITUDE_METERS,
} from "./kernels/overlay";
import { deriveGravityWells, WELL_PULL_CAP_METERS } from "./wells";
import { makeCullPipeline } from "./kernels/cull";
import { collVel, gridOrigin, makeCollisionPipeline, snapGridOrigin } from "./kernels/collide";
import { COLLISION_WINDOW_METERS, narrowPhaseCPU } from "./collide-cpu";
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

// Belt-mode §3.2 gate: the SAME round-trip as above, but over the bake-derived field
// (public/belt/default artifacts fetched by the harness page). Proves the CPU belt
// derive -> f32 upload -> GPU readback path is bit-exact for the shipped structure
// source, heroes included (the station spawn bubble contains hero cells).
export async function verifyBeltBaseRoundTrip(renderer: Renderer): Promise<GateResult> {
  try {
    const { beltSummaryFromArtifacts, ensureBeltBake } = await import("../belt-bake-loader");
    const summary = await beltSummaryFromArtifacts("default", FIELD.cellSize, MAX_RESIDENT);
    await ensureBeltBake(summary);
    const shipPos: Vector3 = { x: 1264900, y: 20, z: 250 }; // station spawn, inner band
    const { base: cpuBytes, count } = deriveBase(shipPos, summary, MAX_RESIDENT);
    if (count < 1000) {
      return {
        name: "belt base round-trip (§3.2, bake-derived)",
        pass: false,
        detail: `derive produced only ${count} rocks at the station spawn`,
      };
    }
    seedBaseFromCPU(baseBuffer, cpuBytes);
    renderer.compute(genFieldOverlay);
    const gpuBytes = await readBackFloat32(renderer, baseBuffer);
    let mismatches = 0;
    const checked = count * 4;
    for (let i = 0; i < checked; i += 1) {
      if (gpuBytes[i] !== cpuBytes[i]) mismatches += 1;
    }
    const pass = mismatches === 0;
    return {
      name: "belt base round-trip (§3.2, bake-derived)",
      pass,
      detail: pass
        ? `bit-identical over ${count} belt rocks (${checked} floats)`
        : `${mismatches} mismatches over ${count} rocks`,
    };
  } catch (err) {
    return {
      name: "belt base round-trip (§3.2, bake-derived)",
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

// END-STATE step-6 gate: run the overlay (wobble + gravity-well pull) on the device and
// verify the §4.5 #1 safety bound on REAL GPU output: |pos - base| ≤ √3·wobble + pullCap
// for every slot, radii carried, and the wells actually displace rocks (a well planted
// next to a derived rock must pull it well past the wobble bound).
export async function verifyOverlayBound(renderer: Renderer): Promise<GateResult> {
  try {
    const shipPos: Vector3 = { x: 0, y: 0, z: 0 };
    const { base: cpuBytes, count } = deriveBase(shipPos, FIELD, MAX_RESIDENT);
    seedBaseFromCPU(baseBuffer, cpuBytes);
    // Plant a max-strength test well 2 km from a known rock (plus the deterministic field
    // wells), so the pull is exercised hard at a known site.
    const probeSlot = 100;
    const wells = deriveGravityWells();
    setGravityWells([
      {
        x: cpuBytes[probeSlot * 4]! + 2000,
        y: cpuBytes[probeSlot * 4 + 1]!,
        z: cpuBytes[probeSlot * 4 + 2]!,
        strength: 1,
      },
      ...wells.slice(0, 5),
    ]);
    renderer.compute(genFieldOverlay);
    const posBytes = await readBackFloat32(renderer, posBuffer);
    setGravityWells(wells); // restore the live config

    const bound = Math.sqrt(3) * WOBBLE_AMPLITUDE_METERS + WELL_PULL_CAP_METERS + 1;
    let maxDisp = 0;
    let overBound = 0;
    let radiusMismatches = 0;
    let probeDisp = 0;
    for (let slot = 0; slot < count; slot += 1) {
      const o = slot * 4;
      const dx = posBytes[o]! - cpuBytes[o]!;
      const dy = posBytes[o + 1]! - cpuBytes[o + 1]!;
      const dz = posBytes[o + 2]! - cpuBytes[o + 2]!;
      const disp = Math.hypot(dx, dy, dz);
      if (disp > bound) overBound += 1;
      if (posBytes[o + 3] !== cpuBytes[o + 3]) radiusMismatches += 1;
      if (disp > maxDisp) maxDisp = disp;
      if (slot === probeSlot) probeDisp = disp;
    }
    const pass = overBound === 0 && radiusMismatches === 0 && probeDisp > 100;
    return {
      name: `overlay bound (§4.5 #1, step 6): wobble + well pull over ${count} rocks`,
      pass,
      detail: pass
        ? `max |pos-base| = ${maxDisp.toFixed(1)} m ≤ ${bound.toFixed(0)} m; probe rock pulled ${probeDisp.toFixed(1)} m`
        : `overBound=${overBound} radiusMismatches=${radiusMismatches} probeDisp=${probeDisp.toFixed(1)} m (max ${maxDisp.toFixed(1)})`,
    };
  } catch (err) {
    return {
      name: "overlay bound (§4.5 #1, step 6)",
      pass: false,
      detail: `threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// END-STATE step-6 regression gate: the wobble must be temporally SMOOTH on REAL GPU output.
// Run the overlay at frame N and N+1 and verify every rock moved, but only a little: the
// per-axis wobble is sin(phase + frame*0.01 + off) * A, so one frame moves a rock at most
// √3·A·0.01 ≈ 0.7 m. The original formula hashed the phase (fract(sin(x)*43758.5453)) — white
// noise re-rolled per frame, i.e. ±tens-of-meters jumps that read as the whole field
// vibrating. The well pull is frame-independent, so the frame-to-frame delta isolates wobble.
export async function verifyOverlaySmoothness(renderer: Renderer): Promise<GateResult> {
  try {
    const shipPos: Vector3 = { x: 0, y: 0, z: 0 };
    const { base: cpuBytes, count } = deriveBase(shipPos, FIELD, MAX_RESIDENT);
    seedBaseFromCPU(baseBuffer, cpuBytes);
    const savedFrame = frameCounter.value;
    frameCounter.value = 1000;
    renderer.compute(genFieldOverlay);
    const frameA = await readBackFloat32(renderer, posBuffer);
    frameCounter.value = 1001;
    renderer.compute(genFieldOverlay);
    const frameB = await readBackFloat32(renderer, posBuffer);
    frameCounter.value = savedFrame;

    // d/dframe of sin(ph + 0.01f + off)·A is ≤ 0.01·A per axis; √3× in 3D, plus f32 slack.
    const bound = Math.sqrt(3) * WOBBLE_AMPLITUDE_METERS * 0.01 + 0.1;
    let maxDelta = 0;
    let moved = 0;
    for (let slot = 0; slot < count; slot += 1) {
      const o = slot * 4;
      const delta = Math.hypot(
        frameB[o]! - frameA[o]!,
        frameB[o + 1]! - frameA[o + 1]!,
        frameB[o + 2]! - frameA[o + 2]!,
      );
      if (delta > maxDelta) maxDelta = delta;
      if (delta > 0.001) moved += 1;
    }
    const pass = maxDelta <= bound && moved > count * 0.9;
    return {
      name: `overlay smoothness (step-6 regression): per-frame wobble delta over ${count} rocks`,
      pass,
      detail: pass
        ? `max per-frame |Δpos| = ${maxDelta.toFixed(3)} m ≤ ${bound.toFixed(2)} m; ${moved} rocks moving`
        : `max per-frame |Δpos| = ${maxDelta.toFixed(3)} m (bound ${bound.toFixed(2)}), moved=${moved}/${count}`,
    };
  } catch (err) {
    return {
      name: "overlay smoothness (step-6 regression)",
      pass: false,
      detail: `threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// END-STATE step-7 gate: run the full GPU collision pipeline (shared binner broad phase +
// 27-cell deferred narrow phase) against an AUTHORED DENSE BELT — a jittered grid of fat,
// heavily-overlapping rocks (occupancy ≈ 1/cell, §4.3's validation target) — and compare
// dp/dv per slot against the CPU spec (collide-cpu.narrowPhaseCPU, brute force) on the
// SAME f32 inputs. Tolerance covers float-summation order (the grid walk vs brute force).
export async function verifyCollisions(renderer: Renderer): Promise<GateResult> {
  try {
    const BELT = 512;
    // Belt center inside the collision window; window snapped around it.
    const origin = snapGridOrigin({ x: 0, y: 0, z: 0 });
    gridOrigin.value.set(origin.x, origin.y, origin.z);
    const center = {
      x: origin.x + COLLISION_WINDOW_METERS / 2,
      y: origin.y + COLLISION_WINDOW_METERS / 2,
      z: origin.z + COLLISION_WINDOW_METERS / 2,
    };
    let seed = 987654321;
    const rand = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const posBytes = new Float32Array(MAX_RESIDENT * 4);
    const velBytes = new Float32Array(MAX_RESIDENT * 4);
    const side = 8; // 8x8x8 grid, 400 m pitch, radii 150..330 -> dense overlaps
    for (let i = 0; i < BELT; i += 1) {
      const gx = i % side;
      const gy = Math.floor(i / side) % side;
      const gz = Math.floor(i / (side * side));
      const o = i * 4;
      posBytes[o] = center.x + (gx - side / 2) * 400 + (rand() - 0.5) * 160;
      posBytes[o + 1] = center.y + (gy - side / 2) * 400 + (rand() - 0.5) * 160;
      posBytes[o + 2] = center.z + (gz - side / 2) * 400 + (rand() - 0.5) * 160;
      posBytes[o + 3] = 150 + rand() * 180;
      velBytes[o] = (rand() - 0.5) * 20;
      velBytes[o + 1] = (rand() - 0.5) * 20;
      velBytes[o + 2] = (rand() - 0.5) * 20;
    }
    // Write the belt STRAIGHT into pos (the overlay is intentionally NOT run — the narrow
    // phase must see exactly these bytes) and the velocities into the persistent vel state.
    seedBaseFromCPU(posBuffer, posBytes);
    seedBaseFromCPU(collVel, velBytes);

    const pipeline = makeCollisionPipeline();
    renderer.compute(pipeline.binner.clearCounts);
    renderer.compute(pipeline.binner.count);
    renderer.compute(pipeline.binner.scanPerBlock);
    renderer.compute(pipeline.binner.scanBlockSums);
    renderer.compute(pipeline.binner.addBlockOffsets);
    renderer.compute(pipeline.binner.initCursor);
    renderer.compute(pipeline.binner.scatter);
    renderer.compute(pipeline.narrow);

    const gpuDp = await readBackFloat32(renderer, pipeline.dp);
    const gpuDv = await readBackFloat32(renderer, pipeline.dv);
    // Sanity probe: the narrow phase must have seen EXACTLY the seeded bytes.
    const gpuPos = await readBackFloat32(renderer, posBuffer);
    const gpuVel = await readBackFloat32(renderer, collVel);
    let posDrift = 0;
    let velDrift = 0;
    for (let i = 0; i < BELT * 4; i += 1) {
      if (gpuPos[i] !== posBytes[i]) posDrift += 1;
      if (gpuVel[i] !== velBytes[i]) velDrift += 1;
    }
    const cpu = narrowPhaseCPU(posBytes, velBytes, BELT);

    const TOL = 1e-2; // meters / m-per-s; float-order slack
    let dpMismatches = 0;
    let dvMismatches = 0;
    let firstBad = -1;
    let contacts = 0;
    for (let i = 0; i < BELT; i += 1) {
      const o = i * 4;
      const cpuMag = Math.hypot(cpu.dp[o]!, cpu.dp[o + 1]!, cpu.dp[o + 2]!);
      if (cpuMag > 0) contacts += 1;
      for (let k = 0; k < 3; k += 1) {
        if (Math.abs(gpuDp[o + k]! - cpu.dp[o + k]!) > TOL) {
          dpMismatches += 1;
          if (firstBad < 0) firstBad = o + k;
        }
        if (Math.abs(gpuDv[o + k]! - cpu.dv[o + k]!) > TOL) {
          dvMismatches += 1;
          if (firstBad < 0) firstBad = o + k;
        }
      }
    }
    // The belt must actually exercise the narrow phase hard.
    const pass = dpMismatches === 0 && dvMismatches === 0 && contacts > BELT / 4;
    return {
      name: `collisions GPU-vs-CPU (§4.2, step 7): dense belt of ${BELT}, 27-cell deferred dp/dv`,
      pass,
      detail: pass
        ? `dp/dv match over ${BELT} bodies (${contacts} in contact) within ${TOL}`
        : `dpMismatches=${dpMismatches} dvMismatches=${dvMismatches} contacts=${contacts} posDrift=${posDrift} velDrift=${velDrift} (first bad float ${firstBad}: gpu=${firstBad >= 0 ? gpuDp[firstBad] : "?"} cpu=${firstBad >= 0 ? cpu.dp[firstBad] : "?"})`,
    };
  } catch (err) {
    return {
      name: "collisions GPU-vs-CPU (§4.2, step 7)",
      pass: false,
      detail: `threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// END-STATE step-9 gate (§6.5): run the froxel volumetric pipeline (scatter + in-place
// integrate, INCLUDING the up-sun rock-shadow march through the collision world grid and
// the analytic flashlight cone) on the device and compare froxelAccum against the CPU
// executable spec (froxels-cpu.ts) on identical f32 inputs: a synthetic smooth polar
// density + an authored rock cluster, with the grid image (cellStart/cellCount/sorted/pos)
// read BACK from the device so both sides march the same bytes. GPU f32 vs CPU f64 can
// flip a march sample across a 768 m cell boundary (a whole rock appears/vanishes for
// that froxel) or a trilinear tap across a density bin — so the gate requires the
// overwhelming majority within tolerance rather than exactness, plus structural checks
// (sun shafts present: shadowed froxels exist; flashlight cone present).
export async function verifyFroxels(renderer: Renderer): Promise<GateResult> {
  try {
    const {
      FROXEL_COUNT,
      FROXEL_W,
      FROXEL_H,
      froxelIndexOf,
      froxelScatterCPU,
      froxelIntegrateCPU,
    } = await import("./froxels-cpu");
    const froxelsKernels = await import("./kernels/froxels");
    const lighting = await import("../lighting");
    const { COLLISION_CELL_METERS, COLLISION_GRID_AXIS } = await import("./collide-cpu");

    // --- camera + origin: mid-belt, cockpit offset, looking down -Z -------------------
    // A NON-ZERO field anchor (gpu/anchor.ts) pins the anchor-relative plumbing: every
    // GPU coordinate below (originMeters, pos, gridOrigin) is absolute MINUS this, and
    // only the density sample adds it back. 2^16-aligned like the runtime snap.
    const anchor = { x: 4 * 65536, y: -65536, z: 65536 };
    const shipMeters = { x: 1_500_000, y: 0, z: 0 };
    originMeters.value.set(
      shipMeters.x - anchor.x,
      shipMeters.y - anchor.y,
      shipMeters.z - anchor.z,
    );
    froxelsKernels.froxelAnchor.value.set(anchor.x, anchor.y, anchor.z);
    const camera = new THREE.PerspectiveCamera(68, 16 / 9, 0.01, 20000);
    camera.position.set(0, 0.12, 0);
    camera.updateMatrixWorld(true);
    camera.updateProjectionMatrix();
    froxelsKernels.froxelProjInv.value.copy(camera.projectionMatrixInverse);
    froxelsKernels.froxelCamWorld.value.copy(camera.matrixWorld);

    // --- synthetic smooth polar density (adjacent bins differ little, so f32/f64
    // trilinear boundary flips stay tiny) + deterministic tuning ------------------------
    const nr = 64;
    const ntheta = 64;
    const nz = 8;
    const data = new Uint8Array(nr * ntheta * nz);
    for (let ir = 0; ir < nr; ir += 1) {
      for (let it = 0; it < ntheta; it += 1) {
        for (let iz = 0; iz < nz; iz += 1) {
          data[(ir * ntheta + it) * nz + iz] = Math.round(
            120 + 100 * Math.sin(ir / 9) * Math.cos(it / 7) * Math.cos(iz / 3),
          );
        }
      }
    }
    const grid = { data, nr, ntheta, nz, rMin: 0.5, rMax: 3.25, zMax: 0.09, worldScale: 1e6 };
    froxelsKernels.resetFroxelDensityForTest();
    froxelsKernels.setFroxelDensityGrid(grid);
    froxelsKernels.applyFroxelTuning(null);
    const flashPose = { pos: { x: 0, y: 0.12, z: 0 }, dir: { x: 0, y: 0, z: -1 } };
    froxelsKernels.setFroxelFlashlight(flashPose.pos, flashPose.dir, true);

    // --- authored rocks: a small cluster ahead of the camera, offset up-sun so their
    // shadow cones cross the view frustum (shafts must exist in the output). Stored
    // ANCHOR-RELATIVE like the runtime pos buffer. ---------------------------------------
    const origin = snapGridOrigin(shipMeters);
    const originRel = { x: origin.x - anchor.x, y: origin.y - anchor.y, z: origin.z - anchor.z };
    gridOrigin.value.set(originRel.x, originRel.y, originRel.z);
    const sun = lighting.sunDirection;
    const posBytes = new Float32Array(MAX_RESIDENT * 4);
    let seed = 13579;
    const rand = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const ROCKS = 64;
    for (let i = 0; i < ROCKS; i += 1) {
      const o = i * 4;
      // 2-6 km ahead (-z), scattered, nudged up-sun so shadows fall back through the view.
      const ahead = 2000 + rand() * 4000;
      posBytes[o] = shipMeters.x + (rand() - 0.5) * 3000 + sun.x * 800 - anchor.x;
      posBytes[o + 1] = shipMeters.y + (rand() - 0.5) * 2000 + sun.y * 800 - anchor.y;
      posBytes[o + 2] = shipMeters.z - ahead + sun.z * 800 - anchor.z;
      posBytes[o + 3] = 150 + rand() * 200;
    }
    seedBaseFromCPU(posBuffer, posBytes);

    // --- build the collision world grid on-device, then read the grid image back so the
    // CPU march sees byte-identical inputs ----------------------------------------------
    const pipeline = makeCollisionPipeline();
    renderer.compute(pipeline.binner.clearCounts);
    renderer.compute(pipeline.binner.count);
    renderer.compute(pipeline.binner.scanPerBlock);
    renderer.compute(pipeline.binner.scanBlockSums);
    renderer.compute(pipeline.binner.addBlockOffsets);
    renderer.compute(pipeline.binner.initCursor);
    renderer.compute(pipeline.binner.scatter);

    const froxel = froxelsKernels.makeFroxelPipeline(pipeline.binner.buffers);
    renderer.compute(froxel.scatter);
    renderer.compute(froxel.integrate);

    const gpuAccum = await readBackFloat32(renderer, froxelsKernels.froxelAccum);
    const cellStart = await readBackUint32(renderer, pipeline.binner.buffers.cellStart);
    const cellCountRaw = await readBackUint32(renderer, pipeline.binner.buffers.cellCount);
    const sortedItems = await readBackUint32(renderer, pipeline.binner.buffers.sortedItems);
    const gpuPos = await readBackFloat32(renderer, posBuffer);

    // --- CPU mirror on the read-back image ---------------------------------------------
    const defaults = froxelsKernels.FROXEL_DEFAULTS;
    const sunColor = new THREE.Color(lighting.sunLightColor);
    const flashColor = new THREE.Color(lighting.flashlightColor);
    const cpuAccum = new Float32Array(FROXEL_COUNT * 4);
    froxelScatterCPU(
      grid,
      {
        projectionMatrixInverse: camera.projectionMatrixInverse.elements,
        cameraWorldMatrix: camera.matrixWorld.elements,
        originMeters: {
          x: shipMeters.x - anchor.x,
          y: shipMeters.y - anchor.y,
          z: shipMeters.z - anchor.z,
        },
        anchorMeters: anchor,
        sigmaScale: defaults.sigmaScale,
        sigmaFloor: defaults.sigmaFloor,
        albedo: { x: defaults.albedo.r, y: defaults.albedo.g, z: defaults.albedo.b },
        ambient: defaults.ambient,
        lights: {
          sunDirection: sun,
          sunColor: { x: sunColor.r, y: sunColor.g, z: sunColor.b },
          sunStrength: defaults.sunStrength,
          hgG: defaults.hgG,
          grid: {
            gridOrigin: originRel,
            cellMeters: COLLISION_CELL_METERS,
            gridAxis: COLLISION_GRID_AXIS,
            cellCount: cellCountRaw,
            cellStart,
            sortedItems,
            posXYZR: gpuPos,
          },
          flash: {
            pos: flashPose.pos,
            dir: flashPose.dir,
            color: { x: flashColor.r, y: flashColor.g, z: flashColor.b },
            intensity: lighting.flashlightIntensity * defaults.flashStrength,
            reach: lighting.flashlightDistance,
            cosInner: Math.cos(lighting.flashlightAngle * (1 - lighting.flashlightPenumbra)),
            cosOuter: Math.cos(lighting.flashlightAngle),
            decay: lighting.flashlightDecay,
          },
        },
      },
      cpuAccum,
    );
    froxelIntegrateCPU(cpuAccum);

    // --- compare: overwhelming-majority within tolerance + structural presence ---------
    const TOL = 3e-2;
    let bad = 0;
    let worst = 0;
    let firstBad = -1;
    for (let i = 0; i < FROXEL_COUNT * 4; i += 1) {
      const d = Math.abs(gpuAccum[i]! - cpuAccum[i]!);
      if (d > worst) worst = d;
      if (d > TOL) {
        bad += 1;
        if (firstBad < 0) firstBad = i;
      }
    }
    const badFrac = bad / (FROXEL_COUNT * 4);
    // Sun shafts present: some final-slice columns must be visibly darker (shadowed dust)
    // than the brightest column on the GPU output itself.
    let minR = Infinity;
    let maxR = 0;
    let conedR = 0;
    const lastSlice = (x: number, y: number): number => froxelIndexOf(x, y, 63) * 4;
    for (let y = 0; y < FROXEL_H; y += 4) {
      for (let x = 0; x < FROXEL_W; x += 4) {
        const r = gpuAccum[lastSlice(x, y)]!;
        if (r < minR) minR = r;
        if (r > maxR) maxR = r;
      }
    }
    // Flashlight cone present: the screen-center column (inside the beam) carries more
    // in-scatter than the screen-corner column (outside the cone) on the GPU output.
    const centerR = gpuAccum[lastSlice(FROXEL_W / 2, FROXEL_H / 2)]!;
    conedR = gpuAccum[lastSlice(2, 2)]!;
    const shafts = maxR > 0 && minR < maxR * 0.9;
    const cone = centerR > conedR;
    const pass = badFrac < 0.005 && shafts && cone;
    return {
      name: `froxels GPU-vs-CPU (§6.5, step 9): scatter+integrate, ${ROCKS}-rock shadow march, flashlight cone`,
      pass,
      detail: pass
        ? `${(100 - badFrac * 100).toFixed(2)}% of ${FROXEL_COUNT * 4} floats within ${TOL} (worst ${worst.toFixed(4)}); shafts min/max=${minR.toFixed(4)}/${maxR.toFixed(4)}; beam center/corner=${centerR.toFixed(4)}/${conedR.toFixed(4)}`
        : `badFrac=${(badFrac * 100).toFixed(3)}% worst=${worst.toFixed(4)} (first float ${firstBad}: gpu=${firstBad >= 0 ? gpuAccum[firstBad] : "?"} cpu=${firstBad >= 0 ? cpuAccum[firstBad] : "?"}) shafts=${shafts} (${minR.toFixed(4)}/${maxR.toFixed(4)}) cone=${cone} (${centerR.toFixed(4)}/${conedR.toFixed(4)})`,
    };
  } catch (err) {
    return {
      name: "froxels GPU-vs-CPU (§6.5, step 9)",
      pass: false,
      detail: `threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function runGpuVerification(renderer: Renderer): Promise<GateResult[]> {
  const results: GateResult[] = [];
  results.push(await verifyBaseRoundTrip(renderer));
  results.push(await verifyBeltBaseRoundTrip(renderer));
  results.push(await verifyBinnerScan(renderer));
  results.push(await verifyBinnerScatter(renderer));
  results.push(await verifyCullLod(renderer));
  results.push(await verifyOverlayBound(renderer));
  results.push(await verifyOverlaySmoothness(renderer));
  results.push(await verifyCollisions(renderer));
  results.push(await verifyFroxels(renderer));
  return results;
}
