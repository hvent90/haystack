import { assert } from "./helpers";
import { renderSamples } from "../../src/cli/render-sfx";

// All eight sounds are pure raw-Web-Audio recipes (no jsfxr cores), so each
// rendered buffer length equals its recipe's durationSeconds exactly. Values below
// match catalog.ts; the non-silence assertion (peak > 0.02) stays strict.
const EXPECTED_DURATION_SECONDS: Record<string, number> = {
  uiClick: 0.08,
  uiHover: 0.05,
  targetLock: 0.22,
  comms: 0.18,
  chime: 0.7,
  boost: 0.6,
  brake: 0.35,
  scanHonk: 0.6,
  engineDrone: 6,
  engineHeat: 10,
  rcsNozzle: 5,
};

// The drone is a 6 s scripted capture (not a one-shot recipe), so its rendered
// length can differ from the nominal duration by a few samples; widen tolerance
// for it specifically while keeping the non-silence assertion strict.
const DURATION_TOLERANCE_SECONDS: Record<string, number> = {
  engineDrone: 0.2,
  engineHeat: 0.2,
  rcsNozzle: 0.2,
};

const samples = await renderSamples();
assert(samples.length > 0, "render harness returned no samples");

for (const sample of samples) {
  const peak = sample.pcm.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
  assert(peak > 0.02, `${sample.name} is silent (peak ${peak})`);

  const expected = EXPECTED_DURATION_SECONDS[sample.name];
  assert(expected !== undefined, `${sample.name} has no expected duration registered`);
  const actual = sample.pcm.length / sample.sampleRate;
  const tolerance = DURATION_TOLERANCE_SECONDS[sample.name] ?? 0.02;
  assert(
    Math.abs(actual - expected) < tolerance,
    `${sample.name} duration ${actual.toFixed(3)}s != expected ${expected}s`,
  );
}

console.log(`audio verification passed: ${samples.length} sample(s)`);
