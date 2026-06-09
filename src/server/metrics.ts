// In-process, low-overhead server performance instrumentation.
//
// Goal: measure the REAL 30Hz broadcast path on the live server (real WebSocket sends,
// GC pauses, two-timer contention, synchronous SQLite fsync) — the failure modes the
// in-process bench (scripts/bench/world-stream.ts) cannot exercise. See
// docs/superpowers/specs/2026-06-08-server-observability-design.md.
//
// Everything here is GATED behind HAYSTACK_METRICS=1. When disabled, mark/count/gauge are
// immediate no-ops and time(name, fn) is a bare `fn()` call with zero timing overhead, so
// production behavior and the existing benchmark are unaffected.
//
// When enabled, samples accumulate in memory and a 1s rollup is flushed to a SEPARATE
// SQLite file (data/haystack-metrics.sqlite, WAL + synchronous=NORMAL) so metric writes
// never add fsync stalls to the gameplay DB and the whole file is disposable after a day.

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const ENABLED = process.env["HAYSTACK_METRICS"] === "1";

// 30Hz broadcast budget. A publish tick slower than this cannot sustain 30Hz on its own.
export const TICK_BUDGET_MS = 1000 / 30;

const ROLLUP_INTERVAL_MS = 1000;
const LOOP_LAG_INTERVAL_MS = 200;
// Keep ~120s of per-tick phase breakdowns in memory for the live flame/icicle. Never persisted.
const TICK_RING_CAPACITY = 120 * 30;
// Cap per-metric per-window samples so a burst (e.g. REST storm) cannot grow memory unbounded;
// count/sum/min/max stay exact, only percentile resolution degrades past the cap.
const MAX_WINDOW_SAMPLES = 8192;
// Retain ~36h of rollups, then prune. The file is also safe to delete wholesale.
const RETENTION_SECONDS = 36 * 60 * 60;

type ValueAccumulator = {
  count: number;
  sum: number;
  min: number;
  max: number;
  samples: number[];
};

type GaugeState = {
  last: number;
  min: number;
  max: number;
  sum: number;
  count: number;
};

export type RollupRow = {
  ts_bucket: number;
  metric: string;
  count: number;
  sum: number;
  min: number;
  max: number;
  p50: number;
  p95: number;
  p99: number;
};

export type TickSample = {
  t: number; // epoch ms at tick end
  peers: number;
  advances: number; // advanceToNow() calls during this publish tick (>=2 proves double-advance)
  total: number; // publishAll.total ms
  overrun: boolean;
  phases: Record<string, number>; // phase name -> ms accumulated this tick
};

function newValueAccumulator(): ValueAccumulator {
  return { count: 0, sum: 0, min: Infinity, max: -Infinity, samples: [] };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] ?? 0;
}

class Metrics {
  readonly enabled = ENABLED;

  private readonly timings = new Map<string, ValueAccumulator>();
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, GaugeState>();

  // Per-publish-tick scratch: when non-null, every mark() also folds into this map so we can
  // emit one TickSample per broadcast tick for the live icicle.
  private currentTick: Record<string, number> | null = null;
  private currentTickAdvances = 0;
  private readonly tickRing: TickSample[] = [];

  private lastPublishStartMs = 0;
  private started = false;
  private db: Database | null = null;
  private rollupTimer: ReturnType<typeof setInterval> | null = null;
  private lagTimer: ReturnType<typeof setInterval> | null = null;
  private flushCount = 0;

  // ---- recording API (hot path) ----

  mark(name: string, ms: number): void {
    if (!this.enabled) {
      return;
    }
    this.record(name, ms);
    if (this.currentTick !== null) {
      this.currentTick[name] = (this.currentTick[name] ?? 0) + ms;
    }
  }

  time<T>(name: string, fn: () => T): T {
    if (!this.enabled) {
      return fn();
    }
    const start = performance.now();
    try {
      return fn();
    } finally {
      this.mark(name, performance.now() - start);
    }
  }

  count(name: string, n = 1): void {
    if (!this.enabled) {
      return;
    }
    this.counters.set(name, (this.counters.get(name) ?? 0) + n);
  }

