import type { Quaternion, Ship, ThrustCommand, Vector3 } from "../shared/types";
import type { HaystackDb } from "./db";

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
  heat: number;
  cargo_mass: number;
  cargo_capacity: number;
  scan_power: number;
  mining_power: number;
  stabilizer_efficiency: number;
};

type PendingInput = {
  pilotId: string;
  command: ThrustCommand;
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
  heat: number;
  cargoMass: number;
  cargoCapacity: number;
  scanPower: number;
  miningPower: number;
  stabilizerEfficiency: number;

  constructor(row: ShipRow) {
    super();
    this.id = row.pilot_id;
    this.name = row.name;
    this.position = { x: row.x, y: row.y, z: row.z };
    this.velocity = { x: row.vx, y: row.vy, z: row.vz };
    this.orientation = normalizeQuaternion({ x: row.qx, y: row.qy, z: row.qz, w: row.qw });
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
    this.heat = row.heat;
    this.cargoMass = row.cargo_mass;
    this.cargoCapacity = row.cargo_capacity;
    this.scanPower = row.scan_power;
    this.miningPower = row.mining_power;
    this.stabilizerEfficiency = row.stabilizer_efficiency;
  }

  applyThrust(command: ThrustCommand): void {
    const impulse = clampVector(command.impulse, 12);
    const worldImpulse =
      command.frame === "local" ? rotateVectorByQuaternion(impulse, this.orientation) : impulse;
    const stabilization = command.stabilize === true && this.heat < 96;
    const dampening = stabilization ? 1 - this.stabilizerEfficiency : 1;
    const heatAdded = length(impulse) * 1.8 + (stabilization ? 18 : 0);
    this.velocity = {
      x: (this.velocity.x + worldImpulse.x) * dampening,
      y: (this.velocity.y + worldImpulse.y) * dampening,
      z: (this.velocity.z + worldImpulse.z) * dampening,
    };
    this.heat = Math.min(100, this.heat + heatAdded);
  }

  override update(dt: number): void {
    this.position = {
      x: this.position.x + this.velocity.x * dt,
      y: this.position.y + this.velocity.y * dt,
      z: this.position.z + this.velocity.z * dt,
    };
    this.heat = Math.max(0, this.heat - dt * 0.85);
  }

  toShip(): Ship {
    return {
      pilotId: this.id,
      name: this.name,
      position: roundVector(this.position),
      velocity: roundVector(this.velocity),
      orientation: roundQuaternion(this.orientation),
      heat: round(this.heat),
      cargoMass: round(this.cargoMass),
      cargoCapacity: this.cargoCapacity,
      scanPower: this.scanPower,
      miningPower: this.miningPower,
      stabilizerEfficiency: this.stabilizerEfficiency,
    };
  }
}

export class ServerWorld {
  readonly fixedDt = 1 / 60;
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
    this.syncShipsFromDatabase();
    const elapsed = Math.min(30, Math.max(0, (nowMs - this.lastWallMs) / 1000));
    this.lastWallMs = nowMs;
    if (elapsed <= 0) {
      return;
    }

    this.accumulator += elapsed;
    while (this.accumulator >= this.fixedDt) {
      this.tick();
      this.accumulator -= this.fixedDt;
    }

    this.persistShips();
    this.persistLastTick(nowMs);
  }

  applyThrust(pilotId: string, command: ThrustCommand): Ship {
    this.advanceToNow();
    this.pendingInputs.push({ pilotId, command });
    this.tick();
    this.persistShips();
    this.persistLastTick(Date.now());
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
      ship.applyThrust(input.command);
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
          SET x = ?, y = ?, z = ?, vx = ?, vy = ?, vz = ?, qx = ?, qy = ?, qz = ?, qw = ?, heat = ?
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

function clampVector(vector: Vector3, maxLength: number): Vector3 {
  const magnitude = length(vector);
  if (magnitude <= maxLength) {
    return vector;
  }
  const scale = maxLength / magnitude;
  return {
    x: vector.x * scale,
    y: vector.y * scale,
    z: vector.z * scale,
  };
}

function length(vector: Vector3): number {
  return Math.sqrt(vector.x * vector.x + vector.y * vector.y + vector.z * vector.z);
}

function roundVector(vector: Vector3): Vector3 {
  return {
    x: round(vector.x),
    y: round(vector.y),
    z: round(vector.z),
  };
}

function roundQuaternion(quaternion: Quaternion): Quaternion {
  const normalized = normalizeQuaternion(quaternion);
  return {
    x: round(normalized.x),
    y: round(normalized.y),
    z: round(normalized.z),
    w: round(normalized.w),
  };
}

function normalizeQuaternion(quaternion: Quaternion): Quaternion {
  const magnitude = Math.sqrt(
    quaternion.x * quaternion.x +
      quaternion.y * quaternion.y +
      quaternion.z * quaternion.z +
      quaternion.w * quaternion.w,
  );
  if (magnitude <= 0) {
    return { x: 0, y: 0, z: 0, w: 1 };
  }
  return {
    x: quaternion.x / magnitude,
    y: quaternion.y / magnitude,
    z: quaternion.z / magnitude,
    w: quaternion.w / magnitude,
  };
}

function rotateVectorByQuaternion(vector: Vector3, quaternion: Quaternion): Vector3 {
  const normalized = normalizeQuaternion(quaternion);
  const ix = normalized.w * vector.x + normalized.y * vector.z - normalized.z * vector.y;
  const iy = normalized.w * vector.y + normalized.z * vector.x - normalized.x * vector.z;
  const iz = normalized.w * vector.z + normalized.x * vector.y - normalized.y * vector.x;
  const iw =
    -normalized.x * vector.x - normalized.y * vector.y - normalized.z * vector.z;

  return {
    x: ix * normalized.w + iw * -normalized.x + iy * -normalized.z - iz * -normalized.y,
    y: iy * normalized.w + iw * -normalized.y + iz * -normalized.x - ix * -normalized.z,
    z: iz * normalized.w + iw * -normalized.z + ix * -normalized.y - iy * -normalized.x,
  };
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
