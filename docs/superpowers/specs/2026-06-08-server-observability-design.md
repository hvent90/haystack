# Server Observability Stack — Design (2026-06-08)

## Problem

The server is expected to broadcast at **30 Hz with ~16 players** while the client renders
~100k asteroids. We believe the server is missing 30 Hz, but the only existing perf evidence is
an **offline** benchmark (`scripts/bench/world-stream.ts`) that drives `publishAll()` in a loop
with **no real network, no WS backpressure, no concurrent 60 Hz timer, no GC realism**. It reports
`publishAll` p95 = 1.6 ms (≈5% of the 33.3 ms budget). That number is not production truth.

We need continuous, low-overhead, **live-path** instrumentation + cheap local storage + a way to
review the data (timeseries + flamegraph), so we can later optimize the server to comfortably hit
30 Hz at 16 players **without reducing client content**.

## Findings (grounded in code)

Per 30 Hz `publishAll()` (`src/server/realtime.ts:151`):

1. `world.advanceToNow()` (`realtime.ts:158`) → `syncShipsFromDatabase` (`SELECT * FROM ships`),
   fixed-step `tick()`s, `persistShips` (one `UPDATE` per ship), `persistLastTick` (meta upsert).
2. `buildSharedWorld()` (`realtime.ts:164` → `sim.ts:203`) internally calls `advanceWorld()` →
   `advanceToNow()` **a second time** (confirmed redundant double-advance), then 5 `SELECT`s
   (pilots/ships/asteroids/deposits/structures).
3. `computeSharedHashes()` — `JSON.stringify` of 5 peer-identical keys, once/tick.
4. for each of N peers: `getPilotView` + `collectChangedKeys` (per-peer hashing) + `createPatch` +
   `JSON.stringify` + **blocking `ws.send`** (`realtime.ts:261`).

Separately, a **60 Hz** `ServerWorld` loop (`main.ts:12`, `world.ts:289`) calls `advanceToNow()`
independently. Net: sim + DB-sync + persist runs ~3×/tick on one JS thread.

The gameplay DB (`bun:sqlite`, `data/haystack.sqlite`, ~96 KB) is **`synchronous=FULL`, no WAL**
(`db.ts:46-47`); every persist fsyncs on the event-loop thread. Only ~30 asteroids are
server-persisted; the 100k field is virtual/client-derived, so it is **not** the server bottleneck.

### Ranked bottleneck hypotheses (to confirm with live metrics, not the bench)

1. The miss lives in what the bench never exercises: real WS sends to 16 sockets, GC pauses,
   two-timer contention, the double-advance, synchronous fsync.
2. Triple `advanceToNow()` per tick → 3× ship `SELECT` + 3× N-row `UPDATE` persist.
3. `synchronous=FULL` + no WAL → fsync stalls, hit 2×/tick by `publishAll` + once by the 60 Hz loop.
4. Sequential blocking `ws.send` to 16 peers; one slow peer stalls the whole broadcast.
5. Per-peer redundant work in `getPilotView` (`listSnapshotChat` = 3 queries+sort; `nearestAsteroidRowFrom` slice+sort).
6. GC-driven periodic overruns invisible to averaged p95 (need p99/max + overrun counter).

## Decisions

- **Stack:** in-process metrics module → **separate** `data/haystack-metrics.sqlite` (WAL,
  `synchronous=NORMAL`) → built-in HTML dashboard, plus on-demand `.cpuprofile`. Zero new infra.
- **Load:** synthetic 16-bot WebSocket load generator (ramp 1→16, realistic flight input).
- **Restart:** clean up stale `:8895/:8896` instances; restart authoritative `:8787` with metrics on.
- **Scope:** **observe-only**; capture a clean baseline. No optimizations applied in this task.

## Architecture

### 1. `src/server/metrics.ts` — in-process profiler (gated by `HAYSTACK_METRICS=1`)

- Cheap, allocation-free **named accumulators**: per phase keep `count`, `sum`, `min`, `max`, and a
  fixed log-bucket histogram (≈0.05 ms … 200 ms) for p50/p95/p99 without storing raw samples.
- Spans recorded via `metrics.now()` deltas (`performance.now()`); helper `time(name, fn)` and
  manual `mark(name, ms)` / `count(name, n)` / `gauge(name, v)`.
- **Phases instrumented** (P0 first):
  - `tick.publishAll` (total), `tick.interval` (actual ms between ticks — the real 30 Hz signal),
    `tick.overruns` (count of >33.3 ms), `tick.peers` (gauge).
  - `sim.advanceToNow` (+ `sim.advanceCalls` counter proving 2×/tick), `sim.syncShips`,
    `sim.step` (+ `sim.stepsPerAdvance`), `sim.persistShips`, `sim.persistMeta`.
  - `net.buildSharedWorld`, `net.computeSharedHashes`, `net.flushPeers`,
    per-peer `net.getPilotView`, `net.hashing`, `net.stringify`, `net.send`, `net.bytes` (gauge).
  - `db.queries` (counter; wrap the db handle to count `query/run` per tick), `db.time`.
  - `gc.pauses` / `gc.maxMs` via `PerformanceObserver('gc')` if available in Bun.
  - `loop.lag` — event-loop lag sampler (scheduled-vs-actual on a 200 ms `setInterval`).
