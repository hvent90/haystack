// Ring streaming (architecture §7 step 4 / §3.2): incremental reconcile of the visible rock
// set into the CPU backing images of the GPU buffers (base/packAttr/slotMeta), writing ONLY
// the slots that actually changed instead of repacking + re-uploading all MAX_RESIDENT slots
// on every visible-set change. Kept rocks keep their slots (and bytes) untouched; entering
// rocks claim freed slots; evicted slots are zero-radius'd so they draw nothing.
//
// The load-bearing parity property: at any point in a reconcile sequence, the set of
// occupied slots is byte-equivalent (per rock) to what the full packBaseFromAsteroids
// produces for the same rock at the same slot — base = f32 image of position/radius,
// slotMeta reconstructs the exact `v-cx-cy-cz` id, packAttr.z = phaseSeed(slot).

import { describe, expect, test } from "bun:test";
import type { Asteroid } from "../../src/shared/types";
import { packBaseFromAsteroids, idFromSlotMeta } from "../../src/client/eve/gpu/base-derive";
import { FieldRingStream, mergeDirtyToRanges } from "../../src/client/eve/gpu/ring-stream";

function rock(cx: number, cy: number, cz: number): Asteroid {
  // Shape-faithful virtual rock: id drives slotMeta; position/radius drive base.
  return {
    id: `v-${cx}-${cy}-${cz}`,
    pocket: "outer-sparse",
    position: {
      x: cx * 1130 - 56500 + 0.125,
      y: cy * 1130 - 56500 + 0.25,
      z: cz * 1130 - 56500 + 0.5,
    },
    radius: 45 + ((cx * 31 + cy * 7 + cz) % 310),
    signature: 0.4,
    mineralRichness: 0.18 + ((cx + cy + cz) % 80) / 100,
    rareMineral: "nickel",
    discovered: true,
  };
}

function rockSet(n: number, salt = 0): Asteroid[] {
  const rocks: Asteroid[] = [];
  for (let i = 0; i < n; i += 1) {
    const k = i + salt * 100000;
    rocks.push(rock(k % 100, Math.floor(k / 100) % 100, (k * 7 + salt) % 100));
  }
  return rocks;
}

function freshTarget(capacity: number) {
  return {
    base: new Float32Array(capacity * 4),
    packAttr: new Float32Array(capacity * 4),
    slotMeta: new Uint32Array(capacity * 4),
  };
}

const CAP = 512;

