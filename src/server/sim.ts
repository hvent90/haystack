import { randomUUID } from "node:crypto";

import type {
  Asteroid,
  BuildBaseRequest,
  BuildBaseResult,
  CargoItem,
  CharacterCard,
  ChatMessage,
  ChatRequest,
  CreatePilotRequest,
  Deposit,
  FieldSummary,
  MineRequest,
  MineResult,
  Mineral,
  OrganizationSummary,
  Pilot,
  Quaternion,
  ScanHit,
  ScanReport,
  ScanRequest,
  SellRequest,
  SellResult,
  Ship,
  Structure,
  ThrustCommand,
  UpgradeRequest,
  UpgradeResult,
  Vector3,
  WorldSnapshot,
} from "../shared/types";
import type { HaystackDb } from "./db";
import { fieldDiagnostic, fieldSummary, virtualScanHits } from "./field";
import { stationSpawn } from "./world";
import { getServerWorld } from "./world";

// Symbol-keyed (so JSON.stringify ignores it -> wire format unchanged) cheap
// fingerprint of the `asteroids` array, attached to every snapshot. The world stream
// reads it to detect field changes in O(1) instead of JSON.stringify-ing the whole
// (up to 100k) field every tick. See listAsteroids for how it is composed.
export const ASTEROIDS_FINGERPRINT: unique symbol = Symbol("haystack.asteroidsFingerprint");

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

type PilotRow = {
  id: string;
  callsign: string;
  organization: string;
  created_at: string;
};

type AsteroidRow = {
  id: string;
  pocket: string;
  x: number;
  y: number;
  z: number;
  radius: number;
  signature: number;
  mineral_richness: number;
  rare_mineral: Mineral;
};

type DepositRow = {
  id: string;
  asteroid_id: string;
  mineral: Mineral;
  abundance: number;
  latitude: number;
  longitude: number;
  remaining: number;
};

type StructureRow = {
  id: string;
  owner_pilot_id: string | null;
  kind: "forwardHab" | "relay" | "station";
  name: string;
  x: number;
  y: number;
  z: number;
  signature: number;
  hidden: number;
};

type CargoRow = {
  mineral: Mineral;
  mass: number;
};

type ChatRow = {
  id: string;
  channel: string;
  from_pilot_id: string;
  to_pilot_id: string | null;
  from_callsign: string;
  body: string;
  created_at: string;
};

const mineralPrices: Record<Mineral, number> = {
  cobalt: 92,
  nickel: 48,
  platinum: 210,
  silicates: 28,
  waterIce: 36,
  xenotime: 340,
};
const forwardHabCost = 500;
const upgradeBaseCosts: Record<UpgradeRequest["system"], number> = {
  cargo: 300,
  scanner: 420,
  mining: 360,
  stabilizer: 280,
};

export function createPilot(db: HaystackDb, request: CreatePilotRequest): Pilot {
  const callsign = request.callsign.trim().slice(0, 36);
  if (callsign.length < 2) {
    throw new Error("Callsign must be at least two characters.");
  }

  const existing = db
    .query("SELECT * FROM pilots WHERE callsign = ?")
    .get(callsign) as PilotRow | null;
  if (existing !== null) {
    ensureShip(db, existing.id, callsign);
    ensureWallet(db, existing.id);
    return mapPilot(existing);
  }

  const id = `pilot-${randomUUID()}`;
  const createdAt = new Date().toISOString();
  const organization = request.organization?.trim().slice(0, 40) || "Independent Prospectors";
  db.query("INSERT INTO pilots (id, callsign, organization, created_at) VALUES (?, ?, ?, ?)").run(
    id,
    callsign,
    organization,
    createdAt,
  );
  ensureShip(db, id, callsign);
  ensureWallet(db, id);

  return {
    id,
    callsign,
    organization,
    createdAt,
  };
}

export function getPilot(db: HaystackDb, pilotId: string): Pilot | null {
  const row = db.query("SELECT * FROM pilots WHERE id = ?").get(pilotId) as PilotRow | null;
  return row === null ? null : mapPilot(row);
}

// World state that is identical for every connected peer on a given tick: the player
// roster, every ship, the static seeded rows (asteroids/deposits/structures), the field
// summary and the active-pilot list. The world stream builds this ONCE per tick (see
// buildSharedWorld) and feeds it to getPilotView for each peer, so the shared world — and
// its change-detection hashing in realtime.ts — costs O(1) in player count instead of
// being rebuilt and re-hashed per peer (the old O(players^2) broadcast). The per-peer cost
// then collapses to just the per-pilot overlay (discovered flags, cargo, chat). See P2.
export type SharedWorld = {
  serverTime: string;
  field: FieldSummary;
  pilots: CharacterCard[];
  pilotsById: Map<string, CharacterCard>;
  organizations: OrganizationSummary[];
  ships: Ship[];
  shipsByPilot: Map<string, Ship>;
  asteroidRows: AsteroidRow[];
  depositRows: DepositRow[];
  structureRows: StructureRow[];
  activePilotIds: string[];
};

