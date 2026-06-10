import type { ScanMode, UpgradeSystem } from "../../shared/types";
import type { ChatChannel, WindowDefinition } from "./types";

export const localPilotKey = "haystack.pilotId";
export const flightInputIntervalMs = 1000 / 60;
// The owned-ship predictor advances by ELAPSED WALL TIME (a fixed-step accumulator),
// not by how often the input timer happens to fire. Under main-thread contention
// the timer fires late; without this the client would predict fewer 1/60 steps per
// wall-second than the server integrates, so the predicted pose lags and every ack
// snaps (the jerk). `maxFlightCatchupSec` bounds the catch-up after a real stall
// (e.g. a backgrounded tab) so resume produces one reconcile, not a huge burst.
export const maxFlightCatchupSec = 0.25;
export const maxFlightStepsPerTick = 16;
export const flightInputScaleMax = 1;
export const flightInputScaleMin = 0.001;
export const flightInputScaleWheelDivisor = 480;
export const mouseSensitivity = 0.0026;
export const relativeMouseDecay = 0.9;
export const throttleStep = 0.25;
export const scannerModes: ScanMode[] = ["belt", "pocket", "surface"];
export const chatChannels: ChatChannel[] = ["global", "belt", "dm"];
export const upgradeSystems: UpgradeSystem[] = ["cargo", "scanner", "mining", "stabilizer"];

export const reservedTop = 56;
export const mobileReservedTop = 96;
export const reservedLeft = 52;
export const titlebarHeight = 30;
export const windowMargin = 8;

export const windowDefinitions: WindowDefinition[] = [
  {
    key: "flight",
    label: "Flight",
    minWidth: 240,
    minHeight: 160,
    defaultState: { x: 60, y: 62, width: 270, height: 212, open: true, minimized: false, z: 10 },
  },
  {
    key: "scanner",
    label: "Scanner",
    minWidth: 360,
    minHeight: 260,
    defaultState: { x: 344, y: 62, width: 430, height: 360, open: true, minimized: false, z: 20 },
  },
  {
    key: "cargo",
    label: "Cargo",
    minWidth: 280,
    minHeight: 230,
    defaultState: { x: 790, y: 62, width: 310, height: 300, open: true, minimized: false, z: 30 },
  },
  {
    key: "comms",
    label: "Comms",
    minWidth: 330,
    minHeight: 260,
    defaultState: { x: 60, y: 292, width: 410, height: 340, open: true, minimized: false, z: 40 },
  },
  {
    key: "character",
    label: "Character",
    minWidth: 300,
    minHeight: 220,
    defaultState: { x: 488, y: 438, width: 360, height: 250, open: true, minimized: false, z: 50 },
  },
  {
    key: "bases",
    label: "Bases",
    minWidth: 340,
    minHeight: 260,
    defaultState: { x: 862, y: 378, width: 390, height: 310, open: true, minimized: false, z: 60 },
  },
];

export const windowDefinitionByKey = Object.fromEntries(
  windowDefinitions.map((definition) => [definition.key, definition]),
) as Record<WindowDefinition["key"], WindowDefinition>;

export const upgradeLabels: Record<UpgradeSystem, string> = {
  cargo: "Cargo Rack",
  scanner: "Scanner",
  mining: "Mining Head",
  stabilizer: "Stabilizer",
};
