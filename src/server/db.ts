import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type { Mineral, Vector3 } from "../shared/types";

export type HaystackDb = Database;

type PocketSeed = {
  id: string;
  center: Vector3;
  spread: number;
  signatureBias: number;
};

const pockets: PocketSeed[] = [
  {
    id: "inner-drift",
    center: { x: -22000, y: 1200, z: 8000 },
    spread: 5200,
    signatureBias: 0.58,
  },
  {
    id: "black-thread",
    center: { x: 76000, y: -3200, z: -41000 },
    spread: 18200,
    signatureBias: 0.22,
  },
  {
    id: "long-echo",
    center: { x: 182000, y: 16000, z: 94000 },
    spread: 41000,
    signatureBias: 0.34,
  },
];

const minerals: Mineral[] = ["nickel", "waterIce", "cobalt", "silicates", "platinum", "xenotime"];

export function openDatabase(
  path = process.env["HAYSTACK_DB"] ?? "data/haystack.sqlite",
): HaystackDb {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }

  const db = new Database(path, { create: true });
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  seedWorld(db);
  return db;
}

function migrate(db: HaystackDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pilots (
      id TEXT PRIMARY KEY,
      callsign TEXT NOT NULL UNIQUE,
      organization TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ships (
      pilot_id TEXT PRIMARY KEY REFERENCES pilots(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      x REAL NOT NULL,
      y REAL NOT NULL,
      z REAL NOT NULL,
      vx REAL NOT NULL,
      vy REAL NOT NULL,
      vz REAL NOT NULL,
      qx REAL NOT NULL DEFAULT 0,
      qy REAL NOT NULL DEFAULT 0,
      qz REAL NOT NULL DEFAULT 0,
      qw REAL NOT NULL DEFAULT 1,
      wx REAL NOT NULL DEFAULT 0,
      wy REAL NOT NULL DEFAULT 0,
      wz REAL NOT NULL DEFAULT 0,
      throttle REAL NOT NULL DEFAULT 0,
      cruise_lock INTEGER NOT NULL DEFAULT 0,
      heat REAL NOT NULL,
      cargo_mass REAL NOT NULL,
      cargo_capacity REAL NOT NULL,
      scan_power REAL NOT NULL,
      mining_power REAL NOT NULL,
      stabilizer_efficiency REAL NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cargo (
      pilot_id TEXT NOT NULL REFERENCES pilots(id) ON DELETE CASCADE,
      mineral TEXT NOT NULL,
      mass REAL NOT NULL,
      PRIMARY KEY (pilot_id, mineral)
    );

    CREATE TABLE IF NOT EXISTS wallets (
      pilot_id TEXT PRIMARY KEY REFERENCES pilots(id) ON DELETE CASCADE,
      credits REAL NOT NULL
    );

    CREATE TABLE IF NOT EXISTS asteroids (
      id TEXT PRIMARY KEY,
      pocket TEXT NOT NULL,
      x REAL NOT NULL,
      y REAL NOT NULL,
      z REAL NOT NULL,
      radius REAL NOT NULL,
      signature REAL NOT NULL,
      mineral_richness REAL NOT NULL,
      rare_mineral TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS deposits (
      id TEXT PRIMARY KEY,
      asteroid_id TEXT NOT NULL REFERENCES asteroids(id) ON DELETE CASCADE,
      mineral TEXT NOT NULL,
      abundance REAL NOT NULL,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      remaining REAL NOT NULL
    );

    CREATE TABLE IF NOT EXISTS structures (
      id TEXT PRIMARY KEY,
      owner_pilot_id TEXT REFERENCES pilots(id) ON DELETE SET NULL,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      x REAL NOT NULL,
      y REAL NOT NULL,
      z REAL NOT NULL,
      signature REAL NOT NULL,
      hidden INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chat (
      id TEXT PRIMARY KEY,
      channel TEXT NOT NULL,
      from_pilot_id TEXT NOT NULL REFERENCES pilots(id) ON DELETE CASCADE,
      to_pilot_id TEXT REFERENCES pilots(id) ON DELETE CASCADE,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  ensureColumn(db, "ships", "qx", "ALTER TABLE ships ADD COLUMN qx REAL NOT NULL DEFAULT 0");
  ensureColumn(db, "ships", "qy", "ALTER TABLE ships ADD COLUMN qy REAL NOT NULL DEFAULT 0");
  ensureColumn(db, "ships", "qz", "ALTER TABLE ships ADD COLUMN qz REAL NOT NULL DEFAULT 0");
  ensureColumn(db, "ships", "qw", "ALTER TABLE ships ADD COLUMN qw REAL NOT NULL DEFAULT 1");
  ensureColumn(db, "ships", "wx", "ALTER TABLE ships ADD COLUMN wx REAL NOT NULL DEFAULT 0");
  ensureColumn(db, "ships", "wy", "ALTER TABLE ships ADD COLUMN wy REAL NOT NULL DEFAULT 0");
  ensureColumn(db, "ships", "wz", "ALTER TABLE ships ADD COLUMN wz REAL NOT NULL DEFAULT 0");
  ensureColumn(
    db,
    "ships",
    "throttle",
    "ALTER TABLE ships ADD COLUMN throttle REAL NOT NULL DEFAULT 0",
  );
  ensureColumn(
    db,
    "ships",
    "cruise_lock",
    "ALTER TABLE ships ADD COLUMN cruise_lock INTEGER NOT NULL DEFAULT 0",
  );
}

function ensureColumn(db: HaystackDb, table: string, column: string, ddl: string): void {
  const columns = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((candidate) => candidate.name === column)) {
    db.exec(ddl);
  }
}

function seedWorld(db: HaystackDb): void {
  const asteroidCount = db.query("SELECT COUNT(*) AS count FROM asteroids").get() as {
    count: number;
  };
  if (asteroidCount.count > 0) {
    ensureMeta(db);
    return;
  }

  const insertAsteroid = db.query(
    `INSERT INTO asteroids
      (id, pocket, x, y, z, radius, signature, mineral_richness, rare_mineral)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertDeposit = db.query(
    `INSERT INTO deposits
      (id, asteroid_id, mineral, abundance, latitude, longitude, remaining)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  let globalIndex = 0;
  for (const pocket of pockets) {
    for (let localIndex = 0; localIndex < 10; localIndex += 1) {
      const seed = 1000 + globalIndex * 91;
      const position = jitter(pocket.center, pocket.spread, seed);
      const radius = 70 + noise(seed + 5) * 360;
      const mineralRichness = 0.25 + noise(seed + 11) * 0.75;
      const rareMineral = minerals[(globalIndex + 2) % minerals.length] ?? "nickel";
      const asteroidId = `${pocket.id}-a${String(localIndex + 1).padStart(2, "0")}`;
      const signature = clamp01(pocket.signatureBias + noise(seed + 29) * 0.42 - 0.12);

      insertAsteroid.run(
        asteroidId,
        pocket.id,
        position.x,
        position.y,
        position.z,
        radius,
        signature,
        mineralRichness,
        rareMineral,
      );

      const baseMineral = minerals[(globalIndex + 1) % minerals.length] ?? "silicates";
      insertDeposit.run(
        `${asteroidId}-d1`,
        asteroidId,
        baseMineral,
        0.38 + noise(seed + 37) * 0.45,
        -70 + noise(seed + 41) * 140,
        -170 + noise(seed + 43) * 340,
        90 + mineralRichness * 420,
      );

      if (localIndex % 3 === 1 || rareMineral === "xenotime") {
        insertDeposit.run(
          `${asteroidId}-needle`,
          asteroidId,
          rareMineral,
          0.14 + noise(seed + 53) * 0.2,
          -82 + noise(seed + 59) * 164,
          -180 + noise(seed + 61) * 360,
          18 + mineralRichness * 80,
        );
      }

      globalIndex += 1;
    }
  }

  db.query(
    `INSERT INTO structures
      (id, owner_pilot_id, kind, name, x, y, z, signature, hidden)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("station-kestrel", null, "station", "Kestrel Transfer", -6400, 0, 0, 1.0, 0);
  db.query(
    `INSERT INTO structures
      (id, owner_pilot_id, kind, name, x, y, z, signature, hidden)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("relay-narrowband-7", null, "relay", "Narrowband Relay 7", 82000, -1900, -37000, 0.62, 0);
  db.query(
    `INSERT INTO structures
      (id, owner_pilot_id, kind, name, x, y, z, signature, hidden)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("hab-cold-cache", null, "forwardHab", "Cold Cache HAB", 186000, 14800, 100200, 0.08, 1);

  ensureMeta(db);
}

function ensureMeta(db: HaystackDb): void {
  const lastTick = db.query("SELECT value FROM meta WHERE key = ?").get("last_tick_ms") as {
    value: string;
  } | null;
  if (lastTick === null) {
    db.query("INSERT INTO meta (key, value) VALUES (?, ?)").run("last_tick_ms", String(Date.now()));
  }
}

function jitter(center: Vector3, spread: number, seed: number): Vector3 {
  return {
    x: center.x + (noise(seed) - 0.5) * spread,
    y: center.y + (noise(seed + 1) - 0.5) * spread * 0.18,
    z: center.z + (noise(seed + 2) - 0.5) * spread,
  };
}

function noise(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
