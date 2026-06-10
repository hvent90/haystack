// Field-factory parity gate.
//
// 1. Server (field.ts queryVirtualAsteroids) vs client (field-core.ts
//    deriveVirtualField) must produce the identical rock set + order for the
//    ACTIVE preset (set HAYSTACK_FIELD_PRESET; default legacy-uniform).
// 2. The factory's legacy-uniform path must reproduce the pre-factory
//    generator bit-for-bit (original frac(sin) math inlined here as the
//    reference).
//
// Usage: bun scripts/bench/parity-factory.ts
//        HAYSTACK_FIELD_PRESET=belt-v1 bun scripts/bench/parity-factory.ts
import { fieldSummary, streamedFieldAsteroids } from "../../src/server/field";
import { deriveVirtualField } from "../../src/client/eve/field-core";
import { DEFAULT_GEOMETRY, rocksInCell, createFieldContext } from "../../src/shared/field-factory";
import { PRESETS } from "../../src/shared/field-presets";
import type { Asteroid } from "../../src/shared/types";

let failures = 0;

function check(label: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) {
    failures += 1;
  }
}

// ---- 1. server/client parity over the streamed set ----
const field = fieldSummary();
console.log(`preset: ${field.preset}, renderedLimit: ${field.renderedLimit}`);
const positions = [
  { x: 0, y: 0, z: 0 },
  { x: 15000, y: 8000, z: -12000 },
  { x: -54000, y: -54000, z: -54000 }, // field corner
  { x: 8000, y: 30000, z: 18000 },
];

function fingerprint(rocks: Asteroid[]): string {
  // FNV-ish rolling hash over ids + exact position/scalar bits
  let h = 2166136261 >>> 0;
  const mix = (s: string): void => {
    for (let i = 0; i < s.length; i += 1) {
      h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
    }
  };
  for (const rock of rocks) {
    mix(rock.id);
    mix(
      `${rock.position.x}:${rock.position.y}:${rock.position.z}:${rock.radius}:${rock.signature}:${rock.mineralRichness}:${rock.rareMineral}:${rock.pocket}`,
    );
  }
  return h.toString(16);
}

for (const position of positions) {
  const server = streamedFieldAsteroids(position);
  const client = deriveVirtualField(position, field);
  const countOk = server.length === client.length;
  let firstMismatch = -1;
  const n = Math.min(server.length, client.length);
  for (let i = 0; i < n; i += 1) {
    if (server[i]!.id !== client[i]!.id) {
      firstMismatch = i;
      break;
    }
  }
  check(
    `server==client @ (${position.x},${position.y},${position.z})`,
    countOk && firstMismatch === -1 && fingerprint(server) === fingerprint(client),
    `count ${server.length}/${client.length}, firstOrderMismatch ${firstMismatch}, fp ${fingerprint(server)}/${fingerprint(client)}`,
  );
}

// ---- 2. legacy preset reproduces the pre-factory generator exactly ----
function legacyReference(cx: number, cy: number, cz: number): Asteroid {
  const fieldSeed = 424242;
  const cellSize = 1130;
  const originOffset = -(100 * 1130) / 2;
  const minerals = ["nickel", "waterIce", "cobalt", "silicates", "platinum", "xenotime"] as const;
  const noise = (seed: number): number => {
    const x = Math.sin(seed * 12.9898) * 43758.5453;
    return x - Math.floor(x);
  };
  const seed = fieldSeed + cx * 73856093 + cy * 19349663 + cz * 83492791;
  return {
    id: `v-${cx}-${cy}-${cz}`,
    pocket: cx < 33 ? "inner-drift" : cx < 66 ? "black-thread" : "long-echo",
    position: {
      x: originOffset + cx * cellSize + noise(seed + 1) * cellSize,
      y: originOffset + cy * cellSize + noise(seed + 2) * cellSize,
      z: originOffset + cz * cellSize + noise(seed + 3) * cellSize,
    },
    radius: 45 + noise(seed + 5) * 310,
    signature: 0.08 + noise(seed + 6) * 0.7,
    mineralRichness: 0.18 + noise(seed + 7) * 0.82,
    rareMineral: minerals[Math.floor(noise(seed + 4) * 6) % 6] ?? "nickel",
    discovered: true,
  };
}

const legacy = PRESETS["legacy-uniform"]!;
const ctx = createFieldContext();
let legacyOk = true;
let checked = 0;
for (let cx = 0; cx < 100; cx += 13) {
  for (let cy = 0; cy < 100; cy += 17) {
    for (let cz = 0; cz < 100; cz += 19) {
      const rocks = rocksInCell(DEFAULT_GEOMETRY, legacy, ctx, cx, cy, cz);
      const ref = legacyReference(cx, cy, cz);
      const rock = rocks[0];
      checked += 1;
      if (
        rocks.length !== 1 ||
        rock === undefined ||
        rock.position.x !== ref.position.x ||
        rock.position.y !== ref.position.y ||
        rock.position.z !== ref.position.z ||
        rock.radius !== ref.radius ||
        rock.signature !== ref.signature ||
        rock.mineralRichness !== ref.mineralRichness ||
        ["nickel", "waterIce", "cobalt", "silicates", "platinum", "xenotime"][rock.mineralIndex] !==
          ref.rareMineral
      ) {
        legacyOk = false;
        console.log(`  legacy mismatch at cell ${cx},${cy},${cz}`);
      }
    }
  }
}
check(`legacy-uniform == pre-factory generator (bit-exact)`, legacyOk, `${checked} cells`);

process.exit(failures === 0 ? 0 : 1);
