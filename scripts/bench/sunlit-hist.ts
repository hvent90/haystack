// Diagnostic: distribution of the Tier-2 per-instance sun-occlusion scalar (aSunlit)
// over the actual resident field at the spawn region. Answers "is the deep field a
// black wall / bright wall / varied?" without a device.
import { deriveVirtualField } from "../../src/client/eve/field-core";
import { computeSunlit } from "../../src/client/eve/sun-occlusion";

const field = {
  totalAsteroids: 1_000_000,
  seed: 424242,
  cellSize: 1130,
  indexKind: "cubicCellHierarchy" as const,
  renderedLimit: Number(process.env.LIMIT ?? 50_000),
};

const pos = { x: -7100, y: 20, z: 250 }; // live-gate spawn (HUD p readout)
const rocks = deriveVirtualField(pos, field);
console.log(`rocks=${rocks.length}`);

const t0 = performance.now();
const values: number[] = [];
for (const r of rocks) {
  const [, cx, cy, cz] = r.id.split("-").map(Number);
  values.push(computeSunlit(cx!, cy!, cz!));
}
const ms = performance.now() - t0;

const bins = new Array(10).fill(0);
let sum = 0;
for (const v of values) {
  bins[Math.min(9, Math.floor(v * 10))] += 1;
  sum += v;
}
console.log(
  `computeSunlit total ${ms.toFixed(0)}ms (${((ms * 1000) / rocks.length).toFixed(1)}us/rock)`,
);
console.log(`mean=${(sum / values.length).toFixed(3)}`);
for (let i = 0; i < 10; i += 1) {
  const pct = ((bins[i] / values.length) * 100).toFixed(1);
  console.log(
    `[${(i / 10).toFixed(1)},${((i + 1) / 10).toFixed(1)}) ${pct.padStart(5)}%  ${"#".repeat(Math.round(Number(pct) / 2))}`,
  );
}
