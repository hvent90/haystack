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
};

const samples = await renderSamples();
assert(samples.length > 0, "render harness returned no samples");

for (const sample of samples) {
  const peak = sample.pcm.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
  assert(peak > 0.02, `${sample.name} is silent (peak ${peak})`);

  const expected = EXPECTED_DURATION_SECONDS[sample.name];
  assert(expected !== undefined, `${sample.name} has no expected duration registered`);
  const actual = sample.pcm.length / sample.sampleRate;
  assert(
    Math.abs(actual - expected) < 0.02,
    `${sample.name} duration ${actual.toFixed(3)}s != expected ${expected}s`,
  );
}

console.log(`audio verification passed: ${samples.length} sample(s)`);