export function buildSharedWorld(
  db: HaystackDb,
  activePilotIds: readonly string[] = [],
): SharedWorld {
  advanceWorld(db);

  const pilots = listCharacterCards(db);
  const pilotsById = new Map(pilots.map((pilot) => [pilot.id, pilot] as const));
  const organizations = listOrganizations(pilots);
  const ships = listShips(db);
  const shipsByPilot = new Map(ships.map((ship) => [ship.pilotId, ship] as const));
  const asteroidRows = db.query("SELECT * FROM asteroids").all() as AsteroidRow[];
  const depositRows = db.query("SELECT * FROM deposits").all() as DepositRow[];
  const structureRows = db.query("SELECT * FROM structures").all() as StructureRow[];

  return {
    serverTime: new Date().toISOString(),
    field: fieldSummary(),
    pilots,
    pilotsById,
    organizations,
    ships,
    shipsByPilot,
    asteroidRows,
    depositRows,
    structureRows,
    activePilotIds: [...new Set(activePilotIds.filter((id) => pilotsById.has(id)))].sort(),
  };
}

// Derives one peer's snapshot from the shared world. Only the per-pilot overlay is computed
// here: `me`, the distance-based `discovered` flags, cargo, and chat. The shared arrays
// (pilots/ships/field/...) are shared by reference, so a peer's delta serializes them but the
// world stream hashes them once per tick (not once per peer).
export function getPilotView(
  db: HaystackDb,
  shared: SharedWorld,
  pilotId: string | null,
): WorldSnapshot {
  const me = pilotId === null ? null : (shared.pilotsById.get(pilotId) ?? null);
  const ship = pilotId === null ? null : shipFor(shared, pilotId);
  const { asteroids, fingerprint } = asteroidsForPilot(shared.asteroidRows, ship);
  const deposits = depositsForPilot(shared.depositRows, shared.asteroidRows, ship);
  const structures = structuresForPilot(shared.structureRows, ship, pilotId);
  const cargo = pilotId === null ? [] : listCargo(db, pilotId);
  const chat = listSnapshotChat(db, pilotId);

  const snapshot: WorldSnapshot = {
    serverTime: shared.serverTime,
    field: shared.field,
    me,
    pilots: shared.pilots,
    activePilotIds: shared.activePilotIds,
    organizations: shared.organizations,
    ships: shared.ships,
    asteroids,
    deposits,
    structures,
    cargo,
    chat,
  };
  // Stored under a symbol key so JSON.stringify(snapshot) (the on-wire payload) ignores
  // it; the world stream reads it for O(1) field change-detection.
  (snapshot as { [ASTEROIDS_FINGERPRINT]?: string })[ASTEROIDS_FINGERPRINT] = fingerprint;
  return snapshot;
}

export function getSnapshot(
  db: HaystackDb,
  pilotId: string | null,
  activePilotIds: readonly string[] = [],
): WorldSnapshot {
  return getPilotView(db, buildSharedWorld(db, activePilotIds), pilotId);
}

export function applyThrust(db: HaystackDb, pilotId: string, command: ThrustCommand): Ship {
  return getServerWorld(db).applyThrust(pilotId, command);
}

export function resetShip(db: HaystackDb, pilotId: string): Ship {
  return getServerWorld(db).resetShip(pilotId);
}

export function runScan(db: HaystackDb, pilotId: string, request: ScanRequest): ScanReport {
  advanceWorld(db);
  const ship = requireShip(db, pilotId);
  const mode = request.mode;
  const heatAdded = mode === "belt" ? 7 : mode === "pocket" ? 4 : 2;
  db.query("UPDATE ships SET heat = ? WHERE pilot_id = ?").run(
    Math.min(100, ship.heat + heatAdded),
    pilotId,
  );

  const hits =
    mode === "belt"
      ? scanBelt(db, ship)
      : mode === "pocket"
        ? scanPocket(db, ship)
        : scanSurface(db, ship, request.targetAsteroidId, request.mineral);

  return {
    mode,
    pulseId: `pulse-${randomUUID()}`,
    origin: ship.position,
    heatAdded,
    hits: hits
      .sort((left, right) => right.strength - left.strength)
      .slice(0, 12)
      .map((hit) => ({
        ...hit,
        strength: round(hit.strength),
        distance: round(hit.distance),
      })),
  };
}

