export type BusName = "engine" | "sfx" | "ui" | "alarm";

export const BUS_NAMES: readonly BusName[] = ["engine", "sfx", "ui", "alarm"];

/** One-shot SFX identifiers. Plan 1 implements `uiClick`; the rest land in Plan 2. */
export type OneShotId =
  | "uiClick"
  | "uiHover"
  | "targetLock"
  | "comms"
  | "boost"
  | "brake"
  | "scanHonk"
  | "chime";

/** Continuous engine state fed from the ship snapshot each flight tick (Plan 3). */
export interface EngineState {
  throttle: number; // -1..1 main fore/aft engine
  rcs: number; // 0..1 translation (strafe) RCS thruster activity
  rotation: number; // 0..1 angular (attitude) RCS thruster activity
  boost: boolean;
  heat: number; // 0..100
  cruiseLock: boolean;
  speed: number; // m/s magnitude
}
