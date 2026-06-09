// GPU-resident asteroid field — per-body storage buffers (SoA).
//
// Authoritative schema: docs/gpu-asteroids-architecture.md §2.1. Every buffer is
// struct-of-arrays `vec4` (std430 stride 16B, no padding). The beachhead (§8) needs only
// `base`, `pos`, and `packAttr`; the remaining per-body buffers (velMass ping-pong, orient,
// angSig, slotMeta) land in later build-sequence steps and are intentionally NOT allocated
// yet to keep the unverified GPU surface minimal.
//
// IMPORTANT (§3.2): `base` is CPU-authored and IMMUTABLE. It is filled by a CPU derive
// (see base-derive.ts) and uploaded; the GPU NEVER regenerates it with a frac(sin) kernel.
// `.setPBO(true)` marks it CPU-authored and draw-readable.

import { instancedArray } from "three/tsl";

// Client GPU buffer CAPACITY (a slot count), distinct from the server `renderedLimit`
// stream/derive cap (§2.6, §9.1 decision 4). Default 50k; headroom to 256k.
export const MAX_RESIDENT = 50_000;

// xyz = ABSOLUTE static-noise world meters (server-matched), w = radius (45..355).
// IMMUTABLE after seed; CPU-authored & draw-readable.
export const base = instancedArray(MAX_RESIDENT, "vec4").setPBO(true);

// xyz = rendered world meters = base + bounded overlay, w = radius copy.
// What `material.positionNode` reads (zero-copy). setPBO so it is draw-readable.
export const pos = instancedArray(MAX_RESIDENT, "vec4").setPBO(true);

// x = bit-packed flags (later), y = mineralRichness, z = overlay phase seed, w = reserved.
export const packAttr = instancedArray(MAX_RESIDENT, "vec4");

// The Float32Array backing store of a TSL instancedArray storage node. This is the
// CPU-side source that gets uploaded to the GPU; the base-parity gate reads it directly
// (headless, no WebGPU device required). Access path verified against three@0.177.
export function backingArrayOf(node: ReturnType<typeof instancedArray>): Float32Array {
  // three TSL: StorageBufferNode.value is the StorageInstancedBufferAttribute; `.array`
  // is its typed backing store.
  const attr = (node as unknown as { value?: { array?: Float32Array } }).value;
  const arr = attr?.array;
  if (!(arr instanceof Float32Array)) {
    throw new Error("backingArrayOf: expected a Float32Array backing store on the storage node");
  }
  return arr;
}