export function mineDeposit(db: HaystackDb, pilotId: string, request: MineRequest): MineResult {
  advanceWorld(db);
  const ship = requireShip(db, pilotId);
  const asteroidRow = db
    .query("SELECT * FROM asteroids WHERE id = ?")
    .get(request.asteroidId) as AsteroidRow | null;
  if (asteroidRow === null) {
    throw new Error("Asteroid not found.");
  }

  const depositRow = db
    .query("SELECT * FROM deposits WHERE id = ? AND asteroid_id = ?")
    .get(request.depositId, request.asteroidId) as DepositRow | null;
  if (depositRow === null) {
    throw new Error("Deposit not found.");
  }

  const asteroid = mapAsteroid(asteroidRow, true);
  const distanceToRock = distance(ship.position, asteroid.position);
  if (distanceToRock > asteroid.radius + 1400) {
    throw new Error("Ship is too far from the asteroid to mine.");
  }

  const freeCargo = Math.max(0, ship.cargoCapacity - ship.cargoMass);
  const minedMass = Math.min(
    freeCargo,
    depositRow.remaining,
    ship.miningPower * depositRow.abundance,
  );
  if (minedMass <= 0.05) {
    throw new Error("No usable cargo space or deposit mass remains.");
  }

  db.query("UPDATE deposits SET remaining = ? WHERE id = ?").run(
    depositRow.remaining - minedMass,
    depositRow.id,
  );
  db.query(
    `INSERT INTO cargo (pilot_id, mineral, mass) VALUES (?, ?, ?)
     ON CONFLICT(pilot_id, mineral) DO UPDATE SET mass = mass + excluded.mass`,
  ).run(pilotId, depositRow.mineral, minedMass);
  db.query(
    "UPDATE ships SET cargo_mass = cargo_mass + ?, heat = MIN(100, heat + ?) WHERE pilot_id = ?",
  ).run(minedMass, 5 + minedMass * 0.04, pilotId);

  const updatedDeposit = db
    .query("SELECT * FROM deposits WHERE id = ?")
    .get(depositRow.id) as DepositRow;

  return {
    deposit: mapDeposit(updatedDeposit, true),
    cargo: listCargo(db, pilotId),
    minedMass: round(minedMass),
  };
}

export function sellCargo(db: HaystackDb, pilotId: string, request: SellRequest): SellResult {
  advanceWorld(db);
  const ship = requireShip(db, pilotId);
  if (!isNearStation(db, ship.position)) {
    throw new Error("Ship must be near a station to sell or deposit cargo.");
  }

  ensureWallet(db, pilotId);
  const cargoRows = db
    .query("SELECT mineral, mass FROM cargo WHERE pilot_id = ? ORDER BY mineral ASC")
    .all(pilotId) as CargoRow[];
  const selectedRows = cargoRows.filter(
    (row) => request.mineral === undefined || row.mineral === request.mineral,
  );
  let remainingToSell = Math.max(0, request.mass ?? Number.POSITIVE_INFINITY);
  let soldMass = 0;
  let creditsEarned = 0;

  for (const row of selectedRows) {
    if (remainingToSell <= 0) {
      break;
    }
    const mass = Math.min(row.mass, remainingToSell);
    if (mass <= 0) {
      continue;
    }
    const nextMass = row.mass - mass;
    if (nextMass <= 0.001) {
      db.query("DELETE FROM cargo WHERE pilot_id = ? AND mineral = ?").run(pilotId, row.mineral);
    } else {
      db.query("UPDATE cargo SET mass = ? WHERE pilot_id = ? AND mineral = ?").run(
        nextMass,
        pilotId,
        row.mineral,
      );
    }
    soldMass += mass;
    creditsEarned += mass * mineralPrices[row.mineral];
    remainingToSell -= mass;
  }

  if (soldMass <= 0) {
    throw new Error("No matching cargo is available to sell.");
  }

  db.query("UPDATE ships SET cargo_mass = MAX(0, cargo_mass - ?) WHERE pilot_id = ?").run(
    soldMass,
    pilotId,
  );
  db.query("UPDATE wallets SET credits = credits + ? WHERE pilot_id = ?").run(
    creditsEarned,
    pilotId,
  );
  const wallet = db.query("SELECT credits FROM wallets WHERE pilot_id = ?").get(pilotId) as {
    credits: number;
  } | null;

  return {
    cargo: listCargo(db, pilotId),
    soldMass: round(soldMass),
    creditsEarned: round(creditsEarned),
    credits: round(wallet?.credits ?? creditsEarned),
  };
}

