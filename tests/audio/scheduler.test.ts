import { describe, expect, test } from "bun:test";
import { nextBeatTimes } from "../../src/client/audio/scheduler";

describe("nextBeatTimes", () => {
  test("returns beats within the window aligned to interval", () => {
    expect(nextBeatTimes(0, 0.25, 0.1, 0)).toEqual([0, 0.1, 0.2]);
  });
  test("starts at the first beat at or after fromTime", () => {
    expect(nextBeatTimes(0.15, 0.45, 0.1, 0)).toEqual([0.2, 0.3, 0.4]);
  });
  test("empty when window has no beat", () => {
    expect(nextBeatTimes(0.21, 0.29, 0.1, 0)).toEqual([]);
  });
});
