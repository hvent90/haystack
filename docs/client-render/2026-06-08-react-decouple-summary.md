# Decoupling the 30 Hz world stream from React render cadence

**Date:** 2026-06-08
**Branch:** `ralph/client-render-100k`
**Brief:** `prompt.md` — client ran ~5 FPS on a 2025 M-series MacBook Pro; a Chrome trace
proved the GPU was idle and the cost was per-30 Hz-delta React work, not drawing.

## Root cause (confirmed, not assumed)

The render path (frustum/distance/LOD culling, chunked `InstancedMesh`, server independence)
was already solved by the prior C0–C7 work. The remaining ceiling was the **data → React
coupling**:

- Every virtual/derived asteroid is `discovered: true` (`field-core.ts`), so
  `buildOverviewRows` emitted **one row per discovered rock — ~50,000** at the current default
  `HAYSTACK_RENDERED_LIMIT=50000`.
- `EveApp` stored the world in one `setSnapshot` `useState`. The 30 Hz WebSocket **delta
  handler called `setSnapshot` on every delta** → a full React reconcile of the whole UI tree.
- `ScannerWindow` rendered **one `<tr>` per row, un-virtualized** → ~50,000 DOM rows rebuilt,
  re-sorted, and re-diffed by react-dom on every commit.

That single fact explains both trace hot spots — `buildOverviewRows`/`sort` ≈ 16% (building
50k rows) and react-dom `addObjectDiffToProperties` ≈ 17% (diffing 50k `<tr>` per commit) — and
the two ~400 ms synchronous blocks. The `renderedLimit 2000→50000` default commit is what
tipped a bad-but-survivable list into a frame killer.

This was independently confirmed by the user's own observation: **closing the EVE windows did
not fix it**, because the overview *build* and the full-tree reconcile happen in `EveApp`
(upstream of the windows) on every delta — only the *rendering* of the 50k rows lives in the
window.

## The fix (smallest change that breaks the every-delta → full-reconcile loop)

1. **Coalesce `setSnapshot` to ~10 Hz** (`EveApp.tsx`). A `liveSnapshotRef` is merged
   synchronously on every 30 Hz delta (the source of truth for the merge pipeline); the React
   `snapshot` state is mirrored from it via an rAF-gated leading+trailing throttle
   (`snapshotFlushIntervalMs = 95`). All six `setSnapshot` writers route through one
   `applySnapshot(producer)` helper that merges against the ref; boot/hello hard-resets use
   `commitSnapshotNow` (immediate). Per-delta side effects (`pushRemotesToStore`, prediction
   reset, `fieldDeriver.setSeeded`, predicted-ship eval) are **hoisted out of the producer** so
   they run exactly once synchronously per event (also fixing a latent StrictMode
   double-invoke). The 3D scene/camera/ship were already decoupled (they read
   `flightRenderStore` in `useFrame`), so the lower React cadence does **not** affect frame
   rate — only UI text updates at ~10 Hz.

2. **Virtualize the overview** (`ScannerWindow.tsx`). Render only the rows inside the scroll
   viewport (+overscan) with top/bottom spacer `<tr>`s; ~40 DOM rows instead of ~50,000. All
   e2e selectors preserved; spacers carry no `data-testid`; the window re-anchors to the top on
   filter/sort change so the sorted-nearest rows are always visible.

3. **Slim `buildOverviewRows`** (`overview.ts`). The field-static row scaffold
   (id/name/clue/position/signature) is memoized on the `snapshot.asteroids` reference
   (`buildAsteroidScaffold`), so it only rebuilds on a cell crossing — per-commit work is just
   distance/bearing. The O(50k) `asteroidsById` Map is now built **lazily** (only for scan-hit
   / discovered-deposit lookups), skipped entirely in the common case.