export function buildForwardHab(
  db: HaystackDb,
  pilotId: string,
  request: BuildBaseRequest,
): BuildBaseResult {
  advanceWorld(db);
  const pilot = getPilot(db, pilotId);
  if (pilot === null) {
    throw new Error("Pilot not found.");
  }

  const ship = requireShip(db, pilotId);
  if (isNearStation(db, ship.position)) {
    throw new Error("Forward HABs must be deployed away from station traffic.");
  }

  ensureWallet(db, pilotId);
  const wallet = db.query("SELECT credits FROM wallets WHERE pilot_id = ?").get(pilotId) as {
    credits: number;
  } | null;
  const credits = wallet?.credits ?? 0;
  if (credits < forwardHabCost) {
    throw new Error(`A forward HAB kit costs ${forwardHabCost} credits.`);
  }

  const hidden = request.hidden ?? true;
  const name = (request.name?.trim().slice(0, 42) || `${pilot.callsign} Cache HAB`).trim();
  const id = `hab-${randomUUID()}`;
  const signature = hidden ? 0.045 : 0.24;
  db.query(
    `INSERT INTO structures
      (id, owner_pilot_id, kind, name, x, y, z, signature, hidden)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    pilotId,
    "forwardHab",
    name,
    ship.position.x,
    ship.position.y,
    ship.position.z,
    signature,
    hidden ? 1 : 0,
  );
  db.query("UPDATE wallets SET credits = credits - ? WHERE pilot_id = ?").run(
    forwardHabCost,
    pilotId,
  );

  const row = db.query("SELECT * FROM structures WHERE id = ?").get(id) as StructureRow | null;
  if (row === null) {
    throw new Error("Forward HAB deployment failed.");
  }

  return {
    structure: mapStructure(row, true),
    credits: round(credits - forwardHabCost),
  };
}

export function inspectField(db: HaystackDb, pilotId: string, radius: number, limit: number) {
  advanceWorld(db);
  const ship = requireShip(db, pilotId);
  return fieldDiagnostic(ship.position, radius, limit);
}

export function upgradeShip(
  db: HaystackDb,
  pilotId: string,
  request: UpgradeRequest,
): UpgradeResult {
  advanceWorld(db);
  const ship = requireShip(db, pilotId);
  ensureWallet(db, pilotId);
  const wallet = db.query("SELECT credits FROM wallets WHERE pilot_id = ?").get(pilotId) as {
    credits: number;
  } | null;
  const credits = wallet?.credits ?? 0;
  const cost = upgradeCost(ship, request.system);
  if (credits < cost) {
    throw new Error(`${request.system} upgrade costs ${cost} credits.`);
  }

  switch (request.system) {
    case "cargo":
      db.query("UPDATE ships SET cargo_capacity = cargo_capacity + ? WHERE pilot_id = ?").run(
        60,
        pilotId,
      );
      break;
    case "scanner":
      db.query("UPDATE ships SET scan_power = scan_power + ? WHERE pilot_id = ?").run(
        0.28,
        pilotId,
      );
      break;
    case "mining":
      db.query("UPDATE ships SET mining_power = mining_power + ? WHERE pilot_id = ?").run(
        6,
        pilotId,
      );
      break;
    case "stabilizer":
      db.query(
        "UPDATE ships SET stabilizer_efficiency = MIN(0.82, stabilizer_efficiency + ?) WHERE pilot_id = ?",
      ).run(0.08, pilotId);
      break;
  }

  db.query("UPDATE wallets SET credits = credits - ? WHERE pilot_id = ?").run(cost, pilotId);

  return {
    ship: requireShip(db, pilotId),
    system: request.system,
    cost,
    credits: round(credits - cost),
  };
}

export function postChat(db: HaystackDb, request: ChatRequest): ChatMessage {
  const pilot = getPilot(db, request.fromPilotId);
  if (pilot === null) {
    throw new Error("Pilot not found.");
  }

  const channel = request.channel.trim().slice(0, 32) || "global";
  const body = request.body.trim().slice(0, 500);
  if (body.length === 0) {
    throw new Error("Chat message cannot be empty.");
  }

  const id = `chat-${randomUUID()}`;
  const createdAt = new Date().toISOString();
  db.query(
    "INSERT INTO chat (id, channel, from_pilot_id, to_pilot_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(id, channel, request.fromPilotId, request.toPilotId ?? null, body, createdAt);

  return {
    id,
    channel,
    fromPilotId: request.fromPilotId,
    toPilotId: request.toPilotId ?? null,
    fromCallsign: pilot.callsign,
    body,
    createdAt,
  };
}

export function listChat(
  db: HaystackDb,
  pilotId: string | null,
  channel: string,
  limit: number,
): ChatMessage[] {
  const boundedLimit = Math.max(1, Math.min(100, limit));
  const rows = db
    .query(
      `SELECT chat.id,
            chat.channel,
            chat.from_pilot_id,
            chat.to_pilot_id,
            pilots.callsign AS from_callsign,
            chat.body,
            chat.created_at
       FROM chat
       JOIN pilots ON pilots.id = chat.from_pilot_id
      WHERE chat.channel = ?
        AND (chat.to_pilot_id IS NULL OR chat.to_pilot_id = ? OR chat.from_pilot_id = ?)
      ORDER BY chat.created_at DESC
      LIMIT ?`,
    )
    .all(channel, pilotId, pilotId, boundedLimit) as ChatRow[];

  return rows.reverse().map((row) => ({
    id: row.id,
    channel: row.channel,
    fromPilotId: row.from_pilot_id,
    toPilotId: row.to_pilot_id,
    fromCallsign: row.from_callsign,
    body: row.body,
    createdAt: row.created_at,
  }));
}

function advanceWorld(db: HaystackDb): void {
  getServerWorld(db).advanceToNow();
}

function scanBelt(db: HaystackDb, ship: Ship): ScanHit[] {
  const asteroids = db
    .query(
      `SELECT pocket,
            AVG(x) AS x,
            AVG(y) AS y,
            AVG(z) AS z,
            AVG(signature) AS signature,
            COUNT(*) AS count
       FROM asteroids
      GROUP BY pocket`,
    )
    .all() as Array<{
    pocket: string;
    x: number;
    y: number;
    z: number;
    signature: number;
    count: number;
  }>;

  const structureRows = db.query("SELECT * FROM structures").all() as StructureRow[];
  const pocketHits = asteroids.map((row) => {
    const position = { x: row.x, y: row.y, z: row.z };
    const range = distance(ship.position, position);
    const strength = signalStrength(row.signature, range, ship.scanPower * 34);
    return {
      id: row.pocket,
      kind: "pocket" as const,
      label: row.pocket,
      distance: range,
      strength,
      bearing: unit(subtract(position, ship.position)),
      clue: `${row.count} coarse returns across a ${describeScale(range)} pocket`,
    };
  });

  const structureHits = structureRows
    .map((row) => mapStructure(row, true))
    .filter((structure) => !structure.hidden || structure.signature > 0.3)
    .map((structure) => {
      const range = distance(ship.position, structure.position);
      return {
        id: structure.id,
        kind: "structure" as const,
        label: structure.name,
        distance: range,
        strength: signalStrength(structure.signature, range, ship.scanPower * 28),
        bearing: unit(subtract(structure.position, ship.position)),
        clue: `${structure.kind} signal at belt scale`,
      };
    });

  return [...pocketHits, ...structureHits].filter((hit) => hit.strength > 0.04);
}

function scanPocket(db: HaystackDb, ship: Ship): ScanHit[] {
  const asteroidRows = db.query("SELECT * FROM asteroids").all() as AsteroidRow[];
  const structureRows = db.query("SELECT * FROM structures").all() as StructureRow[];
  const shipRows = db
    .query("SELECT * FROM ships WHERE pilot_id != ?")
    .all(ship.pilotId) as ShipRow[];

  const asteroidHits = asteroidRows.map((row) => {
    const asteroid = mapAsteroid(row, true);
    const range = distance(ship.position, asteroid.position);
    const strength = signalStrength(
      asteroid.signature + asteroid.radius / 800,
      range,
      ship.scanPower * 18,
    );
    return {
      id: asteroid.id,
      kind: "asteroid" as const,
      label: asteroid.id,
      distance: range,
      strength,
      bearing: unit(subtract(asteroid.position, ship.position)),
      clue: `${asteroid.rareMineral} trace, radius ${Math.round(asteroid.radius)}m`,
    };
  });

  const structureHits = structureRows.map((row) => {
    const structure = mapStructure(row, true);
    const range = distance(ship.position, structure.position);
    return {
      id: structure.id,
      kind: "structure" as const,
      label: structure.hidden ? "masked installation" : structure.name,
      distance: range,
      strength: signalStrength(structure.signature, range, ship.scanPower * 16),
      bearing: unit(subtract(structure.position, ship.position)),
      clue: structure.hidden ? "narrow intermittent heat bloom" : `${structure.kind} transponder`,
    };
  });

  const shipHits = shipRows.map((row) => {
    const otherShip = mapShip(row);
    const range = distance(ship.position, otherShip.position);
    return {
      id: otherShip.pilotId,
      kind: "ship" as const,
      label: otherShip.name,
      distance: range,
      strength: signalStrength(0.74 + otherShip.heat / 200, range, ship.scanPower * 12),
      bearing: unit(subtract(otherShip.position, ship.position)),
      clue: `drive plume moving ${Math.round(length(otherShip.velocity))} m/s`,
    };
  });

  const virtualHits = virtualScanHits(ship.position, ship.scanPower, 52000, 10);

  return [...asteroidHits, ...virtualHits, ...structureHits, ...shipHits].filter(
    (hit) => hit.strength > 0.025,
  );
}

function scanSurface(
  db: HaystackDb,
  ship: Ship,
  targetAsteroidId: string | undefined,
  mineral: Mineral | undefined,
): ScanHit[] {
  const asteroidRow =
    targetAsteroidId === undefined
      ? nearestAsteroidRow(db, ship.position)
      : (db
          .query("SELECT * FROM asteroids WHERE id = ?")
          .get(targetAsteroidId) as AsteroidRow | null);
  if (asteroidRow === undefined || asteroidRow === null) {
    return [];
  }

  const asteroid = mapAsteroid(asteroidRow, true);
  const asteroidDistance = distance(ship.position, asteroid.position);
  const deposits = db
    .query("SELECT * FROM deposits WHERE asteroid_id = ?")
    .all(asteroid.id) as DepositRow[];

  return deposits
    .filter((deposit) => mineral === undefined || deposit.mineral === mineral)
    .map((deposit) => {
      const signature = deposit.abundance * (deposit.mineral === "xenotime" ? 0.65 : 0.9);
      const strength = signalStrength(
        signature,
        Math.max(1, asteroidDistance - asteroid.radius),
        ship.scanPower * 3.8,
      );
      return {
        id: deposit.id,
        kind: "deposit" as const,
        label: `${deposit.mineral} deposit`,
        distance: asteroidDistance,
        strength,
        bearing: surfaceBearing(deposit.latitude, deposit.longitude),
        clue: `${Math.round(deposit.remaining)}t remaining at ${formatLatLong(deposit.latitude, deposit.longitude)}`,
      };
    })
    .filter((hit) => hit.strength > 0.015);
}

// Deterministic per-pilot spawn offset: a ring around the station spawn so freshly
// created ships never materialize inside each other (ships are solid now — see
// src/shared/collision.ts). Small enough (≤ ~400 m) that every station-range mechanic
// (mining reach, scan discovery, docking distances) is unaffected.
function spawnOffsetFor(pilotId: string): Vector3 {
  let hash = 2166136261;
  for (let i = 0; i < pilotId.length; i += 1) {
    hash = Math.imul(hash ^ pilotId.charCodeAt(i), 16777619);
  }
  const unsigned = hash >>> 0;
  const angle = ((unsigned % 4096) / 4096) * Math.PI * 2;
  const ring = 180 + ((unsigned >>> 12) % 200);
  const lift = (((unsigned >>> 20) % 81) - 40) * 1;
  return {
    x: Math.cos(angle) * ring,
    y: lift,
    z: Math.sin(angle) * ring,
  };
}

function ensureShip(db: HaystackDb, pilotId: string, callsign: string): void {
  const existing = db.query("SELECT pilot_id FROM ships WHERE pilot_id = ?").get(pilotId) as {
    pilot_id: string;
  } | null;
  if (existing !== null) {
    return;
  }

  // Re-probe with a salted hash until the spot is clear of already-spawned ships (the
  // ring hash alone can collide); runs once per pilot, result persists in the row.
  const occupied = db.query("SELECT x, y, z FROM ships").all() as Array<{
    x: number;
    y: number;
    z: number;
  }>;
  let offset = spawnOffsetFor(pilotId);
  for (let attempt = 1; attempt <= 64; attempt += 1) {
    const clear = occupied.every(
      (ship) =>
        Math.hypot(
          stationSpawn.x + offset.x - ship.x,
          stationSpawn.y + offset.y - ship.y,
          stationSpawn.z + offset.z - ship.z,
        ) >= 140,
    );
    if (clear) {
      break;
    }
    offset = spawnOffsetFor(`${pilotId}:${attempt}`);
  }
  db.query(
    `INSERT INTO ships
      (pilot_id, name, x, y, z, vx, vy, vz, qx, qy, qz, qw, wx, wy, wz, throttle, cruise_lock, heat, cargo_mass, cargo_capacity, scan_power, mining_power, stabilizer_efficiency)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    pilotId,
    `${callsign} Brickrunner`,
    stationSpawn.x + offset.x,
    stationSpawn.y + offset.y,
    stationSpawn.z + offset.z,
    0,
    0,
    0,
    0,
    0,
    0,
    1,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    180,
    1,
    22,
    0.42,
  );
}

