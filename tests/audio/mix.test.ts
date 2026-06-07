import { describe, expect, test } from "bun:test";
import {
  defaultMix,
  deserializeMix,
  serializeMix,
  setBus,
  setMaster,
  setMuted,
} from "../../src/client/audio/mix";

describe("mix model", () => {
  test("defaultMix has master, mute, and all four buses", () => {
    const mix = defaultMix();
    expect(mix.master).toBeGreaterThan(0);
    expect(mix.muted).toBe(false);
    expect(Object.keys(mix.buses).sort()).toEqual(["alarm", "engine", "sfx", "ui"]);
  });

  test("setMaster clamps to 0..1", () => {
    expect(setMaster(defaultMix(), 5).master).toBe(1);
    expect(setMaster(defaultMix(), -5).master).toBe(0);
  });

  test("setBus clamps and only changes the named bus", () => {
    const mix = setBus(defaultMix(), "engine", 2);
    expect(mix.buses.engine).toBe(1);
    expect(mix.buses.ui).toBe(defaultMix().buses.ui);
  });

  test("setMuted toggles without changing volumes", () => {
    const mix = setMuted(defaultMix(), true);
    expect(mix.muted).toBe(true);
    expect(mix.master).toBe(defaultMix().master);
  });

  test("serialize/deserialize round-trips", () => {
    const mix = setMuted(setBus(defaultMix(), "alarm", 0.3), true);
    expect(deserializeMix(serializeMix(mix))).toEqual(mix);
  });

  test("deserializeMix falls back to defaults on garbage or null", () => {
    expect(deserializeMix(null)).toEqual(defaultMix());
    expect(deserializeMix("not json")).toEqual(defaultMix());
    expect(deserializeMix("{}").buses.engine).toBe(defaultMix().buses.engine);
  });
});