describe("FieldRingStream", () => {
  test("first reconcile is byte-identical to the full pack", () => {
    const ring = new FieldRingStream(CAP);
    const target = freshTarget(CAP);
    const rocks = rockSet(300);
    const result = ring.reconcile(rocks, target);

    const full = packBaseFromAsteroids(rocks, CAP);
    expect(target.base).toEqual(full.base.slice());
    expect(target.packAttr).toEqual(full.packAttr.slice());
    expect(target.slotMeta).toEqual(full.slotMeta.slice());
    expect(result.drawCount).toBe(300);
    expect(result.entered).toBe(300);
    expect(result.evicted).toBe(0);
    expect(result.dirty.length).toBe(300);
  });

  test("steady state: same set reconciles to zero dirty slots", () => {
    const ring = new FieldRingStream(CAP);
    const target = freshTarget(CAP);
    const rocks = rockSet(300);
    ring.reconcile(rocks, target);
    const before = target.base.slice();
    const result = ring.reconcile(rocks, target);
    expect(result.dirty.length).toBe(0);
    expect(result.entered).toBe(0);
    expect(result.evicted).toBe(0);
    expect(target.base).toEqual(before);
  });

  test("cell cross: kept slots untouched, entered rocks land in freed slots, evicted slots zero-radius", () => {
    const ring = new FieldRingStream(CAP);
    const target = freshTarget(CAP);
    const setA = rockSet(300);
    ring.reconcile(setA, target);
    const baseBefore = target.base.slice();
    const metaBefore = target.slotMeta.slice();

    // Replace the last 30 rocks with 30 new ids (a ~10% slab cross).
    const setB = [...setA.slice(0, 270), ...rockSet(30, 7)];
    const result = ring.reconcile(setB, target);

    expect(result.entered).toBe(30);
    expect(result.evicted).toBe(30);
    expect(result.kept).toBe(270);
    // Dirty slots = exactly the union of evicted + entered slots (here they coincide).
    expect(result.dirty.length).toBe(30);

    // Every kept rock's slot bytes are untouched.
    const dirtySet = new Set(result.dirty);
    for (let slot = 0; slot < result.drawCount; slot += 1) {
      if (dirtySet.has(slot)) continue;
      for (let k = 0; k < 4; k += 1) {
        expect(target.base[slot * 4 + k]).toBe(baseBefore[slot * 4 + k]!);
        expect(target.slotMeta[slot * 4 + k]).toBe(metaBefore[slot * 4 + k]!);
      }
    }

    // Every resident rock is at its mapped slot with the exact full-pack bytes.
    for (const r of setB) {
      const slot = ring.slotOf(r.id);
      expect(slot).not.toBeNull();
      const o = slot! * 4;
      expect(target.base[o]).toBe(Math.fround(r.position.x));
      expect(target.base[o + 1]).toBe(Math.fround(r.position.y));
      expect(target.base[o + 2]).toBe(Math.fround(r.position.z));
      expect(target.base[o + 3]).toBe(Math.fround(r.radius));
      expect(idFromSlotMeta(target.slotMeta, slot!)).toBe(r.id);
    }

    // No slot in the draw range holds an evicted rock: any non-resident slot is radius 0.
    const residentSlots = new Set(setB.map((r) => ring.slotOf(r.id)));
    for (let slot = 0; slot < result.drawCount; slot += 1) {
      if (!residentSlots.has(slot)) {
        expect(target.base[slot * 4 + 3]).toBe(0);
      }
    }
  });

  test("phase seed is slot-stable: a kept rock's packAttr.z never changes across churn", () => {
    const ring = new FieldRingStream(CAP);
    const target = freshTarget(CAP);
    const keeper = rock(1, 2, 3);
    ring.reconcile([keeper, ...rockSet(100, 1)], target);
    const slot = ring.slotOf(keeper.id)!;
    const phase = target.packAttr[slot * 4 + 2];
    ring.reconcile([keeper, ...rockSet(100, 2)], target);
    ring.reconcile([keeper, ...rockSet(100, 3)], target);
    expect(ring.slotOf(keeper.id)).toBe(slot);
    expect(target.packAttr[slot * 4 + 2]).toBe(phase!);
  });

  test("capacity clamp: only the first `capacity` rocks become resident", () => {
    const ring = new FieldRingStream(64);
    const target = freshTarget(64);
    const rocks = rockSet(100);
    const result = ring.reconcile(rocks, target);
    expect(result.drawCount).toBe(64);
    expect(result.entered).toBe(64);
    for (let i = 0; i < 64; i += 1) expect(ring.slotOf(rocks[i]!.id)).not.toBeNull();
    for (let i = 64; i < 100; i += 1) expect(ring.slotOf(rocks[i]!.id)).toBeNull();
  });

  test("fuzz: random churn keeps the ring consistent with the full pack as a set", () => {
    const ring = new FieldRingStream(CAP);
    const target = freshTarget(CAP);
    let salt = 11;
    let current: Asteroid[] = rockSet(400, salt);
    ring.reconcile(current, target);
    // 20 random churn rounds: drop a random slice, add fresh rocks.
    let seed = 1234567;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let round = 0; round < 20; round += 1) {
      salt += 1;
      const dropFrom = Math.floor(rand() * current.length);
      const dropCount = Math.floor(rand() * (current.length - dropFrom));
      const fresh = rockSet(dropCount, salt).filter((r) => !current.some((c) => c.id === r.id));
      current = [...current.slice(0, dropFrom), ...current.slice(dropFrom + dropCount), ...fresh];
      const result = ring.reconcile(current, target);
      expect(result.drawCount).toBeLessThanOrEqual(CAP);

      // Every resident rock byte-exact at its slot; slot map is a bijection.
      const seen = new Set<number>();
      for (const r of current.slice(0, CAP)) {
        const slot = ring.slotOf(r.id);
        expect(slot).not.toBeNull();
        expect(seen.has(slot!)).toBe(false);
        seen.add(slot!);
        const o = slot! * 4;
        expect(target.base[o]).toBe(Math.fround(r.position.x));
        expect(target.base[o + 3]).toBe(Math.fround(r.radius));
        expect(idFromSlotMeta(target.slotMeta, slot!)).toBe(r.id);
      }
      // All other slots draw nothing.
      for (let slot = 0; slot < CAP; slot += 1) {
        if (!seen.has(slot)) expect(target.base[slot * 4 + 3]).toBe(0);
      }
    }
  });
});

describe("mergeDirtyToRanges", () => {
  test("merges adjacent and near-adjacent slots into few vec4-element ranges", () => {
    // Slots 0,1,2 and 100,101 and 400 with gap tolerance 8 -> three ranges, in
    // ELEMENT units (slot*4) for BufferAttribute.addUpdateRange.
    const ranges = mergeDirtyToRanges([0, 1, 2, 100, 101, 400], 8, 64);
    expect(ranges).toEqual([
      { start: 0, count: 12 },
      { start: 400, count: 8 },
      { start: 1600, count: 4 },
    ]);
  });

  test("bridges gaps within tolerance", () => {
    const ranges = mergeDirtyToRanges([0, 5], 8, 64);
    expect(ranges).toEqual([{ start: 0, count: 24 }]);
  });

  test("collapses to one spanning range when the range cap is exceeded", () => {
    const dirty = Array.from({ length: 100 }, (_, i) => i * 100);
    const ranges = mergeDirtyToRanges(dirty, 1, 16);
    expect(ranges).toEqual([{ start: 0, count: (99 * 100 + 1) * 4 }]);
  });

  test("empty dirty list yields no ranges", () => {
    expect(mergeDirtyToRanges([], 8, 64)).toEqual([]);
  });
});
