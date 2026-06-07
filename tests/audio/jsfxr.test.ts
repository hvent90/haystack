// jsfxr v1.4.1 confirmed API surface (2026-06-07):
//   import { sfxr } from "jsfxr"
//   sfxr.generate(preset: string): Params  — generates sound params using a named preset
//     Available presets: "pickupCoin", "laserShoot", "explosion", "powerUp", "hitHurt",
//     "jump", "blipSelect", "synth", "tone", "click", "random"
//   sfxr.toBuffer(synthdef: Params): number[]  — returns raw 16-bit PCM byte array
//     (pairs of low/high bytes; values are 0-255 integers, NOT floats)
//   sfxr.toWave(synthdef: Params): RIFFWAVE — returns RIFFWAVE object with:
//     .dataURI: string — "data:audio/wav;base64,..." WAV data URI
//     .buffer: number[] — normalized float samples (-1..1)
//   sfxr.toWebAudio(synthdef, audiocontext): AudioBufferSourceNode — browser-only
//   sfxr.play(synthdef): void — browser-only (calls AudioContext)
//
// Plan 2 reference: use sfxr.toWave(sound).buffer for float PCM data,
//   or sfxr.toWebAudio(sound, ctx) for direct Web Audio integration.

import { describe, expect, test } from "bun:test";
import { sfxr } from "jsfxr";

describe("jsfxr", () => {
  test("generates a non-silent sample buffer in pure JS", () => {
    const sound = sfxr.generate("blipSelect");
    const buffer = sfxr.toBuffer(sound);
    expect(buffer.length).toBeGreaterThan(0);
    const peak = buffer.reduce((max: number, sample: number) => Math.max(max, Math.abs(sample)), 0);
    expect(peak).toBeGreaterThan(0.01);
  });

  test("toWave returns a WAV data URI", () => {
    const sound = sfxr.generate("blipSelect");
    const wave = sfxr.toWave(sound);
    expect(typeof wave.dataURI).toBe("string");
    expect(wave.dataURI.startsWith("data:audio/wav")).toBe(true);
  });
});