function ensureWallet(db: HaystackDb, pilotId: string): void {
  const existing = db.query("SELECT pilot_id FROM wallets WHERE pilot_id = ?").get(pilotId) as {
    pilot_id: string;
  } | null;
  if (existing !== null) {
    return;
  }
  db.query("INSERT INTO wallets (pilot_id, credits) VALUES (?, ?)").run(pilotId, 1000);
}

function requireShip(db: HaystackDb, pilotId: string): Ship {
  const row = db.query("SELECT * FROM ships WHERE pilot_id = ?").get(pilotId) as ShipRow | null;
  if (row === null) {
    throw new Error("Ship not found.");
  }
  return mapShip(row);
}

function listCharacterCards(db: HaystackDb): CharacterCard[] {
  const rows = db
    .query(
      `SELECT pilots.id,
            pilots.callsign,
            pilots.organization,
            pilots.created_at,
            ships.name AS ship_name,
            ships.cargo_mass,
            ships.cargo_capacity,
            COALESCE(wallets.credits, 0) AS credits,
            ships.scan_power,
            ships.mining_power
       FROM pilots
       JOIN ships ON ships.pilot_id = pilots.id
       LEFT JOIN wallets ON wallets.pilot_id = pilots.id
      ORDER BY pilots.created_at ASC`,
    )
    .all() as Array<
    PilotRow & {
      ship_name: string;
      cargo_mass: number;
      cargo_capacity: number;
      credits: number;
      scan_power: number;
      mining_power: number;
    }
  >;

  return rows.map((row) => ({
    id: row.id,
    callsign: row.callsign,
    organization: row.organization,
    createdAt: row.created_at,
    shipName: row.ship_name,
    cargoMass: round(row.cargo_mass),
    cargoCapacity: row.cargo_capacity,
    credits: round(row.credits),
    scanPower: row.scan_power,
    miningPower: row.mining_power,
  }));
}

