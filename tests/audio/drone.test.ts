import { describe, expect, test } from "bun:test";
import { engineDroneMasterGain } from "../../src/client/audio/drone";
import { rcsNozzleGain } from "../../src/client/audio/nozzle";

describe("engineDroneMasterGain", () => {
  test("keeps a stopped idle ship effectively silent", () => {
    expect(
      engineDroneMasterGain({
        throttle: 0,
        rcs: 0,
        rotation: 0,
        boost: false,
        heat: 0,
        cruiseLock: false,
        speed: 0,
      }),
    ).toBeLessThan(0.001);
  });

  test("opens the engine bed under real drive activity", () => {
    expect(
      engineDroneMasterGain({
        throttle: 1,
        rcs: 0,
        rotation: 0,
        boost: false,
        heat: 20,
        cruiseLock: false,
        speed: 90,
      }),
    ).toBeGreaterThan(0.45);
  });

  test("keeps coasting ships audible without using the full throttle level", () => {
    const coasting = engineDroneMasterGain({
      throttle: 0,
      rcs: 0,
      rotation: 0,
      boost: false,
      heat: 10,
      cruiseLock: false,
      speed: 120,
    });
    expect(coasting).toBeGreaterThan(0.08);
    expect(coasting).toBeLessThan(0.2);
  });

  test("opens the roar for strafe (translation RCS) — regular-thruster sound", () => {
    const strafing = engineDroneMasterGain({
      throttle: 0,
      rcs: 0.15,
      rotation: 0,
      boost: false,
      heat: 0,
      cruiseLock: false,
      speed: 0,
    });
    expect(strafing).toBeGreaterThan(0.15);
  });

  test("roar ignores rotation — that drives the nozzle, not the engine", () => {
    const rotatingOnly = engineDroneMasterGain({
      throttle: 0,
      rcs: 0,
      rotation: 1,
      boost: false,
      heat: 0,
      cruiseLock: false,
      speed: 0,
    });
    expect(rotatingOnly).toBeLessThan(0.001);
  });
});

describe("rcsNozzleGain", () => {
  test("is silent with no rotation input", () => {
    expect(
      rcsNozzleGain({
        throttle: 1,
        rcs: 0,
        rotation: 0,
        boost: false,
        heat: 0,
        cruiseLock: false,
        speed: 120,
      }),
    ).toBe(0);
  });

  test("opens the nozzle for rotation thrusters alone", () => {
    expect(
      rcsNozzleGain({
        throttle: 0,
        rcs: 0,
        rotation: 0.4,
        boost: false,
        heat: 0,
        cruiseLock: false,
        speed: 0,
      }),
    ).toBeGreaterThan(0.1);
  });

  test("keeps tiny aiming nudges quiet (gentle perceptual curve)", () => {
    // A small mouse correction should barely whisper, not snap to a fixed floor —
    // this is what makes constant aiming pleasant rather than fatiguing.
    expect(
      rcsNozzleGain({
        throttle: 0,
        rcs: 0,
        rotation: 0.1,
        boost: false,
        heat: 0,
        cruiseLock: false,
        speed: 0,
      }),
    ).toBeLessThan(0.07);
  });

  test("ignores strafe (rcs) — translation is the engine roar, not the nozzle", () => {
    expect(
      rcsNozzleGain({
        throttle: 0,
        rcs: 1,
        rotation: 0,
        boost: false,
        heat: 0,
        cruiseLock: false,
        speed: 0,
      }),
    ).toBe(0);
  });
});
