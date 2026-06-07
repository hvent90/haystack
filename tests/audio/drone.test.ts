import { describe, expect, test } from "bun:test";
import { engineDroneMasterGain } from "../../src/client/audio/drone";

describe("engineDroneMasterGain", () => {
  test("keeps a stopped idle ship effectively silent", () => {
    expect(
      engineDroneMasterGain({
        throttle: 0,
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
      boost: false,
      heat: 10,
      cruiseLock: false,
      speed: 120,
    });
    expect(coasting).toBeGreaterThan(0.08);
    expect(coasting).toBeLessThan(0.2);
  });
});