function listOrganizations(pilots: CharacterCard[]): OrganizationSummary[] {
  const byName = new Map<string, OrganizationSummary>();
  for (const pilot of pilots) {
    const existing = byName.get(pilot.organization) ?? {
      name: pilot.organization,
      memberCount: 0,
      activeShipCount: 0,
      totalCargoMass: 0,
      totalCredits: 0,
    };
    existing.memberCount += 1;
    existing.activeShipCount += 1;
    existing.totalCargoMass = round(existing.totalCargoMass + pilot.cargoMass);
    existing.totalCredits = round(existing.totalCredits + pilot.credits);
    byName.set(pilot.organization, existing);
  }
  return [...byName.values()].sort((left, right) => {
    if (right.memberCount !== left.memberCount) {
      return right.memberCount - left.memberCount;
    }
    return left.name.localeCompare(right.name);
  });
}

function listShips(db: HaystackDb): Ship[] {
  const rows = db.query("SELECT * FROM ships").all() as ShipRow[];
  return rows.map(mapShip);
}

function shipFor(shared: SharedWorld, pilotId: string): Ship {
  const ship = shared.shipsByPilot.get(pilotId);
  if (ship === undefined) {
    throw new Error("Ship not found.");
  }
  return ship;
}

// Builds the player's seeded (DB) asteroid view plus a change-detection `fingerprint` from
// pre-fetched rows (shared across peers) + this peer's ship. The deterministic virtual field
// (up to 100k static rocks) is NOT included: the client regenerates it locally from `field`
// (seed/cellSize/renderedLimit) + the ship position (see src/client/eve/field-derivation.ts).
// Streaming only the small mutable seeded set means a 5 km/s cell crossing costs no
// server-side field scan and no multi-MB field re-send. A null ship == anonymous viewer.
function asteroidsForPilot(
  rows: AsteroidRow[],
  ship: Ship | null,
): { asteroids: Asteroid[]; fingerprint: string } {
  if (ship === null) {
    const asteroids = rows.map((row) => mapAsteroid(row, false));
    return { asteroids, fingerprint: `none|${JSON.stringify(asteroids)}` };
  }
  const seededAsteroids = rows.map((row) => {
    const asteroid = mapAsteroid(row, true);
    return {
      ...asteroid,
      discovered: distance(ship.position, asteroid.position) < 55000 || asteroid.signature > 0.64,
    };
  });
  return { asteroids: seededAsteroids, fingerprint: JSON.stringify(seededAsteroids) };
}

