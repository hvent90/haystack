// Micro-bench: where do the ~158ms of InstancedAsteroids' useLayoutEffect go?
// Replicates packBaseFromAsteroids (pack loop incl. id.split) and the seed* dst.set calls
// at 50k, isolating each phase. Run under node (V8 — same engine as Chrome).
const N = 50_000;
const CAP = 50_000;

// Fake but shape-identical rocks (id format v-cx-cy-cz, numeric fields).
const rocks = new Array(N);
for (let i = 0; i < N; i++) {
  rocks[i] = {
    id: `v-${i % 100}-${(i * 7) % 100}-${(i * 13) % 100}`,
    position: { x: i * 1.5, y: i * 2.5, z: i * 3.5 },
    radius: 45 + (i % 310),
    mineralRichness: 0.18 + (i % 100) / 125,
  };
}

function phaseSeed(index) {
  const v = Math.sin(index * 0.1) * 43758.5453;
  return (v - Math.floor(v)) * Math.PI * 2;
}

function packFromRocks(rocksIn, capacity, residencyEpoch) {
  const count = Math.min(rocksIn.length, capacity);
  const base = new Float32Array(capacity * 4);
  const packAttr = new Float32Array(capacity * 4);
  const slotMeta = new Uint32Array(capacity * 4);
  for (let i = 0; i < count; i += 1) {
    const r = rocksIn[i];
    const o = i * 4;
    base[o] = r.position.x;
    base[o + 1] = r.position.y;
    base[o + 2] = r.position.z;
    base[o + 3] = r.radius;
    packAttr[o + 1] = r.mineralRichness;
    packAttr[o + 2] = phaseSeed(i);
    const parts = r.id.split("-");
    slotMeta[o] = Number(parts[1]);
    slotMeta[o + 1] = Number(parts[2]);
    slotMeta[o + 2] = Number(parts[3]);
    slotMeta[o + 3] = residencyEpoch;
  }
  return { base, packAttr, slotMeta, count };
}

const dstF1 = new Float32Array(CAP * 4);
const dstF2 = new Float32Array(CAP * 4);
const dstU = new Uint32Array(CAP * 4);

for (let round = 0; round < 5; round++) {
  let t0 = performance.now();
  const derived = packFromRocks(rocks, CAP, round);
  let t1 = performance.now();
  dstF1.set(derived.base);
  dstF2.set(derived.packAttr);
  dstU.set(derived.slotMeta);
  let t2 = performance.now();
  console.log(
    `round ${round}: pack=${(t1 - t0).toFixed(1)}ms  seed(set)=${(t2 - t1).toFixed(2)}ms`,
  );
}

// Phase isolation: allocations only, loop without split, split only.
let t0 = performance.now();
for (let r = 0; r < 5; r++) {
  new Float32Array(CAP * 4);
  new Float32Array(CAP * 4);
  new Uint32Array(CAP * 4);
}
console.log(`alloc x5: ${(performance.now() - t0).toFixed(1)}ms`);

t0 = performance.now();
let acc = 0;
for (let r = 0; r < 5; r++) {
  for (let i = 0; i < N; i++) {
    const parts = rocks[i].id.split("-");
    acc += Number(parts[1]) + Number(parts[2]) + Number(parts[3]);
  }
}
console.log(`split x5: ${(performance.now() - t0).toFixed(1)}ms (acc=${acc})`);
