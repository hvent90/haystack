// Numeric smoke test for the field factory: rock counts, density, archetype
// mix and query timing per preset, over a 12 km sphere at the field center.
import { DEFAULT_GEOMETRY, rocksInSphere } from "../../src/shared/field-factory";
import { PRESETS } from "../../src/shared/field-presets";

const radius = Number(process.argv[2] ?? 12000);
const origin = { x: 0, y: 0, z: 0 };

for (const [name, preset] of Object.entries(PRESETS)) {
  const start = performance.now();
  const rocks = rocksInSphere(DEFAULT_GEOMETRY, preset, origin, radius);
  const ms = performance.now() - start;
  const volume = (4 / 3) * Math.PI * Math.pow(radius / 1000, 3); // km^3
  const byArchetype = new Map<string, number>();
  let radiusSum = 0;
  let maxR = 0;
  for (const rock of rocks) {
    byArchetype.set(rock.archetype, (byArchetype.get(rock.archetype) ?? 0) + 1);
    radiusSum += rock.radius;
    maxR = Math.max(maxR, rock.radius);
  }
  const mix = [...byArchetype.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}:${v}`)
    .join(" ");
  console.log(
    `${name.padEnd(16)} ${String(rocks.length).padStart(6)} rocks  ` +
      `${(rocks.length / volume).toFixed(2).padStart(6)} /km³  ` +
      `avgR ${(radiusSum / Math.max(1, rocks.length)).toFixed(0).padStart(4)}m  ` +
      `maxR ${maxR.toFixed(0).padStart(4)}m  ${ms.toFixed(0).padStart(5)}ms  ${mix}`,
  );
}