  gauge(name: string, value: number): void {
    if (!this.enabled) {
      return;
    }
    const existing = this.gauges.get(name);
    if (existing === undefined) {
      this.gauges.set(name, { last: value, min: value, max: value, sum: value, count: 1 });
      return;
    }
    existing.last = value;
    existing.min = Math.min(existing.min, value);
    existing.max = Math.max(existing.max, value);
    existing.sum += value;
    existing.count += 1;
  }

  // ---- per-publish-tick bracketing (called from WorldStream.publishAll) ----

  beginPublishTick(peers: number): void {
    if (!this.enabled) {
      return;
    }
    const now = performance.now();
    if (this.lastPublishStartMs > 0) {
      this.mark("tick.interval", now - this.lastPublishStartMs);
    }
    this.lastPublishStartMs = now;
    this.gauge("tick.peers", peers);
    this.currentTick = {};
    this.currentTickAdvances = 0;
  }

  noteAdvance(): void {
    if (!this.enabled) {
      return;
    }
    this.count("sim.advanceCalls");
    this.currentTickAdvances += 1;
  }

  endPublishTick(peers: number, totalMs: number): void {
    if (!this.enabled || this.currentTick === null) {
      return;
    }
    const overrun = totalMs > TICK_BUDGET_MS;
    this.mark("publishAll.total", totalMs);
    this.gauge("sim.advancesPerTick", this.currentTickAdvances);
    if (overrun) {
      this.count("tick.overruns");
    }
    this.tickRing.push({
      t: Date.now(),
      peers,
      advances: this.currentTickAdvances,
      total: totalMs,
      overrun,
      phases: this.currentTick,
    });
    if (this.tickRing.length > TICK_RING_CAPACITY) {
      this.tickRing.splice(0, this.tickRing.length - TICK_RING_CAPACITY);
    }
    this.currentTick = null;
  }

  private record(name: string, ms: number): void {
    let acc = this.timings.get(name);
    if (acc === undefined) {
      acc = newValueAccumulator();
      this.timings.set(name, acc);
    }
    acc.count += 1;
    acc.sum += ms;
    if (ms < acc.min) {
      acc.min = ms;
    }
    if (ms > acc.max) {
      acc.max = ms;
    }
    if (acc.samples.length < MAX_WINDOW_SAMPLES) {
      acc.samples.push(ms);
    }
  }

  // ---- lifecycle (server only) ----

  start(): void {
    if (!this.enabled || this.started) {
      return;
    }
    this.started = true;
    const path = this.openDb();
    this.startLoopLagSampler();
    this.startGcObserver();
    this.rollupTimer = setInterval(() => this.flush(), ROLLUP_INTERVAL_MS);
    this.rollupTimer.unref?.();
    // eslint-disable-next-line no-console
    console.log(`[metrics] enabled -> ${path} (HAYSTACK_METRICS=1, /debug/metrics)`);
  }

