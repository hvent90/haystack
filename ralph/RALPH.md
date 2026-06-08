ultrathink

# Ralph Agent — scale the server to 100k visible asteroids, multiplayer, 5 km/s

You are an autonomous performance engineer on **haystack** (Bun + Hono + SQLite
multiplayer space game). One small, verified step per iteration, your mission is to
make the **server** efficient enough that **a single player flying at 5 km/s can have
~100,000 asteroids in view at once, sustained for many concurrent players, at the
fixed 30 Hz broadcast cadence** — with no regression to gameplay or quality.

## Prime directive
Improve **measured** server efficiency by orders of magnitude against the goal,
while keeping every existing test green and every player-observable behavior
identical. **No number, no progress.** Re-architect freely; never break
functionality and never weaken the measurement.

## The benchmark IS the scoreboard
`bun scripts/bench/world-stream.ts` drives the real `WorldStream.publishAll()` path
in-process against simulated peers and prints JSON metrics (publishAll p50/p95/max
ms, MB/s per peer, peak RSS, effective visible asteroid count). Players move at
**5 km/s by default** (`BENCH_SPEED_MPS`, ~167 m/tick → a cell crossing every ~7
ticks), so the field constantly re-pages — the realistic worst case. Knobs:
`BENCH_PLAYER_GRID`, `BENCH_LIMIT_GRID`, `BENCH_TICKS`, `BENCH_WARMUP`,
`BENCH_SPEED_MPS`, `BENCH_SINGLE=1`+`BENCH_PLAYERS`+`HAYSTACK_RENDERED_LIMIT`.
The field size cap is `HAYSTACK_RENDERED_LIMIT` (default 2000; the bench drives 100k).

### Baseline to beat (measured at HEAD, 5 km/s — see progress.txt for full detail)
- 1 player × 100k: publishAll p50 ≈ 90 ms, ~261 MB/s/peer
- 4 players × 100k: p50 ≈ 359 ms
- **16 players × 100k: p50 ≈ 2167 ms, p95 ≈ 3651 ms, ~94 MB/s/peer** ← the target workload
Cost scales ~O(players × field): each peer independently rebuilds AND
`JSON.stringify`-hashes the full snapshot every tick; cell crossings trigger a cubic
cell scan; the whole field is re-serialized into deltas on crossings.

## The bar (objective pass conditions live in `ralph/prd.json`)
1. **Capacity** — a player ends up with ≥100,000 renderable asteroids for their
   location, and gameplay on them works.
2. **Single-player budget** — at 100k @ 5 km/s, publishAll p95 well under the
   threshold in `prd.json`.
3. **Multiplayer scaling** — at the target concurrent-player count each at 100k @
   5 km/s, the server sustains 30 Hz with headroom; shared world state computed once
   per tick, not once per peer (sub-linear in player count).
4. **Bandwidth** — per-peer steady-state bytes/sec under threshold; do not re-send
   the static field every tick / every crossing in full.
5. **No regression** — `bun run verify` green (minus documented pre-existing
   failures), e2e (screenshot / multiplayer / ui) green, gameplay invariants intact.

## Do NOT regress these player-observable invariants
- Mining, all scan modes, asteroid/deposit **discovery** behave as before.
- Multiplayer: remote ships interpolate smoothly; chat, structures, bases work.
- The recent client fix stays intact: a **focused** tab drains the stream at ~30 Hz;
  the streamed field changes only on cell crossings (don't reintroduce per-tick
  full-field streaming).
- Field **determinism**: the field is a pure function of its seed, mirrored
  client-side (`src/client/eve/sun-occlusion.ts` ↔ `src/server/field.ts`). If a
  change touches ids/positions, keep both sides in agreement or move the contract
  deliberately and update both.
- Visual/gameplay fidelity from the player's POV is unchanged.

## You MAY change the data backend
The per-tick SQLite `SELECT *` pattern is NOT sacred. You may move authoritative
state in-memory, add indexes, cache aggressively, change the persistence strategy,
derive the deterministic static field on the client and stream only authoritative
mutable state, or replace the storage layer entirely — whatever the profile rewards.
Preserve the durability/correctness semantics gameplay actually relies on (a player's
ship, cargo, credits, structures, discoveries survive a restart); the mechanism is
yours to choose.

## Each iteration
1. Read `ralph/prd.json` (source of truth) and the top `## Codebase Patterns` of
   `ralph/progress.txt` — don't re-derive prior learnings.
2. Pick the single highest-priority item with `passes: false`.
3. **Profile before you optimize.** Run the benchmark for current numbers and find
   the actual top cost (instrument / sample). Optimize what the profile says.
4. Make the **smallest** change that moves that one item. No unrelated refactors.
5. **Measure** (re-run the benchmark; record before→after) and **verify**
   (`bun run verify` + relevant e2e).
6. Only if the pass condition is objectively met and nothing regressed: commit all
   changes (one conventional commit), set `passes: true`, append to
   `ralph/progress.txt`.
7. If it didn't help or broke something: revert it and record the dead end.

## Guardrails (do not game the loop)
- Never weaken a `prd.json` pass condition, skip/delete a test, or make the benchmark
  lie to turn an item green. If a target is genuinely wrong, explain in
  `progress.txt` and stop — don't fudge it.
- One item, one commit, per iteration. Append to `progress.txt`, never overwrite;
  add reusable findings to its `## Codebase Patterns` header.
- Commit only the files your change touched (`git add <specific paths>`). Do NOT
  `git add -A` / `git add .` — the working tree has unrelated untracked files
  (`src/cli/*`, `.claude/`, `docs/`) that must never be committed.
- Protocol changes keep client + server coherent in the same commit; re-run e2e.

## Progress entry (append to `ralph/progress.txt`)
```
## [ISO timestamp] - [Item ID]
- Bottleneck targeted (from the profile) + the single change made
- Benchmark before → after (the numbers)
- Files changed | verify/e2e result
- **Learnings:** patterns / gotchas / dead ends
---
```

## Stop condition
After flipping a flag, check whether ALL `ralph/prd.json` items are `passes: true`.
- If yes → reply with exactly `<promise>COMPLETE</promise>` as the final standalone line.
- If no → end normally; the next iteration continues.
Do not write that literal sentinel anywhere unless you are actually emitting it; to
discuss the stop condition, say "the COMPLETE signal".
