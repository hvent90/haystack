export type Vector3 = {
  x: number;
  y: number;
  z: number;
};

export type Quaternion = {
  x: number;
  y: number;
  z: number;
  w: number;
};

export type Mineral = "cobalt" | "nickel" | "platinum" | "silicates" | "waterIce" | "xenotime";

export type ScanMode = "belt" | "pocket" | "surface";

export type Pilot = {
  id: string;
  callsign: string;
  organization: string;
  createdAt: string;
};

export type CharacterCard = Pilot & {
  shipName: string;
  cargoMass: number;
  cargoCapacity: number;
  credits: number;
  scanPower: number;
  miningPower: number;
};

export type OrganizationSummary = {
  name: string;
  memberCount: number;
  activeShipCount: number;
  totalCargoMass: number;
  totalCredits: number;
};

export type Ship = {
  pilotId: string;
  name: string;
  position: Vector3;
  velocity: Vector3;
  orientation: Quaternion;
  angularVelocity: Vector3;
  throttle: number;
  cruiseLock: boolean;
  navLightsOn: boolean;
  flashlightOn: boolean;
  heat: number;
  cargoMass: number;
  cargoCapacity: number;
  scanPower: number;
  miningPower: number;
  stabilizerEfficiency: number;
};

export type UpgradeSystem = "cargo" | "scanner" | "mining" | "stabilizer";

export type Asteroid = {
  id: string;
  pocket: string;
  position: Vector3;
  radius: number;
  signature: number;
  mineralRichness: number;
  rareMineral: Mineral;
  discovered: boolean;
};

export type Deposit = {
  id: string;
  asteroidId: string;
  mineral: Mineral;
  abundance: number;
  latitude: number;
  longitude: number;
  remaining: number;
  discovered: boolean;
};

export type Structure = {
  id: string;
  ownerPilotId: string | null;
  kind: "forwardHab" | "relay" | "station";
  name: string;
  position: Vector3;
  signature: number;
  hidden: boolean;
  discovered: boolean;
};

export type FieldSummary = {
  totalAsteroids: number;
  seed: number;
  cellSize: number;
  indexKind: "cubicCellHierarchy";
  renderedLimit: number;
};

export type ChatMessage = {
  id: string;
  channel: string;
  fromPilotId: string;
  toPilotId: string | null;
  fromCallsign: string;
  body: string;
  createdAt: string;
};

export type ScanHit = {
  id: string;
  kind: "asteroid" | "deposit" | "pocket" | "ship" | "structure";
  label: string;
  distance: number;
  strength: number;
  bearing: Vector3;
  clue: string;
};

export type ScanReport = {
  mode: ScanMode;
  pulseId: string;
  origin: Vector3;
  heatAdded: number;
  hits: ScanHit[];
};

export type CargoItem = {
  mineral: Mineral;
  mass: number;
};

export type WorldSnapshot = {
  serverTime: string;
  field: FieldSummary;
  me: CharacterCard | null;
  pilots: CharacterCard[];
  activePilotIds: string[];
  organizations: OrganizationSummary[];
  ships: Ship[];
  asteroids: Asteroid[];
  deposits: Deposit[];
  structures: Structure[];
  cargo: CargoItem[];
  chat: ChatMessage[];
};

export type CreatePilotRequest = {
  callsign: string;
  organization?: string;
};

export type ThrustCommand = {
  impulse: Vector3;
  angularImpulse?: Vector3;
  frame?: "world" | "local";
  stabilize?: boolean;
  boost?: boolean;
};

export type FlightInputCommand = {
  kind: "flight";
  throttle: number;
  strafe: Vector3;
  rotation: Vector3;
  active?: boolean;
  stabilize?: boolean;
  boost?: boolean;
  cruiseLock?: boolean;
  navLights?: boolean;
  flashlight?: boolean;
};

export type ScanRequest = {
  mode: ScanMode;
  targetAsteroidId?: string;
  mineral?: Mineral;
};

export type MineRequest = {
  asteroidId: string;
  depositId: string;
};

export type MineResult = {
  deposit: Deposit;
  cargo: CargoItem[];
  minedMass: number;
};

export type SellRequest = {
  mineral?: Mineral;
  mass?: number;
};

export type SellResult = {
  cargo: CargoItem[];
  soldMass: number;
  creditsEarned: number;
  credits: number;
};

export type BuildBaseRequest = {
  name?: string;
  hidden?: boolean;
};

export type BuildBaseResult = {
  structure: Structure;
  credits: number;
};

export type UpgradeRequest = {
  system: UpgradeSystem;
};

export type UpgradeResult = {
  ship: Ship;
  system: UpgradeSystem;
  cost: number;
  credits: number;
};

export type FieldDiagnostic = FieldSummary & {
  queryOrigin: Vector3;
  queryRadius: number;
  cellsVisited: number;
  materializedAsteroids: number;
  hits: ScanHit[];
};

export type ChatRequest = {
  channel: string;
  fromPilotId: string;
  toPilotId?: string;
  body: string;
};

export type WorldSnapshotKey = keyof WorldSnapshot;

export type WorldSnapshotPatch = Partial<WorldSnapshot>;

export type WorldStreamClientMessage =
  | {
      type: "subscribe";
      pilotId: string;
    }
  | {
      type: "input";
      pilotId: string;
      clientTick: number;
      command: ThrustCommand | FlightInputCommand;
    };

export type WorldStreamServerMessage =
  | {
      type: "hello";
      protocol: "haystack.world.v1";
      peerId: string;
      tick: number;
      serverTimeMs: number;
      snapshot: WorldSnapshot;
    }
  | {
      type: "delta";
      tick: number;
      serverTimeMs: number;
      changed: WorldSnapshotKey[];
      patch: WorldSnapshotPatch;
    }
  | {
      type: "ack";
      tick: number;
      serverTimeMs: number;
      ackClientTick: number;
      clientTick: number;
      ship: Ship;
    }
  | {
      type: "error";
      message: string;
    };
