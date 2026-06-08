// In-process benchmark for the 30Hz world-stream broadcast path.
//
// Drives WorldStream.publishAll() against N simulated peers and reports the
// per-tick server cost — the quantity that must stay under the 33ms / 30Hz budget
// for the server to sustain the broadcast. It isolates server CPU (no real sockets)
// so a profile points at the actual hot path, not network noise.
//
// Usage:
//   bun scripts/bench/world-stream.ts                                  # default matrix
//   BENCH_SINGLE=1 BENCH_PLAYERS=16 HAYSTACK_RENDERED_LIMIT=100000 \
//     bun scripts/bench/world-stream.ts                                # one config
//
// Env knobs: BENCH_PLAYER_GRID (csv), BENCH_LIMIT_GRID (csv), BENCH_WARMUP,
// BENCH_TICKS, BENCH_SPREAD, BENCH_SINGLE, BENCH_PLAYERS, HAYSTACK_RENDERED_LIMIT.

import type { WSContext } from "hono/ws";

import { openDatabase } from "../../src/server/db";
import { WorldStream } from "../../src/server/realtime";
import { createPilot, getSnapshot } from "../../src/server/sim";
import { getServerWorld } from "../../src/server/world";

type Peer = { pilotId: string; ws: WSContext; bytes: number };

function makePeer(pilotId: string): Peer {
  const peer: Peer = {
    pilotId,
    bytes: 0,
    ws: {
      readyState: 1,
      send(data: string | ArrayBufferLike) {
        peer.bytes += typeof data === "string" ? data.length : (data as ArrayBuffer).byteLength;
      },
      close() {},
    } as unknown as WSContext,
  };
  return peer;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] ?? 0;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

const BROADCAST_HZ = 30;
const CELL_SIZE_M = 1130; // mirrors src/server/field.ts

type CellResult = {
  players: number;
  renderedLimit: number;
  speedMps: number;
  cellCrossingsPerSec: number;
  effectiveVisibleAsteroids: number;
  coldTickMs: number;
  publishAllMs: { p50: number; p95: number; max: number };
  bytesPerTickPerPeer: number;
  bytesPerSecPerPeer: number;
  peakRssMb: number;
};

function runCell(
  players: number,
  limit: number,
  warmup: number,
  ticks: number,
  spread: number,
  speedMps: number,
): CellResult {
  process.env["HAYSTACK_RENDERED_LIMIT"] = String(limit);
  const db = openDatabase(":memory:");
  const world = getServerWorld(db);
  const stream = new WorldStream(world);

  const peers: Peer[] = [];
  for (let i = 0; i < players; i += 1) {
    const pilot = createPilot(db, { callsign: `Bench-${i}` });
    // Spread players across the field so each sits in a distinct region/cell.
    const angle = (i / Math.max(1, players)) * Math.PI * 2;
    const ring = spread * (1 + (i % 5) * 0.35);
    db.query("UPDATE ships SET x = ?, y = ?, z = ? WHERE pilot_id = ?").run(
      Math.cos(angle) * ring,
      (i % 7) * 800,
      Math.sin(angle) * ring,
      pilot.id,
    );
    const peer = makePeer(pilot.id);
    stream.open(peer.ws, pilot.id);
    peers.push(peer);
  }

  // Cold tick: first publishAll after positions are set — exercises cache misses.
  const cold0 = performance.now();
  stream.publishAll();
  const coldTickMs = performance.now() - cold0;

  for (let i = 0; i < warmup; i += 1) {
    stream.publishAll();
  }

  // Realistic flight: advance each ship at `speedMps` every tick so position is in
  // every delta and the player re-pages the field as it crosses cells. A stationary
  // player gets empty deltas, which badly understates load. speedMps=0 = stationary.
  const metersPerTick = speedMps / BROADCAST_HZ;
  const nudge = db.query("UPDATE ships SET x = x + ? WHERE pilot_id = ?");

  const bytesBefore = peers.map((peer) => peer.bytes);
  const samples: number[] = [];
  for (let i = 0; i < ticks; i += 1) {
    if (metersPerTick !== 0) {
      for (const peer of peers) {
        nudge.run(metersPerTick, peer.pilotId);
      }
    }
    const t0 = performance.now();
    stream.publishAll();
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);

  const totalBytes = peers.reduce(
    (acc, peer, idx) => acc + (peer.bytes - (bytesBefore[idx] ?? 0)),
    0,
  );
  const bytesPerTickPerPeer = totalBytes / Math.max(1, players) / Math.max(1, ticks);
  const effective = getSnapshot(
    db,
    peers[0]?.pilotId ?? null,
    peers.map((peer) => peer.pilotId),
  ).asteroids.length;
  const peakRssMb = process.memoryUsage().rss / 1024 / 1024;

  world.stop();
  db.close();

  return {
    players,
    renderedLimit: limit,
    speedMps,
    cellCrossingsPerSec: round((speedMps / CELL_SIZE_M) * 1),
    effectiveVisibleAsteroids: effective,
    coldTickMs: round(coldTickMs),
    publishAllMs: {
      p50: round(percentile(samples, 50)),
      p95: round(percentile(samples, 95)),
      max: round(samples[samples.length - 1] ?? 0),
    },
    bytesPerTickPerPeer: Math.round(bytesPerTickPerPeer),
    bytesPerSecPerPeer: Math.round(bytesPerTickPerPeer * 30),
    peakRssMb: Math.round(peakRssMb),
  };
}

function main(): void {
  const warmup = Number(process.env["BENCH_WARMUP"] ?? "3");
  const ticks = Number(process.env["BENCH_TICKS"] ?? "20");
  const spread = Number(process.env["BENCH_SPREAD"] ?? "40000");
  // Default flight speed 5 km/s (the design target). BENCH_MOVE=0 forces stationary.
  const speedMps =
    process.env["BENCH_MOVE"] === "0" ? 0 : Number(process.env["BENCH_SPEED_MPS"] ?? "5000");

  let grid: Array<{ players: number; limit: number }>;
  if (process.env["BENCH_SINGLE"] === "1") {
    grid = [
      {
        players: Number(process.env["BENCH_PLAYERS"] ?? "1"),
        limit: Number(process.env["HAYSTACK_RENDERED_LIMIT"] ?? "2000"),
      },
    ];
  } else {
    const players = (process.env["BENCH_PLAYER_GRID"] ?? "1,4,16").split(",").map(Number);
    const limits = (process.env["BENCH_LIMIT_GRID"] ?? "2000,100000").split(",").map(Number);
    grid = [];
    for (const limit of limits) {
      for (const player of players) {
        grid.push({ players: player, limit });
      }
    }
  }

  const results: CellResult[] = [];
  for (const cell of grid) {
    const result = runCell(cell.players, cell.limit, warmup, ticks, spread, speedMps);
    results.push(result);
    process.stderr.write(
      `[bench] players=${result.players} limit=${result.renderedLimit} speed=${result.speedMps}m/s -> ` +
        `p50=${result.publishAllMs.p50}ms p95=${result.publishAllMs.p95}ms cold=${result.coldTickMs}ms ` +
        `MB/peer/s=${round(result.bytesPerSecPerPeer / 1e6)} visible=${result.effectiveVisibleAsteroids} ` +
        `rss=${result.peakRssMb}MB\n`,
    );
  }
  process.stdout.write(
    `${JSON.stringify({ warmup, ticks, spread, speedMps, results }, null, 2)}\n`,
  );
}

main();