  private openDb(): string {
    const path = process.env["HAYSTACK_METRICS_DB"] ?? "data/haystack-metrics.sqlite";
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    const db = new Database(path, { create: true });
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS metrics (
        ts_bucket INTEGER NOT NULL,
        metric    TEXT    NOT NULL,
        count     INTEGER NOT NULL,
        sum       REAL    NOT NULL,
        min       REAL    NOT NULL,
        max       REAL    NOT NULL,
        p50       REAL    NOT NULL,
        p95       REAL    NOT NULL,
        p99       REAL    NOT NULL,
        PRIMARY KEY (ts_bucket, metric)
      );
      CREATE TABLE IF NOT EXISTS runs (
        started_at TEXT NOT NULL,
        note       TEXT NOT NULL
      );
    `);
    db.query("INSERT INTO runs (started_at, note) VALUES (?, ?)").run(
      new Date().toISOString(),
      `players_env=${process.env["LOAD_PLAYERS"] ?? ""}`,
    );
    this.db = db;
    return path;
  }

  private startLoopLagSampler(): void {
    let last = performance.now();
    this.lagTimer = setInterval(() => {
      const now = performance.now();
      const drift = now - last - LOOP_LAG_INTERVAL_MS;
      this.mark("loop.lag", Math.max(0, drift));
      last = now;
    }, LOOP_LAG_INTERVAL_MS);
    this.lagTimer.unref?.();
  }

  private startGcObserver(): void {
    try {
      // node:perf_hooks is available under Bun; degrade gracefully if not.
      void import("node:perf_hooks")
        .then(({ PerformanceObserver }) => {
          const observer = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
              this.mark("gc.pauseMs", entry.duration);
              this.count("gc.count");
            }
          });
          observer.observe({ entryTypes: ["gc"] });
        })
        .catch(() => {});
    } catch {
      // GC metrics are best-effort.
    }
  }

  private flush(): void {
    const db = this.db;
    if (db === null) {
      return;
    }
    const tsBucket = Math.floor(Date.now() / 1000);
    const rows: RollupRow[] = [];

    for (const [metric, acc] of this.timings) {
      if (acc.count === 0) {
        continue;
      }
      const sorted = acc.samples.slice().sort((a, b) => a - b);
      rows.push({
        ts_bucket: tsBucket,
        metric,
        count: acc.count,
        sum: acc.sum,
        min: acc.min === Infinity ? 0 : acc.min,
        max: acc.max === -Infinity ? 0 : acc.max,
        p50: percentile(sorted, 50),
        p95: percentile(sorted, 95),
        p99: percentile(sorted, 99),
      });
    }
    for (const [metric, total] of this.counters) {
      rows.push({
        ts_bucket: tsBucket,
        metric: `counter.${metric}`,
        count: total,
        sum: total,
        min: total,
        max: total,
        p50: total,
        p95: total,
        p99: total,
      });
    }
    for (const [metric, g] of this.gauges) {
      rows.push({
        ts_bucket: tsBucket,
        metric: `gauge.${metric}`,
        count: g.count,
        sum: g.sum,
        min: g.min,
        max: g.max,
        p50: g.count > 0 ? g.sum / g.count : 0,
        p95: g.max,
        p99: g.max,
      });
    }

    this.timings.clear();
    this.counters.clear();
    this.gauges.clear();

    if (rows.length === 0) {
      return;
    }

    const insert = db.query(
      `INSERT OR REPLACE INTO metrics
         (ts_bucket, metric, count, sum, min, max, p50, p95, p99)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const writeAll = db.transaction((batch: RollupRow[]) => {
      for (const r of batch) {
        insert.run(r.ts_bucket, r.metric, r.count, r.sum, r.min, r.max, r.p50, r.p95, r.p99);
      }
    });
    writeAll(rows);

    this.flushCount += 1;
    if (this.flushCount % 60 === 0) {
      db.query("DELETE FROM metrics WHERE ts_bucket < ?").run(tsBucket - RETENTION_SECONDS);
    }
  }

  // ---- read API (dashboard endpoints) ----

  readRollups(sinceSec: number, untilSec: number): RollupRow[] {
    const db = this.readDb();
    if (db === null) {
      return [];
    }
    return db
      .query(
        `SELECT ts_bucket, metric, count, sum, min, max, p50, p95, p99
           FROM metrics
          WHERE ts_bucket >= ? AND ts_bucket <= ?
          ORDER BY ts_bucket ASC`,
      )
      .all(sinceSec, untilSec) as RollupRow[];
  }

  liveTicks(): TickSample[] {
    return this.tickRing.slice();
  }

  private readDb(): Database | null {
    if (this.db !== null) {
      return this.db;
    }
    // The dashboard may be hit in a process where start() ran; if not, open read-only.
    if (!this.enabled) {
      return null;
    }
    try {
      const path = process.env["HAYSTACK_METRICS_DB"] ?? "data/haystack-metrics.sqlite";
      this.db = new Database(path, { create: true, readwrite: true });
      return this.db;
    } catch {
      return null;
    }
  }
}

export const metrics = new Metrics();

export function startMetrics(): void {
  metrics.start();
}
