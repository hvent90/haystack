import { describe, expect, test } from "bun:test";
import { defaultMix, setBus, setMaster, setMuted } from "../../src/client/audio/mix";
import { spatialDroneGainForState, spatialMasterVolume } from "../../src/client/audio/spatial";

describe("spatialMasterVolume", () => {
  test("is master * engine bus when unmuted", () => {
    const mix = setBus(setMaster(defaultMix(), 0.5), "engine", 0.6);
    expect(spatialMasterVolume(mix)).toBeCloseTo(0.3, 5);
  });
  test("is zero when muted", () => {
    expect(spatialMasterVolume(setMuted(defaultMix(), true))).toBe(0);
  });
});

describe("spatialDroneGainForState", () => {
  test("keeps idle parked remote ships effectively silent", () => {
    expect(spatialDroneGainForState({ throttle: 0, heat: 0, speed: 0 })).toBeLessThan(0.001);
  });

  test("opens remote drone gain for moving or throttling ships", () => {
    expect(spatialDroneGainForState({ throttle: 0.8, heat: 15, speed: 40 })).toBeGreaterThan(0.25);
    expect(spatialDroneGainForState({ throttle: 0, heat: 15, speed: 90 })).toBeGreaterThan(0.1);
  });
});
