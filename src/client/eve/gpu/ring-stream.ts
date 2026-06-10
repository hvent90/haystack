// Ring streaming (architecture §7 step 4, §3.2): incremental CPU-side reconcile of the
// visible rock set into the GPU buffer backing images. The full-pack path
// (packBaseFromAsteroids + full-buffer re-upload) rewrites all MAX_RESIDENT slots on every
// visible-set change; on a 1-cell cross ~95% of rocks are unchanged (field-derivation reuses
// the Asteroid objects), so this ring keeps an id→slot map, leaves kept slots' bytes
// untouched, writes ONLY entering rocks into freed slots, and zero-radii evicted slots so
// they draw nothing. The dirty slot list feeds BufferAttribute.addUpdateRange so the GPU
// upload is also a sub-range write, not 3 full-buffer writes (§3.2 "ring re-seed is a CPU
// derive + buffer sub-range write").
//
// Determinism: the bytes written per slot are EXACTLY packBaseFromAsteroids' bytes for the
// same rock at the same slot (the parity gate's f32 image of the CPU derive); a first fill
// of an empty ring is byte-identical to the full pack (slots fill low-first in input order).
// The wobble phase (packAttr.z) is a function of the SLOT, so a resident rock's phase is
// stable for as long as it stays resident — and slots are never re-keyed while occupied.

import type { Asteroid } from "../../../shared/types";
import { sunlitForId } from "../sun-occlusion";
import { phaseSeed } from "./base-derive";

export type RingTarget = {
  base: Float32Array;
  packAttr: Float32Array;
  slotMeta: Uint32Array;
};

export type RingReconcileResult = {
  // Sorted, deduplicated slot indices whose bytes changed (entered or evicted).
  dirty: number[];
  entered: number;
  evicted: number;
  kept: number;
  // InstancedMesh.count: one past the highest slot ever occupied. Holes inside the range
  // are zero-radius and draw degenerate (invisible) triangles.
  drawCount: number;
};

// Element-unit range for BufferAttribute.addUpdateRange (start/count in array elements).
export type UpdateRange = { start: number; count: number };

