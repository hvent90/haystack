import type { FlightInputCommand, Quaternion, Ship, ThrustCommand, Vector3 } from "../shared/types";
import {
  applyThrustCommand,
  integrateShipTick,
  isFlightInputCommand,
  normalizeQuaternion,
  receiveFlightInput,
  roundShip,
  shipFixedDt,
  type HeldFlightInput,
} from "../shared/ship-motion";
import type { HaystackDb } from "./db";
import { metrics } from "./metrics";

export enum ActorRole {
  Authoritative = "authoritative",
  SimulatedProxy = "simulated-proxy",
  AutonomousProxy = "autonomous-proxy",
}

export enum TickGroup {
  PrePhysics = 0,
  Physics = 1,
  PostPhysics = 2,
  PostUpdateWork = 3,
}

export const tickGroupOrder: readonly TickGroup[] = [
  TickGroup.PrePhysics,
  TickGroup.Physics,
  TickGroup.PostPhysics,
  TickGroup.PostUpdateWork,
];

export type ReplicatedValue = number | Quaternion | Vector3;
export type ReplicatedSnapshot = Record<string, ReplicatedValue>;

export type ReplicatedField = {
  name: string;
  get: (actor: Actor) => ReplicatedValue;
};

export abstract class Actor {
  role = ActorRole.Authoritative;
  tickGroup = TickGroup.PrePhysics;
  abstract readonly id: string;
  abstract update(dt: number): void;
  static readonly replicatedProperties: readonly ReplicatedField[] = [];
}

type ShipRow = {
  pilot_id: string;
  name: string;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
  wx: number;
  wy: number;
  wz: number;
  throttle: number;
  cruise_lock: number;
  nav_lights: number;
  flashlight: number;
  heat: number;
  cargo_mass: number;
  cargo_capacity: number;
  scan_power: number;
  mining_power: number;
  stabilizer_efficiency: number;
};

type PendingInput = {
  pilotId: string;
  command: ThrustCommand | FlightInputCommand;
};

export type EngineActorDiagnostic = {
  id: string;
  className: string;
  role: ActorRole;
  tickGroup: TickGroup;
  replicatedFields: string[];
};

export type EngineDiagnostic = {
  fixedDt: number;
  frame: number;
  currentTick: number;
  simTime: number;
  actorCount: number;
  authoritativeCount: number;
  lastCaptureCount: number;
  actors: EngineActorDiagnostic[];
  lastCapture: Record<string, ReplicatedSnapshot>;
};

export class ShipActor extends Actor {
  static override readonly replicatedProperties: readonly ReplicatedField[] = [
    {
      name: "pos",
      get: (actor) => cloneVector((actor as ShipActor).position),
    },
    {
      name: "vel",
      get: (actor) => cloneVector((actor as ShipActor).velocity),
    },
    {
      name: "orient",
      get: (actor) => cloneQuaternion((actor as ShipActor).orientation),
    },
    {
      name: "angVel",
      get: (actor) => cloneVector((actor as ShipActor).angularVelocity),
    },
    {
      name: "throttle",
      get: (actor) => (actor as ShipActor).throttle,
    },
    {
      name: "cruiseLock",
      get: (actor) => ((actor as ShipActor).cruiseLock ? 1 : 0),
    },
    {
      name: "navLights",
      get: (actor) => ((actor as ShipActor).navLightsOn ? 1 : 0),
    },
    {
      name: "flashlight",
      get: (actor) => ((actor as ShipActor).flashlightOn ? 1 : 0),
    },
    {
      name: "heat",
      get: (actor) => (actor as ShipActor).heat,
    },
    {
      name: "cargoMass",
      get: (actor) => (actor as ShipActor).cargoMass,
    },
  ];

  override readonly id: string;
  override readonly tickGroup = TickGroup.PostPhysics;
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
  private heldInput: HeldFlightInput | null = null;
  private inputFreshFor = 0;

