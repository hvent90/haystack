// Diagnostic: find sun-aligned rock pairs near the spawn camera — a receiver rock A with
// an occluder rock B up-sun of it — and emit lookDir vantages for the shadow-diag close-up
// captures (crispness / acne / handoff evidence on a guaranteed real shadow).
import { deriveVirtualField } from "../../src/client/eve/field-core";
import { sunDirection } from "../../src/client/eve/lighting";

const field = {
  totalAsteroids: 1_000_000,
  seed: 424242,
  cellSize: 1130,
  indexKind: "cubicCellHierarchy" as const,
  renderedLimit: 50_000,
};

// Live-gate spawn (HUD p readout, meters). The camera sits ~120 m above (cockpit offset).
const ship = { x: -7100, y: 20, z: 250 };
const cam = { x: ship.x, y: ship.y + 120, z: ship.z };
const S = sunDirection;

const rocks = deriveVirtualField(ship, field);

type Hit = {
  receiver: { id: string; d: number; r: number };
  occluder: { id: string; gap: number; r: number; perp: number };
  lookDir: { x: number; y: number; z: number };
  score: number;
};
const hits: Hit[] = [];

for (const a of rocks) {
  const ax = a.position.x - cam.x;
  const ay = a.position.y - cam.y;
  const az = a.position.z - cam.z;
  const d = Math.hypot(ax, ay, az);
  if (d < 1200 || d > 4500) continue; // close enough for per-pixel detail, big on screen
  for (const b of rocks) {
    if (b === a) continue;
    const wx = b.position.x - a.position.x;
    const wy = b.position.y - a.position.y;
    const wz = b.position.z - a.position.z;
    const along = wx * S.x + wy * S.y + wz * S.z;
    if (along < 400 || along > 3500) continue; // occluder up-sun of receiver
    const px = wx - along * S.x;
    const py = wy - along * S.y;
    const pz = wz - along * S.z;
    const perp = Math.hypot(px, py, pz);
    // Partial coverage edge ON the receiver: perp within the occluder radius band means
    // the shadow edge crosses the receiver's face (the crisp-shadow money shot).
    if (perp > b.radius + a.radius * 0.5) continue;
    const score = a.radius / d + b.radius / along - perp / 1000;
    hits.push({
      receiver: { id: a.id, d: Math.round(d), r: Math.round(a.radius) },
      occluder: {
        id: b.id,
        gap: Math.round(along),
        r: Math.round(b.radius),
        perp: Math.round(perp),
      },
      lookDir: { x: ax / d, y: ay / d, z: az / d },
      score,
    });
  }
}

hits.sort((a, b) => b.score - a.score);
console.log(JSON.stringify(hits.slice(0, 8), null, 2));