function depositsForPilot(
  depositRows: DepositRow[],
  asteroidRows: AsteroidRow[],
  ship: Ship | null,
): Deposit[] {
  if (ship === null) {
    return depositRows.map((row) => mapDeposit(row, false));
  }
  const nearest = nearestAsteroidRowFrom(asteroidRows, ship.position);
  return depositRows.map((row) => ({
    ...mapDeposit(row, nearest?.id === row.asteroid_id),
  }));
}

function structuresForPilot(
  rows: StructureRow[],
  ship: Ship | null,
  pilotId: string | null,
): Structure[] {
  if (ship === null) {
    return rows.map((row) => mapStructure(row, !row.hidden));
  }
  return rows.map((row) => {
    const structure = mapStructure(row, true);
    return {
      ...structure,
      discovered:
        structure.ownerPilotId === pilotId ||
        !structure.hidden ||
        distance(ship.position, structure.position) < ship.scanPower * 8500,
    };
  });
}

function listCargo(db: HaystackDb, pilotId: string): CargoItem[] {
  const rows = db
    .query("SELECT mineral, mass FROM cargo WHERE pilot_id = ? ORDER BY mineral ASC")
    .all(pilotId) as CargoRow[];
  return rows.map((row) => ({
    mineral: row.mineral,
    mass: round(row.mass),
  }));
}

function listSnapshotChat(db: HaystackDb, pilotId: string | null): ChatMessage[] {
  const messages = [
    ...listChat(db, pilotId, "global", 24),
    ...listChat(db, pilotId, "belt", 24),
    ...listChat(db, pilotId, "dm", 24),
  ];
  return messages.sort((left, right) => left.createdAt.localeCompare(right.createdAt)).slice(-48);
}

function nearestAsteroidRow(db: HaystackDb, position: Vector3): AsteroidRow | undefined {
  const rows = db.query("SELECT * FROM asteroids").all() as AsteroidRow[];
  return nearestAsteroidRowFrom(rows, position);
}

// Same nearest-row selection as nearestAsteroidRow but over a pre-fetched, shared row array.
// Slices before sorting so the shared array (reused by every peer this tick) is never mutated.
function nearestAsteroidRowFrom(rows: AsteroidRow[], position: Vector3): AsteroidRow | undefined {
  return rows.slice().sort((left, right) => {
    const leftDistance = distance(position, { x: left.x, y: left.y, z: left.z });
    const rightDistance = distance(position, { x: right.x, y: right.y, z: right.z });
    return leftDistance - rightDistance;
  })[0];
}

function isNearStation(db: HaystackDb, position: Vector3): boolean {
  const stations = db
    .query("SELECT * FROM structures WHERE kind = ?")
    .all("station") as StructureRow[];
  return stations.some(
    (station) => distance(position, { x: station.x, y: station.y, z: station.z }) < 5200,
  );
}