  constructor(row: ShipRow) {
    super();
    this.id = row.pilot_id;
    this.name = row.name;
    this.position = { x: row.x, y: row.y, z: row.z };
    this.velocity = { x: row.vx, y: row.vy, z: row.vz };
    this.orientation = normalizeQuaternion({ x: row.qx, y: row.qy, z: row.qz, w: row.qw });
    this.angularVelocity = { x: row.wx, y: row.wy, z: row.wz };
    this.throttle = clamp(row.throttle, -1, 1);
    this.cruiseLock = row.cruise_lock === 1;
    this.navLightsOn = row.nav_lights === 1;
    this.flashlightOn = row.flashlight === 1;
    this.heat = row.heat;
    this.cargoMass = row.cargo_mass;
    this.cargoCapacity = row.cargo_capacity;
    this.scanPower = row.scan_power;
    this.miningPower = row.mining_power;
    this.stabilizerEfficiency = row.stabilizer_efficiency;
  }

  syncFromRow(row: ShipRow): void {
    this.name = row.name;
    this.position = { x: row.x, y: row.y, z: row.z };
    this.velocity = { x: row.vx, y: row.vy, z: row.vz };
    this.orientation = normalizeQuaternion({ x: row.qx, y: row.qy, z: row.qz, w: row.qw });
    this.angularVelocity = { x: row.wx, y: row.wy, z: row.wz };
    this.throttle = clamp(row.throttle, -1, 1);
    this.cruiseLock = row.cruise_lock === 1;
    this.navLightsOn = row.nav_lights === 1;
    this.flashlightOn = row.flashlight === 1;
    this.heat = row.heat;
    this.cargoMass = row.cargo_mass;
    this.cargoCapacity = row.cargo_capacity;
    this.scanPower = row.scan_power;
    this.miningPower = row.mining_power;
    this.stabilizerEfficiency = row.stabilizer_efficiency;
  }

  applyThrust(command: ThrustCommand): void {
    this.assignShip(applyThrustCommand(this.toUnroundedShip(), command));
  }

  applyFlightInput(command: FlightInputCommand): void {
    const receipt = receiveFlightInput(this.toUnroundedShip(), command);
    this.assignShip(receipt.ship);
    this.heldInput = receipt.heldInput;
    this.inputFreshFor = receipt.inputFreshFor;
  }

  // Recenter at the origin and clear all movement (velocity, spin, throttle, cruise lock) while
  // keeping orientation and ship loadout. Also drops any held flight input so the next tick does
  // not immediately re-accelerate.
  reset(): void {
    this.assignShip({
      ...this.toUnroundedShip(),
      position: { x: 0, y: 0, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
      angularVelocity: { x: 0, y: 0, z: 0 },
      throttle: 0,
      cruiseLock: false,
    });
    this.heldInput = null;
    this.inputFreshFor = 0;
  }

  override update(dt: number): void {
    let heldInput: HeldFlightInput | null = null;
    if (this.heldInput === null || this.inputFreshFor <= 0) {
      this.heldInput = null;
      this.inputFreshFor = 0;
    } else {
      this.inputFreshFor = Math.max(0, this.inputFreshFor - dt);
      heldInput = this.heldInput;
    }
    this.assignShip(integrateShipTick(this.toUnroundedShip(), dt, heldInput));
  }

  toShip(): Ship {
    return roundShip(this.toUnroundedShip());
  }

  private toUnroundedShip(): Ship {
    return {
      pilotId: this.id,
      name: this.name,
      position: cloneVector(this.position),
      velocity: cloneVector(this.velocity),
      orientation: cloneQuaternion(this.orientation),
      angularVelocity: cloneVector(this.angularVelocity),
      throttle: this.throttle,
      cruiseLock: this.cruiseLock,
      navLightsOn: this.navLightsOn,
      flashlightOn: this.flashlightOn,
      heat: this.heat,
      cargoMass: this.cargoMass,
      cargoCapacity: this.cargoCapacity,
      scanPower: this.scanPower,
      miningPower: this.miningPower,
      stabilizerEfficiency: this.stabilizerEfficiency,
    };
  }

  private assignShip(ship: Ship): void {
    this.position = cloneVector(ship.position);
    this.velocity = cloneVector(ship.velocity);
    this.orientation = normalizeQuaternion(ship.orientation);
    this.angularVelocity = cloneVector(ship.angularVelocity);
    this.throttle = clamp(ship.throttle, -1, 1);
    this.cruiseLock = ship.cruiseLock;
    this.navLightsOn = ship.navLightsOn;
    this.flashlightOn = ship.flashlightOn;
    this.heat = ship.heat;
    this.cargoMass = ship.cargoMass;
    this.cargoCapacity = ship.cargoCapacity;
    this.scanPower = ship.scanPower;
    this.miningPower = ship.miningPower;
    this.stabilizerEfficiency = ship.stabilizerEfficiency;
  }
}

export class ServerWorld {
  readonly fixedDt = shipFixedDt;
  frame = 0;
  currentTick = 0;
  simTime = 0;