export class FieldRingStream {
  private readonly capacity: number;
  private readonly slotById = new Map<string, number>();
  private readonly idBySlot: (string | null)[];
  // Per-slot epoch of the last reconcile that saw the slot's rock (NOT uploaded; slotMeta.w
  // carries the epoch the rock ENTERED, so kept slots' uploaded bytes never change).
  private readonly lastSeen: Uint32Array;
  // Free slot stack, kept sorted DESCENDING so pop() hands out the lowest slot first (makes
  // a first fill byte-identical to the full pack and keeps dirty ranges compact).
  private readonly free: number[];
  private epoch = 0;
  private highWater = 0;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.idBySlot = new Array<string | null>(capacity).fill(null);
    this.lastSeen = new Uint32Array(capacity);
    this.free = new Array<number>(capacity);
    for (let i = 0; i < capacity; i += 1) {
      this.free[i] = capacity - 1 - i;
    }
  }

  // The slot a rock currently occupies, or null if it is not resident.
  slotOf(id: string): number | null {
    return this.slotById.get(id) ?? null;
  }

  reconcile(rocks: readonly Asteroid[], target: RingTarget): RingReconcileResult {
    const epoch = this.epoch;
    const count = Math.min(rocks.length, this.capacity);

    // Mark: flag kept slots with this epoch; collect entering rocks.
    const entering: Asteroid[] = [];
    for (let i = 0; i < count; i += 1) {
      const rock = rocks[i]!;
      const slot = this.slotById.get(rock.id);
      if (slot !== undefined) {
        this.lastSeen[slot] = epoch;
      } else {
        entering.push(rock);
      }
    }
    const kept = count - entering.length;

    // Sweep: any occupied slot not marked this epoch was evicted — zero it so it draws
    // nothing and return it to the free stack.
    const dirtySet = new Set<number>();
    let evicted = 0;
    for (let slot = 0; slot < this.highWater; slot += 1) {
      const id = this.idBySlot[slot] ?? null;
      if (id === null || this.lastSeen[slot] === epoch) {
        continue;
      }
      this.slotById.delete(id);
      this.idBySlot[slot] = null;
      this.free.push(slot);
      const o = slot * 4;
      target.base[o] = 0;
      target.base[o + 1] = 0;
      target.base[o + 2] = 0;
      target.base[o + 3] = 0;
      target.packAttr[o] = 0;
      target.packAttr[o + 1] = 0;
      target.packAttr[o + 2] = 0;
      target.packAttr[o + 3] = 0;
      target.slotMeta[o] = 0;
      target.slotMeta[o + 1] = 0;
      target.slotMeta[o + 2] = 0;
      target.slotMeta[o + 3] = 0;
      dirtySet.add(slot);
      evicted += 1;
    }
    if (evicted > 0) {
      // Keep pop() handing out the lowest slot first.
      this.free.sort((a, b) => b - a);
    }

    // Enter: place new rocks into freed slots, writing the exact full-pack bytes.
    let entered = 0;
    for (const rock of entering) {
      const slot = this.free.pop();
      if (slot === undefined) {
        break;
      }
      this.slotById.set(rock.id, slot);
      this.idBySlot[slot] = rock.id;
      this.lastSeen[slot] = epoch;
      const o = slot * 4;
      target.base[o] = rock.position.x;
      target.base[o + 1] = rock.position.y;
      target.base[o + 2] = rock.position.z;
      target.base[o + 3] = rock.radius;
      target.packAttr[o] = 0;
      target.packAttr[o + 1] = rock.mineralRichness;
      target.packAttr[o + 2] = phaseSeed(slot);
      // Identical to packFromRocks: w = aSunlit (cached sun-occlusion march per id).
      target.packAttr[o + 3] = sunlitForId(rock.id);
      const parts = rock.id.split("-");
      // Same packing as base-derive packFromRocks: in-cell rock index rides
      // the high half of x (id `v-x-y-z[-i]`).
      target.slotMeta[o] = Number(parts[1]) | ((parts.length > 4 ? Number(parts[4]) : 0) << 16);
      target.slotMeta[o + 1] = Number(parts[2]);
      target.slotMeta[o + 2] = Number(parts[3]);
      target.slotMeta[o + 3] = epoch;
      if (slot + 1 > this.highWater) {
        this.highWater = slot + 1;
      }
      dirtySet.add(slot);
      entered += 1;
    }

    this.epoch = epoch + 1;
    const dirty = [...dirtySet].sort((a, b) => a - b);
    return { dirty, entered, evicted, kept, drawCount: this.highWater };
  }
}

// Merge sorted dirty SLOT indices into few element-unit update ranges (vec4 ⇒ slot*4).
// Slots closer than `gapToleranceSlots` merge into one range (uploading a few untouched
// slots in between is cheaper than another writeBuffer call). If more than `maxRanges`
// result, collapse to ONE spanning range — beyond that point per-range bookkeeping costs
// more than the extra bytes.
export function mergeDirtyToRanges(
  dirtySlots: readonly number[],
  gapToleranceSlots: number,
  maxRanges: number,
): UpdateRange[] {
  if (dirtySlots.length === 0) {
    return [];
  }
  const ranges: UpdateRange[] = [];
  let runStart = dirtySlots[0]!;
  let runEnd = dirtySlots[0]!;
  for (let i = 1; i < dirtySlots.length; i += 1) {
    const slot = dirtySlots[i]!;
    if (slot <= runEnd + 1 + gapToleranceSlots) {
      runEnd = slot;
    } else {
      ranges.push({ start: runStart * 4, count: (runEnd - runStart + 1) * 4 });
      runStart = slot;
      runEnd = slot;
    }
  }
  ranges.push({ start: runStart * 4, count: (runEnd - runStart + 1) * 4 });
  if (ranges.length > maxRanges) {
    const first = dirtySlots[0]!;
    const last = dirtySlots[dirtySlots.length - 1]!;
    return [{ start: first * 4, count: (last - first + 1) * 4 }];
  }
  return ranges;
}
