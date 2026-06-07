import { describe, expect, test } from "bun:test";
import { defaultMix, setBus, setMaster, setMuted } from "../../src/client/audio/mix";
import { spatialMasterVolume } from "../../src/client/audio/spatial";

describe("spatialMasterVolume", () => {
  test("is master * engine bus when unmuted", () => {
    const mix = setBus(setMaster(defaultMix(), 0.5), "engine", 0.6);
    expect(spatialMasterVolume(mix)).toBeCloseTo(0.3, 5);
  });
  test("is zero when muted", () => {
    expect(spatialMasterVolume(setMuted(defaultMix(), true))).toBe(0);
  });
});