  private readonly actors: Actor[] = [];
  private readonly shipActors = new Map<string, ShipActor>();
  private readonly pendingInputs: PendingInput[] = [];
  private readonly lastCapture = new Map<string, ReplicatedSnapshot>();
  private accumulator = 0;
  private lastWallMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(readonly db: HaystackDb) {
    this.lastWallMs = this.readLastTickMs();
  }

  start(hz = 60): void {
    if (this.timer !== null) {
      return;
    }
    this.timer = setInterval(() => this.advanceToNow(), Math.max(1, 1000 / hz));
  }

  stop(): void {
    if (this.timer === null) {
      return;
    }
    clearInterval(this.timer);
    this.timer = null;
  }

  advanceToNow(nowMs = Date.now()): void {
    // Counts every advanceToNow invocation. During one publishAll this fires at least twice
    // (the explicit call + the one nested inside buildSharedWorld) — that is the confirmed
    // double-advance the metrics make visible.
    metrics.noteAdvance();
    metrics.time("sim.syncShips", () => this.syncShipsFromDatabase());
    const elapsed = Math.min(30, Math.max(0, (nowMs - this.lastWallMs) / 1000));
    this.lastWallMs = nowMs;
    if (elapsed <= 0) {
      return;
    }

    this.accumulator += elapsed;
    let steps = 0;
    metrics.time("sim.step", () => {
      while (this.accumulator >= this.fixedDt) {
        this.tick();
        this.accumulator -= this.fixedDt;
        steps += 1;
      }
    });
    metrics.gauge("sim.stepsPerAdvance", steps);

    metrics.time("sim.persistShips", () => this.persistShips());
    metrics.time("sim.persistMeta", () => this.persistLastTick(nowMs));
  }

  applyThrust(pilotId: string, command: ThrustCommand): Ship {
    return this.applyCommand(pilotId, command);
  }

  resetShip(pilotId: string, nowMs = Date.now()): Ship {
    this.advanceToNow(nowMs);
    const ship = this.shipActors.get(pilotId);
    if (ship === undefined) {
      throw new Error("Ship not found.");
    }
    ship.reset();
    this.persistShips();
    this.persistLastTick(nowMs);
    return ship.toShip();
  }

  applyCommand(
    pilotId: string,
    command: ThrustCommand | FlightInputCommand,
    nowMs = Date.now(),
  ): Ship {
    this.advanceToNow(nowMs);
    this.pendingInputs.push({ pilotId, command });
    this.tick();
    // The forced tick above applies this input immediately (so the ack/REST
    // response reflects it). Charge that step against the wall-clock accumulator
    // so the background sim loop does not integrate the same fixed step again —
    // otherwise per-frame input doubles the effective tick rate (~120Hz vs the
    // client's predicted 60Hz), driving constant reconciliation snaps. Bounded
    // so a burst of inputs only briefly defers the background loop afterwards.
    this.accumulator = Math.max(this.accumulator - this.fixedDt, -this.fixedDt * 3);
    this.persistShips();
    this.persistLastTick(nowMs);
    const ship = this.shipActors.get(pilotId);
    if (ship === undefined) {
      throw new Error("Ship not found.");
    }
    return ship.toShip();
  }

  inspect(): EngineDiagnostic {
    this.advanceToNow();
    const actors = this.actors.map((actor) => {
      const descriptors = descriptorsFor(actor);
      return {
        id: actor.id,
        className: actor.constructor.name,
        role: actor.role,
        tickGroup: actor.tickGroup,
        replicatedFields: descriptors.map((descriptor) => descriptor.name),
      };
    });
    return {
      fixedDt: this.fixedDt,
      frame: this.frame,
      currentTick: this.currentTick,
      simTime: round(this.simTime),
      actorCount: this.actors.length,
      authoritativeCount: this.actors.filter((actor) => actor.role === ActorRole.Authoritative)
        .length,
      lastCaptureCount: this.lastCapture.size,
      actors,
      lastCapture: Object.fromEntries(this.lastCapture),
    };
  }

