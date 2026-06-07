import { describe, expect, test } from "bun:test";
import { alarmTransition } from "../../src/client/audio/events";

describe("alarmTransition", () => {
  test("turns on when crossing up through the threshold", () => {
    expect(alarmTransition(90, 94)).toBe("on");
  });
  test("turns off when dropping back below (hysteresis)", () => {
    expect(alarmTransition(94, 80)).toBe("off");
  });
  test("no change while staying above", () => {
    expect(alarmTransition(94, 96)).toBe("none");
  });
  test("no change while staying below", () => {
    expect(alarmTransition(50, 70)).toBe("none");
  });
});
