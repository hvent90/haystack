import type { ScanMode, Vector3 } from "../../shared/types";

export type WindowKey =
  | "flight"
  | "scanner"
  | "cargo"
  | "comms"
  | "character"
  | "bases"
  | "settings";

export type WindowState = {
  x: number;
  y: number;
  width: number;
  height: number;
  open: boolean;
  minimized: boolean;
  z: number;
};

export type WindowDefinition = {
  key: WindowKey;
  label: string;
  minWidth: number;
  minHeight: number;
  defaultState: WindowState;
};

export type LayoutState = Record<WindowKey, WindowState>;

export type OverviewKind = "asteroid" | "deposit" | "pocket" | "ship" | "structure";
export type OverviewFilter = "all" | "asteroids" | "structures" | "ships" | "signals";
export type SortField = "type" | "name" | "distance" | "strength" | "bearing";
export type SortDirection = "asc" | "desc";

export type Selection = {
  kind: OverviewKind;
  id: string;
};

export type OverviewRow = Selection & {
  key: string;
  name: string;
  distance: number;
  strength: number;
  bearing: Vector3;
  clue: string;
  position: Vector3 | null;
  asteroidId?: string;
};

export type ContextMenuState = {
  x: number;
  y: number;
  target: Selection | null;
};

export type Waypoint = {
  id: string;
  kind: OverviewKind;
  name: string;
  position: Vector3;
};

export type ChatChannel = "global" | "belt" | "dm";

export type FlightMode = "cursor" | "flight";

export type OneShotFlightInput = {
  boost: boolean;
};

export type SortState = {
  field: SortField;
  direction: SortDirection;
};

export type ScanModeState = ScanMode;
