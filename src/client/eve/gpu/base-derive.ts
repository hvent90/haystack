// CPU derivation of the GPU-resident `base` buffer (docs/gpu-asteroids-architecture.md §3.2).
//
// THE DETERMINISM RULE: `base` is derived on the CPU from the SAME source the server uses
// (field-core.ts `deriveVirtualField`, f64 `Math.sin`) and uploaded to the GPU. The GPU
// never regenerates positions with a `frac(sin)` kernel — GPU f32 `sin` of the hashCell
// argument (~5e11) is off by up to ~1036 m per the doc's measurement, so a GPU regen could
// not reproduce the server's field. This module is that single CPU authority; the parity
// gate (tests/integration/gpu-base-parity.test.ts) pins it bit-for-bit.

import type { FieldSummary, Vector3 } from "../../../shared/types";
import { deriveVirtualField } from "../field-core";
import { backingArrayOf, backingU32Of, MAX_RESIDENT } from "./buffers";
import type { instancedArray } from "three/tsl";

export type DerivedBase = {
  // capacity*4 floats, vec4 per slot: [x, y, z, radius]. Slots beyond `count` are 0.
  base: Float32Array;
  // capacity*4 floats, vec4 per slot: [packed(reserved), mineralRichness, phaseSeed, 0].
  packAttr: Float32Array;
  // capacity*4 uints, uvec4 per slot: [globalCellX, globalCellY, globalCellZ, residencyEpoch].
  // Reconstructs the EXACT id `v-cx-cy-cz` for picking/promotion (§2.2), so temporal per-rock
  // state never has to key on the non-deterministic compacted draw slot.
  slotMeta: Uint32Array;
  // number of populated slots (= min(derived rocks, capacity)).
  count: number;
};

// Stable per-body wobble phase in [0, 2π), decorrelated per slot. This drives ONLY the
// cosmetic overlay (bounded wobble); it is NOT gameplay state and not parity-gated.
function phaseSeed(index: number): number {
  const v = Math.sin(index * 0.1) * 43758.5453;
  return (v - Math.floor(v)) * Math.PI * 2;
}

// Derive the CPU-authored `base` (and cosmetic `packAttr`) for the ship at `position`.
// `base` xyz/radius are the f32 image of `deriveVirtualField` IN ITS RETURNED ORDER
// (distance-sorted). This is the upload source; the bytes here are exactly what the GPU
// buffer holds after `seedBaseFromCPU`.
export function deriveBase(
  position: Vector3,
  field: FieldSummary,
  capacity: number = MAX_RESIDENT,
  residencyEpoch = 0,
): DerivedBase {
  const rocks = deriveVirtualField(position, field);
  const count = Math.min(rocks.length, capacity);
  const base = new Float32Array(capacity * 4);
  const packAttr = new Float32Array(capacity * 4);
  const slotMeta = new Uint32Array(capacity * 4);
  for (let i = 0; i < count; i += 1) {
    const r = rocks[i]!;
    const o = i * 4;
    // Float32Array stores apply the f64->f32 narrowing; this IS the GPU buffer image.
    base[o] = r.position.x;
    base[o + 1] = r.position.y;
    base[o + 2] = r.position.z;
    base[o + 3] = r.radius;
    packAttr[o + 1] = r.mineralRichness;
    packAttr[o + 2] = phaseSeed(i);
    // Cell coords come straight from the id `v-cx-cy-cz` (the same source packField uses), so
    // slotMeta -> id is exact and string-table-free.
    const parts = r.id.split("-");
    slotMeta[o] = Number(parts[1]);
    slotMeta[o + 1] = Number(parts[2]);
    slotMeta[o + 2] = Number(parts[3]);
    slotMeta[o + 3] = residencyEpoch;
  }
  return { base, packAttr, slotMeta, count };
}

// The id↔slot bridge (§2.2): reconstruct the EXACT rock id `v-cx-cy-cz` from a slot's slotMeta
// uvec4. This is how picking/promotion identify a rock without a string table and WITHOUT
// relying on the compacted draw slot (which is non-deterministic). `slotMeta` is the Uint32Array
// (DerivedBase.slotMeta or backingU32Of(slotMetaBuffer)); `slot` is the slot index.
export function idFromSlotMeta(slotMeta: Uint32Array, slot: number): string {
  const o = slot * 4;
  return `v-${slotMeta[o]}-${slotMeta[o + 1]}-${slotMeta[o + 2]}`;
}

// Upload a u32 buffer image (e.g. slotMeta) into a uint/uvec storage node's backing store.
export function seedU32FromCPU(
  node: ReturnType<typeof instancedArray>,
  derived: Uint32Array,
): void {
  const dst = backingU32Of(node);
  if (derived.length > dst.length) {
    throw new Error(`seedU32FromCPU: derived (${derived.length}) exceeds capacity (${dst.length})`);
  }
  dst.set(derived);
  const attr = (node as unknown as { value?: { needsUpdate?: boolean } }).value;
  if (attr) attr.needsUpdate = true;
}

// Upload source -> GPU buffer backing store. The actual device upload is lazy (three marks
// the attribute for upload on next use); this writes the CPU-authored bytes and flags it.
// NOTE: the GPU round-trip (getArrayBufferAsync) is NOT exercised here — it requires a live
// WebGPU device. The parity gate validates the bytes this function writes.
export function seedBaseFromCPU(
  baseNode: ReturnType<typeof instancedArray>,
  derived: Float32Array,
): void {
  const dst = backingArrayOf(baseNode);
  if (derived.length > dst.length) {
    throw new Error(
      `seedBaseFromCPU: derived (${derived.length}) exceeds buffer capacity (${dst.length})`,
    );
  }
  dst.set(derived);
  const attr = (baseNode as unknown as { value?: { needsUpdate?: boolean } }).value;
  if (attr) attr.needsUpdate = true;
}