4. **Skip the work when the overview is closed** (`EveApp.tsx`). The sorted/filtered
   `visibleRows` is only built when the Scanner window is open (directly addressing the "windows
   closed but still calculating" observation).

## Before / after (deterministic, headless)

Measured with `scripts/bench/react-churn.ts`: boots the server + client, spawns a continuously
moving "mover" pilot so the measured client receives a real 30 Hz position delta every tick,
then samples a 7 s window via Chrome CDP `Performance.getMetrics` + DOM counts. The robust,
hardware-independent signals are the **counts** and **CDP ScriptDuration**, not headless
wall-clock FPS (see caveat).

| metric | dev BEFORE | dev AFTER | prod BEFORE | prod AFTER |
|---|---:|---:|---:|---:|
| overview `<tr>` in DOM | 50,014 | **17** | 50,014 | **17** |
| JS main-thread ms/s (`ScriptDuration`) | 446.7 | **33** | 161.6 | **~25–57** |
| layout ms/s | 24.2 | **0.08** | 96.4 | **0.31** |
| recalc-style ms/s | 0.98 | **0.01** | 2.2 | **0.05** |
| React commits/s | ~30 (per delta) | **~1.3–1.9\*** | ~30 | **~1.9\*** |
| overview builds/s | ~30 | **~1.3–1.9\*** | ~30 | **~1.9\*** |

(JS main-thread dropped 447→70 ms/s with coalescing + virtualization, then 70→**33 ms/s**
once the compact overview model stopped materializing the 50k rows — a **13×** reduction
in dev.)

\* rAF-gated; headless software-raster pins rAF to ~2 fps, so commits land at ~1.9/s. On a real
60 fps display the flusher gates to the ~10 Hz cap.

### The dev-vs-prod split the brief asked for

A production build alone cut JS scripting **447 → 162 ms/s** (StrictMode double-invoke +
unminified dev React ≈ **64%** of the JS cost) — but **both dev and prod stayed at ~1 FPS
before the fix**, because the 50k-DOM-row architecture kept the main thread 100% saturated
(`TaskDuration` ≈ 999 ms/s in both). So dev overhead was real but **not** the binding
constraint; the architecture was. After the fix, the React/overview cost is gone (DOM 50k→17,
ScriptDuration down 5–6× in dev / 2.8× in prod, layout → ~0).

### FPS caveat (why headless wall-clock doesn't move)

`fps` / `taskMsPerSec` / `medianFrameMs` stayed pinned in headless after the fix because
**swiftshader software-rasterizes the 50k-asteroid shadowed scene on the main thread**, which
saturates it regardless of React. That is a headless artifact — and the exact inverse of the
real-hardware situation, where the GPU is hardware-accelerated and **idle** (the trace proved
it), so on the real M-series laptop the React churn *was* the bottleneck and removing it lets
the idle GPU render the scene at full rate. This matches the project's own measurement
philosophy (`ralph/prd-client.json`: trust deterministic counts over noisy headless FPS).

## Second trace (post-fix) — "FPS still bad" was a measurement artifact

A fresh trace captured after the fix (`screenshots/Trace-20260608T214753.json.gz`) still
showed bad FPS, but analysis (an independent multi-agent pass, corroborated by hand) found
it was **~93% dev-mode + DevTools-recording instrumentation**, not app code:

- `run` 60.7% = React 19 dev `_debugTask.run()` / `console.createTask().run()` under
  `runWithFiberInDEV`; `createTask` 16% = `console.createTask()` owner-stacks called per
  element from `jsxDEV`; plus `v8::Debugger::AsyncTaskRun` (×11k), `V8Console::runTask`
  (×9k), `UserTiming::Measure`, `CpuProfiler::StartProfiling`, and StrictMode
  double-invoke. **All of it disappears in a production build with recording off.**
- The fix's app costs are confirmed collapsed in this trace too: `buildOverviewRows`
  16%→0.9%, react-dom prop diffing 17%→2.7%. Only ~5.5% of main-thread self-time would
  survive a production build; the 3D path is idle.
- **To read real FPS:** `vite build && vite preview --port 4173`, open the prod page, turn
  OFF "async stack traces" in the Performance panel, and capture on the real machine. The
  dev trace literally cannot tell you the real frame rate.

## Compact overview model (GC fix) + crash fix

- **Compact model:** `buildOverviewModel` keeps the field-static scaffold + the small
  dynamic rows + a sorted **index** array (`order`, packed ints; only built when the
  Scanner is open), and materializes a real `OverviewRow` **only on demand** — the visible
  window, the selected row, the context/info row, and the in-world brackets. Per-commit
  asteroid garbage drops from ~5 objects × up to 100k (~200–500k objects/commit) to a
  couple of arrays + ~40 rows. This is what took JS 70→33 ms/s and removes the genuine
  (prod-surviving) part of the 15.9% GC. Selection/context/info resolve by key (O(1)), so
  a selected rock outside the virtualized window still tracks correctly (verified by
  gameplay-100k's selection-survives-culling check).
- **SpatialAudio crash fix:** a `PositionalAudio` was built from the listener's context but
  its drone from a separate `ctx` prop; an HMR/StrictMode teardown (the engine closes +
  recreates its `AudioContext` on dispose) could skew them, and connecting nodes across
  two contexts threw and killed the whole `<Canvas>`. The drone is now built from
  `listener.context` (guaranteed to match) with a guard that skips a voice instead of
  crashing the scene.

## Render architecture for hundreds of thousands (short read, measurement-backed)

The draw path is **not** the next ceiling at the current target, so WebGPU/TSL compute would be
solving a problem the measurement doesn't show. In binding order:

1. **[fixed] React churn** — was the ceiling; now ~10 Hz coalesced + virtualized.
2. **Overview build/sort at very high N** — still O(N) per commit (~5 ms for 50k at ~10 Hz).
   At 500k that is ~50 ms/commit. The clean scaling path (not needed yet) is a compact model:
   sort a typed `Float`/index array by distance and materialize `OverviewRow` objects only for
   the visible window + selected/context rows, instead of allocating N row objects per commit.
3. **GPU-driven instancing (Three WebGPU + TSL compute)** — only worth it once the **in-view**
   instance count or per-frame matrix upload becomes the ceiling. Per-chunk `InstancedMesh` +
   frustum/distance/LOD culling already bounds submitted work to what's actually in view, not
   the total field, and the server stays independent of render count. Revisit *after* profiling
   on real hardware shows the draw path is the new ceiling — references in `prompt.md`.

## Test status

- Integration: 54/55 pass; the one failure (`server.test.ts` "diagnoses million-scale") fails
  identically on clean HEAD — pre-existing, server field-diagnostic, unrelated to this work.
- e2e `multiplayer`: pass. e2e `ui`: pass at a sane `renderedLimit` (its 50k failure is headless
  raster saturation, pre-existing from the `renderedLimit→50000` default).
- e2e `prediction` / `jitter`: **fail identically on clean HEAD** at both 2000 and 50000 —
  pre-existing netcode-timing failures on this branch (from earlier server-tick / renderedLimit
  commits; the Ralph loop only ran integration tests, so they went unnoticed). Not caused by
  this change. These interactive flight tests should be pinned to a low `renderedLimit` (they
  test netcode, not 50k rendering) — flagged as follow-up.
