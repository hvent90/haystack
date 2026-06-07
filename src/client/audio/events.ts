const ALARM_ON = 92;
const ALARM_OFF = 85; // hysteresis so it doesn't chatter at the boundary

export type AlarmTransition = "on" | "off" | "none";

/** Edge-detect the overheat alarm from previous->next heat with hysteresis. */
export function alarmTransition(prevHeat: number, nextHeat: number): AlarmTransition {
  const wasOn = prevHeat >= ALARM_ON;
  if (!wasOn && nextHeat >= ALARM_ON) {
    return "on";
  }
  if (wasOn && nextHeat < ALARM_OFF) {
    return "off";
  }
  return "none";
}