  private tick(): void {
    this.applyPendingInputs();
    const dt = this.fixedDt;
    this.simTime += dt;

    for (const group of tickGroupOrder) {
      for (const actor of this.actors) {
        if (actor.tickGroup === group) {
          actor.update(dt);
        }
      }
    }

    this.collectReplication();
    this.frame += 1;
    this.currentTick += 1;
  }

  private applyPendingInputs(): void {
    for (const input of this.pendingInputs.splice(0)) {
      const ship = this.shipActors.get(input.pilotId);
      if (ship === undefined) {
        throw new Error("Ship not found.");
      }
      if (isFlightInputCommand(input.command)) {
        ship.applyFlightInput(input.command);
      } else {
        ship.applyThrust(input.command);
      }
    }
  }

  private collectReplication(): void {
    this.lastCapture.clear();
    for (const actor of this.actors) {
      if (actor.role !== ActorRole.Authoritative) {
        continue;
      }
      const descriptors = descriptorsFor(actor);
      if (descriptors.length === 0) {
        continue;
      }
      const snapshot: ReplicatedSnapshot = {};
      for (const descriptor of descriptors) {
        snapshot[descriptor.name] = descriptor.get(actor);
      }
      this.lastCapture.set(actor.id, snapshot);
    }
  }

  private syncShipsFromDatabase(): void {
    const rows = this.db.query("SELECT * FROM ships ORDER BY pilot_id ASC").all() as ShipRow[];
    const liveIds = new Set<string>();
    for (const row of rows) {
      liveIds.add(row.pilot_id);
      const existing = this.shipActors.get(row.pilot_id);
      if (existing === undefined) {
        const actor = new ShipActor(row);
        this.shipActors.set(row.pilot_id, actor);
        this.actors.push(actor);
      } else {
        existing.syncFromRow(row);
      }
    }

    for (const [pilotId, actor] of this.shipActors) {
      if (liveIds.has(pilotId)) {
        continue;
      }
      this.shipActors.delete(pilotId);
      const actorIndex = this.actors.indexOf(actor);
      if (actorIndex >= 0) {
        this.actors.splice(actorIndex, 1);
      }
    }
  }

  private persistShips(): void {
    const update = this.db.query(
      `UPDATE ships
          SET x = ?, y = ?, z = ?, vx = ?, vy = ?, vz = ?, qx = ?, qy = ?, qz = ?, qw = ?,
              wx = ?, wy = ?, wz = ?, throttle = ?, cruise_lock = ?, nav_lights = ?,
              flashlight = ?, heat = ?
        WHERE pilot_id = ?`,
    );
    for (const ship of this.shipActors.values()) {
      const orientation = normalizeQuaternion(ship.orientation);
      update.run(
        ship.position.x,
        ship.position.y,
        ship.position.z,
        ship.velocity.x,
        ship.velocity.y,
        ship.velocity.z,
        orientation.x,
        orientation.y,
        orientation.z,
        orientation.w,
        ship.angularVelocity.x,
        ship.angularVelocity.y,
        ship.angularVelocity.z,
        ship.throttle,
        ship.cruiseLock ? 1 : 0,
        ship.navLightsOn ? 1 : 0,
        ship.flashlightOn ? 1 : 0,
        ship.heat,
        ship.id,
      );
    }
  }

  private readLastTickMs(): number {
    const meta = this.db.query("SELECT value FROM meta WHERE key = ?").get("last_tick_ms") as {
      value: string;
    } | null;
    return meta === null ? Date.now() : Number(meta.value);
  }

  private persistLastTick(nowMs: number): void {
    this.db
      .query(
        `INSERT INTO meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run("last_tick_ms", String(nowMs));
  }
}

const worlds = new WeakMap<HaystackDb, ServerWorld>();

export function getServerWorld(db: HaystackDb): ServerWorld {
  const existing = worlds.get(db);
  if (existing !== undefined) {
    return existing;
  }
  const world = new ServerWorld(db);
  worlds.set(db, world);
  return world;
}

function descriptorsFor(actor: Actor): readonly ReplicatedField[] {
  return (actor.constructor as typeof Actor).replicatedProperties;
}

function cloneVector(vector: Vector3): Vector3 {
  return {
    x: vector.x,
    y: vector.y,
    z: vector.z,
  };
}

function cloneQuaternion(quaternion: Quaternion): Quaternion {
  return {
    x: quaternion.x,
    y: quaternion.y,
    z: quaternion.z,
    w: quaternion.w,
  };
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