function upgradeCost(ship: Ship, system: UpgradeRequest["system"]): number {
  switch (system) {
    case "cargo":
      return Math.round(upgradeBaseCosts.cargo + Math.max(0, ship.cargoCapacity - 180) * 2.2);
    case "scanner":
      return Math.round(upgradeBaseCosts.scanner * ship.scanPower);
    case "mining":
      return Math.round(upgradeBaseCosts.mining + Math.max(0, ship.miningPower - 22) * 24);
    case "stabilizer":
      return Math.round(upgradeBaseCosts.stabilizer + ship.stabilizerEfficiency * 600);
  }
}

function mapPilot(row: PilotRow): Pilot {
  return {
    id: row.id,
    callsign: row.callsign,
    organization: row.organization,
    createdAt: row.created_at,
  };
}

function mapShip(row: ShipRow): Ship {
  return {
    pilotId: row.pilot_id,
    name: row.name,
    position: {
      x: round(row.x),
      y: round(row.y),
      z: round(row.z),
    },
    velocity: {
      x: round(row.vx),
      y: round(row.vy),
      z: round(row.vz),
    },
    orientation: roundQuaternion({ x: row.qx, y: row.qy, z: row.qz, w: row.qw }),
    angularVelocity: {
      x: round(row.wx),
      y: round(row.wy),
      z: round(row.wz),
    },
    throttle: round(row.throttle),
    cruiseLock: row.cruise_lock === 1,
    navLightsOn: row.nav_lights === 1,
    flashlightOn: row.flashlight === 1,
    heat: round(row.heat),
    cargoMass: round(row.cargo_mass),
    cargoCapacity: row.cargo_capacity,
    scanPower: row.scan_power,
    miningPower: row.mining_power,
    stabilizerEfficiency: row.stabilizer_efficiency,
  };
}

function mapAsteroid(row: AsteroidRow, discovered: boolean): Asteroid {
  return {
    id: row.id,
    pocket: row.pocket,
    position: {
      x: round(row.x),
      y: round(row.y),
      z: round(row.z),
    },
    radius: round(row.radius),
    signature: round(row.signature),
    mineralRichness: round(row.mineral_richness),
    rareMineral: row.rare_mineral,
    discovered,
  };
}

function mapDeposit(row: DepositRow, discovered: boolean): Deposit {
  return {
    id: row.id,
    asteroidId: row.asteroid_id,
    mineral: row.mineral,
    abundance: round(row.abundance),
    latitude: round(row.latitude),
    longitude: round(row.longitude),
    remaining: round(row.remaining),
    discovered,
  };
}

function mapStructure(row: StructureRow, discovered: boolean): Structure {
  return {
    id: row.id,
    ownerPilotId: row.owner_pilot_id,
    kind: row.kind,
    name: row.name,
    position: {
      x: round(row.x),
      y: round(row.y),
      z: round(row.z),
    },
    signature: round(row.signature),
    hidden: row.hidden === 1,
    discovered,
  };
}

function signalStrength(signature: number, range: number, rangeMultiplier: number): number {
  const falloff = 1 + range / Math.max(1, rangeMultiplier * 1000);
  return Math.min(1, Math.max(0, signature / falloff));
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

function subtract(left: Vector3, right: Vector3): Vector3 {
  return {
    x: left.x - right.x,
    y: left.y - right.y,
    z: left.z - right.z,
  };
}

function unit(vector: Vector3): Vector3 {
  const magnitude = length(vector);
  if (magnitude === 0) {
    return { x: 0, y: 0, z: 0 };
  }
  return {
    x: round(vector.x / magnitude),
    y: round(vector.y / magnitude),
    z: round(vector.z / magnitude),
  };
}

function surfaceBearing(latitude: number, longitude: number): Vector3 {
  const lat = (latitude * Math.PI) / 180;
  const lon = (longitude * Math.PI) / 180;
  return {
    x: round(Math.cos(lat) * Math.cos(lon)),
    y: round(Math.sin(lat)),
    z: round(Math.cos(lat) * Math.sin(lon)),
  };
}

function distance(left: Vector3, right: Vector3): number {
  return length(subtract(left, right));
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

function length(vector: Vector3): number {
  return Math.sqrt(vector.x * vector.x + vector.y * vector.y + vector.z * vector.z);
}

function formatLatLong(latitude: number, longitude: number): string {
  const ns = latitude >= 0 ? "N" : "S";
  const ew = longitude >= 0 ? "E" : "W";
  return `${Math.abs(latitude).toFixed(1)}${ns}, ${Math.abs(longitude).toFixed(1)}${ew}`;
}

function describeScale(distanceMeters: number): string {
  if (distanceMeters > 100000) {
    return `${Math.round(distanceMeters / 1000)}km`;
  }
  if (distanceMeters > 1000) {
    return `${(distanceMeters / 1000).toFixed(1)}km`;
  }
  return `${Math.round(distanceMeters)}m`;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