- **Rollup writer:** every **1 s**, snapshot all accumulators into one row per phase
  `(ts_bucket, metric, count, sum, min, max, p50, p95, p99)`, write to the metrics DB in a single
  transaction, then reset window accumulators. Overhead is one batched write/sec on a WAL DB.
- **Retention:** on each flush, `DELETE FROM metrics WHERE ts_bucket < now-36h`. Whole file is
  disposable. Estimated size: ~15 phases × 86400 buckets/day × ~64 B ≈ a few MB/day.
- **In-memory ring** of the last ~120 s of raw per-tick `publishAll` phase breakdowns (for the live
  flame/icicle drill-down); never persisted.

### 2. Storage — `data/haystack-metrics.sqlite`

Own `Database` handle, `PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL`. One wide-ish table:

```sql
CREATE TABLE IF NOT EXISTS metrics (
  ts_bucket INTEGER NOT NULL,  -- epoch seconds
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
```

Added to `.gitignore` (like the game DB) and easy to `rm` after the day.

### 3. Visualization — built into the Hono server (local-only, gated)

- `GET /debug/metrics/data?since=&until=` → JSON timeseries from the metrics DB.
- `GET /debug/metrics/live` → current in-memory window (per-tick ring + latest gauges).
- `GET /debug/metrics` → one self-contained HTML page (inline JS, tiny hand-rolled canvas charts,
  no external CDN needed):
  - **Stacked-area timeseries**: per-phase mean ms over time, with a line for `tick.interval` p99
    and the 33.3 ms budget, plus a `tick.peers` overlay → "where time goes vs player count".
  - **Percentile bars**: p50/p95/p99/max per phase for a selected window.
  - **Flame/icicle**: the phase tree (`publishAll → advanceToNow{syncShips,step,persistShips,…} →
buildSharedWorld → computeSharedHashes → flushPeers{getPilotView,hashing,stringify,send}`)
    for the selected window (mean and p99 tick).
- `GET /debug/profile?seconds=10` → captures a real V8 **`.cpuprofile`** for download
  (open in speedscope / Chrome DevTools). Catches GC + anything unexpected.
- All `/debug/*` routes refuse unless `HAYSTACK_METRICS=1`, and are not exposed through the tunnel
  (tunnel points at Vite :5273, which only proxies `/api`).

### 4. Load generator — `scripts/bench/load.ts`

- Spawns N synthetic WS clients against a target (default `ws://127.0.0.1:8787/api/world/stream`),
  each joins a throwaway pilot (via REST `/api/pilots`), subscribes, and sends realistic flight
  input at ~30–60 Hz. Ramps 1→N over a configurable window, holds, then disconnects.
- Configurable via env/flags: `LOAD_PLAYERS=16`, `LOAD_RAMP_S`, `LOAD_HOLD_S`, `LOAD_TARGET`.
- Prints client-observed delta cadence so we can compare client-side 30 Hz against server metrics.

## Deployment / "on the server"

1. Implement + `bun run typecheck` + `oxfmt`.
2. Confirm no bench regression: `BENCH_PLAYERS=16 HAYSTACK_RENDERED_LIMIT=100000 bun scripts/bench/world-stream.ts`.
3. Reconcile instances: kill stale `:8895`/`:8896` (`bun src/server/main.ts`), keep authoritative `:8787`.
4. Restart `:8787` with `HAYSTACK_METRICS=1` in the tmux `haystack`/`public` server pane.
5. Run `LOAD_PLAYERS=16 bun scripts/bench/load.ts` to drive the 16-player condition.
6. Verify `data/haystack-metrics.sqlite` fills and `http://127.0.0.1:8787/debug/metrics` renders;
   capture a baseline screenshot/export. Leave collecting ~1 day.

## Verification

- `bun run typecheck` and `oxfmt` pass.
- With `HAYSTACK_METRICS` unset: zero new work on the hot path (no metric calls, no extra DB).
- With it set: metrics rows accumulate at ~1/s/phase; dashboard renders; `.cpuprofile` downloads;
  load gen reproduces 16 peers and the server metrics show per-peer send + advance counts.
- DB-space check: metrics file growth ≈ a few MB/day; retention prune verified.

## Non-goals (this task)

- No optimizations applied (double-advance removal, WAL on gameplay DB, send batching, in-memory
  authoritative world) — those come in the **later** data-driven optimization pass.
