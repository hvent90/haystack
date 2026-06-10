# GPU-Resident Asteroid Field — Implementation Log (overnight autonomous run)

**Run date:** 2026-06-09 (overnight, unattended). **Branch:** `gpu-asteroids/impl` (off `ralph/client-render-100k`).
**Orchestrator:** Claude Opus 4.8. **Source of truth:** `docs/gpu-asteroids-architecture.md`.

> **WebGPU IS executable here (correction to the original run).** The initial "no WebGPU" conclusion was an
> artifact of probing on `about:blank` — **WebGPU requires a SECURE CONTEXT.** Served from `localhost`/
> `127.0.0.1`, the bundled Playwright Chromium exposes a SwiftShader WebGPU device **headless, zero installs**
> (system Chrome via `CHROME_PATH` gives real Apple Metal). The runner `scripts/bench/gpu-verify-run.mjs`
> (`bun run verify:gpu`) executes the committed gates on a live device. **All three END-STATE GPU gates PASS on
> both SwiftShader and real Metal** (see "DONE & VERIFIED — ON GPU"). Running the real harness also caught +
> fixed 4 real kernel bugs CPU tests could not. No fake green — every claim here was actually run.
>
> _The original probes (`scripts/bench/probe-webgpu*.mjs`) reported `{"gpu":false}` only because they used
> `about:blank` (non-secure → no `navigator.gpu`). Lesson: always serve the page from localhost/https._

---

## SESSION 2 (2026-06-09, continuation) — step-4 ring streaming + the cell-cross hitch, root-caused

> Orchestrator: Claude Fable 5. Each claim below was actually run; numbers are from real Metal
> (`CHROME_PATH` system Chrome) unless noted.

### The handoff's "158 ms hitch on every cell-crossing" was misattributed — root cause found

Measured with a new movement harness (`bun run bench:gpu-cross`, drives the ship across field cells via the
`__HAYSTACK_RENDER_DEBUG__.drift` control and samples per-cross stats + rAF deltas + optional CDP trace/CPU
profile):

1. **The ~158 ms `fieldDeriveMs` was the one-time FIRST-PAINT synchronous derive**, not a per-cross cost.
   `FieldDeriver.asteroidsFor` deliberately bypassed the worker when there was no prior field; with a
   stationary ship (the old `verify:gpu-live` run) `cellCrossCount=1` — that one "cross" WAS boot. The true
   recurring per-cross main-thread cost was ~15–22 ms (worker reconstruct ~5 ms + full 50k GPU repack ~10–15 ms).
2. **The real movement stalls in the live gate were 1.0–1.8 s rAF gaps** — and they are a DEV-MODE artifact:
   react-dom development's performance-track props diffing (`addValueToProperties`/`addObjectDiffToProperties`,
   present TWICE: react-dom + r3f's bundled reconciler) walks the 50k-asteroid array on commits and triggers a
   GC storm. A V8 CPU profile over a 12 s drift window attributed ~3.6 s to that diffing + 1.3 s GC.
   **The production build has none of it: 721/721 frames at 16.7 ms, p99=16.8 ms, 0 frames > 33 ms, across 13
   cell crossings.** The perf harnesses now take `GPU_LIVE_PROD=1` (`verify:gpu-live:prod`,
   `bench:gpu-cross:prod`) to measure `vite build` + `vite preview` — perf claims should cite prod numbers.

### Fixes landed (both TDD'd, gates re-run)

- **Step-4 ring streaming for real** (`src/client/eve/gpu/ring-stream.ts` + `mergeDirtyToRanges` +
  `markRangesForUpload` in `base-derive.ts`; wired in `WorldView.tsx` `InstancedAsteroids`): incremental
  id→slot reconcile straight into the buffer backing stores — kept rocks' slots/bytes untouched, entering
  rocks fill freed slots low-first, evicted slots zero-radius; only dirty element ranges upload
  (`BufferAttribute.addUpdateRange`, confirmed consumed + cleared by three 0.177's WebGPU backend).
  Per-slot bytes are pinned byte-identical to `packBaseFromAsteroids` (a first fill of an empty ring is
  byte-identical to the full pack) by `tests/integration/gpu-ring-stream.test.ts` (incl. 20-round churn fuzz).
- **Boot derive routed through the worker** (`field-derivation.ts`): the first derive now posts to the worker
  like every later cross (seeded-only field for the round-trip frames); synchronous path remains as the
  no-Worker fallback. `tests/integration/field-derivation-boot.test.ts`.

### Verified results (the handoff's stated gate: "worstCellCrossFrameMs drops")

| Metric                                                    | Before                          | After           |
| --------------------------------------------------------- | ------------------------------- | --------------- |
| `fieldDeriveMs` (boot, live gate)                         | 164.8                           | **9.4**         |
| `worstCellCrossFrameMs` (live gate)                       | 174.1                           | **20.0**        |
| per-cross main-thread field work (prod, moving)           | 11–16 ms                        | **6.6–10.6 ms** |
| frames > 33 ms during 12 s of cell-crossing flight (prod) | n/a (dev-only stalls 1.0–1.8 s) | **0**           |

`bun run verify` (96 pass + the pre-existing server.test.ts:921 failure), `verify:gpu` (Metal: ALL PASS),
`verify:gpu-live` (PASS, 60 fps, max frame 16.8 ms) all re-run after the change.

This also closes the handoff's Open Work #2 (the "42.9 ms React-scheduler task"): it was the same dev-mode
performance-track diffing on a coalesced 30 Hz snapshot commit. Production commits are sub-frame
(`reactCommitCount` ≈ 6/s while streaming; 0 dropped frames).

### Step 2 — TSL post stack + ScanPulse (commit 077e310)

Three-native `PostProcessing` (scenePass MRT output+normal → ScanPulse → bloom → ACES via
renderOutput) replaces the removed WebGL EffectComposer. ScanPulse re-derives the player-distance
basis (fragment view position from depth via `getViewPosition`, lifted to scene space; radial gate
= `length(scenePos)` since the owned ship IS the scene origin) — NOT the flagged `-getViewZ` trap.
**New live-gate check:** press V mid-run, capture mid-pulse, require teal-dominant samples to
multiply vs idle (HUD-off captures; idle 0 → pulse ~6000+ on Metal). 60 fps held with the stack on.

### Step 4 remainder — GPU cull/LOD indirect + TSL aSunlit two-tier shadow (this commit)

- **GPU cull/LOD compaction:** `cull-cpu.ts` (CPU executable spec, tested vs THREE.Frustum) +
  `kernels/cull.ts` (clear → cull → publish): per-slot dead-slot/distance/frustum cull + banding,
  compacted into 4 per-LOD slot lists + GPU-written `IndirectStorageBufferAttribute` instance
  counts; 4 `drawIndirect` draws (legacy LOD geometry set: dodeca/icosa/octa/tetra). `setIndirect`
  works on three 0.177 (the doc's "^0.183+" worry was unfounded — the WebGPU backend issues
  drawIndirect from `geometry.indirect`). **Device-caught bug #5:** the first cull kernel bound 9
  storage buffers (pos + 4 lists + 4 indirect) — over the default `maxStorageBuffersPerShaderStage`
  of 8; Dawn rejected the pipeline (silently from JS — only the console showed it). Fixed by
  accumulating into one atomic per-band counter buffer + a tiny publish kernel (cull binds 6).
  **On-device gate (in `verify:gpu`):** GPU lists vs `cullCPU` on the SAME read-back pos bytes,
  set-compared per band with an epsilon-boundary tolerance — PASS on Metal:
  `gpu=[41,311,641,1584] visible=2577 cpu=2577; 0 eps-boundary flips`.
- **aSunlit two-tier shadow in TSL:** `packAttr.w` now carries the sun-occlusion march value;
  `makeLodAsteroidMaterial` blends `mix(aSunlit, shadowMapFactor, bubbleWeight)` via
  `receivedShadowNode` (bubbleWeight = 1 - smoothstep(5, 8, viewDist) — the exact legacy
  patchAsteroidShader semantics). **Perf trap caught by bench:gpu-cross:** marching 50k cold rocks
  on the main thread cost ~440ms at boot — fixed by computing sunlit in the field WORKER alongside
  the derive and priming the main-thread cache from the transferred array
  (`sun-occlusion.primeSunlitCells`). Boot bucket 438.7 → 30.7 ms; per-cross worst 13.8 ms;
  721/721 frames at 16.7 ms in the prod movement bench.
- **Dead code removed** (the handoff's cleanup item, conditioned on this step): the legacy WebGL
  per-chunk path — `AsteroidChunk`, `patchAsteroidShader`, `createAsteroidMaterial`, the per-chunk
  LOD constants, and the now-orphaned `field-chunks.ts`.
- NOTE: with indirect draws, `renderer.info` instance/triangle counts are NOMINAL (CPU-side
  capacity), not actual — the live gate only requires them nonzero.

### Step 6 — cosmetic motion: tumble + gravity wells (commit after step 4's)

- **Spin:** slow per-rock tumble in `makeLodAsteroidMaterial` — Rodrigues rotation about a
  phase-derived axis, angle = rate(phase)·time, applied to local position AND normal
  (`normalNode = transformNormalToView(rotated normalGeometry)`) so facet lighting follows.
  Pure function of (slot phase, time): stateless, eviction-lossless, position-bound-neutral.
- **Gravity wells (§4.3):** `wells.ts` — K=6 deterministic field-seed wells (≤ MAX_WELLS 8), pull
  = per-well Gaussian falloff toward the center, per-well 0.9·distance clamp (no overshoot),
  TOTAL clamped to `WELL_PULL_CAP_METERS = 320` — a pure bounded function of `base` (no
  integrator), keeping worst displacement √3·40 + 320 ≈ 389 m, far inside the 1400 m mine slack
  (a rock near a well can show a small bearing-arrow skew — the documented §4.5 #1 trade-off that
  buys clumping). CPU mirror pinned by `tests/integration/gpu-wells.test.ts`.
- **On-device gate (in `verify:gpu`):** run the overlay with a max-strength well planted 2 km from
  a known rock; read back pos/base over 50k rocks; assert every |pos-base| ≤ √3·wobble+cap, radii
  carried, probe rock pulled > 100 m. PASS on Metal: `max 350.9 m ≤ 390 m; probe pulled 210.7 m`.

### Step 7 — inter-asteroid collisions, first-class (final un-gated step)

- **Pipeline (§4):** the step-5 binner instantiated for the collision world grid (64³ × 768 m,
  ship-cell-snapped window; inlined `cellIndexOf`; new `itemActive` predicate so dead ring slots /
  out-of-window bodies never enter a cell) → `narrow` (27-cell deferred-apply: each lane
  accumulates ONLY its own dp/dv; sphere-sphere half-penetration pushout + restitution 0.15
  impulse on approach) → `apply`. 9 dispatches, all pipelined via `renderer.compute` (§3.3).
- **The cosmetic-tier bound (§4.5 #1 reconciliation):** no free-running integrator. Collisions
  accumulate into `collOffset` hard-capped at 250 m with a damped (0.96/step), speed-capped
  (30 m/s) velocity; `pos = base + wobble + wells + collOffset` ⇒ worst rendered displacement
  ≈ 690 m, inside the radius+1400 m mine slack regardless of pile-up duration. Recycled ring
  slots get their collision state zeroed via the dirty-range upload (all-zero CPU backing).
- **Nc==0 gate (§3.4):** the WHOLE broad+narrow graph (incl. the fixed clearCounts/scan floor) is
  skipped unless a gravity well's clump (3σ) can reach the near-window — the native field never
  overlaps. 3 of the 6 deterministic wells are in range at spawn, so the live run exercises it.
- **CPU executable spec:** `collide-cpu.ts` (`narrowPhaseCPU` brute force + `stepOffsetsCPU`),
  pinned by `tests/integration/gpu-collide-parity.test.ts` (symmetric pushout, momentum-conserving
  impulse, approach-only restitution, three-body accumulation, caps/damping).
- **On-device gate (in `verify:gpu`):** full GPU pipeline vs CPU spec over an AUTHORED DENSE BELT
  (8×8×8 jittered grid, radii 150–330 m, occupancy ≈ 1/cell — §4.3's validation target) on
  identical f32 inputs. **PASS on Metal: dp/dv match over 512 bodies (511 in contact) within
  1e-2.** Two more device-caught TSL bugs on the way: (#6) a storage/atomic read used directly as
  a Loop `end` emits EMPTY WGSL (`i < ;` — pipeline rejected); (#7) NESTED TSL Loops reuse the
  same WGSL loop-variable name and WGSL shadowing silently corrupts cross-scope references —
  restructured to a flat 27-neighbor loop with every outer-derived value `.toVar()`'d before the
  inner loop (this is why the binner's scan kernels avoid cross-scope loop vars).
- **Live:** 60 fps held with the collision graph active (3 wells in range at spawn); prod movement
  bench unchanged (721/721 frames @ 16.7 ms, worst cross bucket 13.9 ms).

**With this, every un-gated architecture step (1–7) is built and device-verified. Steps 8
(promotion netcode) and 9 (froxel volumetrics) remain correctly un-built per the hard gates.**

---

## SESSION 4 (2026-06-10) — step 9: froxel volumetric lighting, built + gated

> Orchestrator: Claude Fable 5, worktree `haystack-froxels`, branch `froxels/impl`.
> Every claim below was actually run; perf numbers are real Metal (system Chrome), prod build
> where stated. Architecture §6 updated future→implemented in the same change.

### What was built (3 commits)

- **Phase 1 — the medium** (`kernels/froxels.ts`, CPU spec `froxels-cpu.ts`): 160·90·64
  view-space froxels, Z = log shells of RADIAL camera distance (0.05→24 scene units) so the
  composite's depth lookup re-derives the same metric (`length(getViewPosition(...))`) — the
  §5 floating-origin discipline, not `-getViewZ`. Baked belt density uploaded ONCE at full
  1024·1024·8 resolution as packed-u32 words (8.4 MB; NOT a 3D texture — `textureSample` is
  fragment-only in WGSL compute), sampled with a manual theta-wrapped polar trilinear per
  froxel center → σ_t. `froxelScatter` (one lane/froxel) + `froxelIntegrate` (one lane per
  X/Y column, IN-PLACE front-to-back prefix: accum[z] becomes cumulative-to-far-edge) join
  the single per-frame compute submission; `froxelComposite` (fragment, read-only storage
  view of froxelAccum — one node carries one WGSL access mode, so the compute-side
  instancedArray gets a second `storage(...).toReadOnly()` view over the same attribute)
  slots after ScanPulse, before bloom. Old 9–18 km linear fog retired; the remaining
  14.5–18 km scene-fog band is ONLY the draw-distance dissolve over the untouched
  `MAX_DRAW_SCENE` cull (in a near-void the structured medium is too thin to hide that pop).
- **Phase 2 — lighting**: the `sun-occlusion.ts` `computeSunlit` march ported per froxel
  against the COLLISION world grid — the §6.3 affinity made real. The collision BINNER half
  now runs every frame (split `binnerDispatches`/`resolveDispatches`; narrow+apply keep the
  §3.4 Nc==0 gate) so the grid exists for the march; froxels only read it (§6.4). Half-cell
  (384 m) steps ≈5.4 km up-sun, product-of-(1−cover), capped penumbra, TRANS_FLOOR
  early-out, HG phase g=0.45. Flashlight: analytic spot cone in scene space, pose pushed by
  `ShipFlashlight` each frame; the own-ship fake additive beam cone retired (remote ships
  keep theirs). Lights skip σ_t≈0 froxels.
- **Tuning**: `FROXEL_DEFAULTS` (sigmaScale 0.22/km·density, floor 0.01, albedo
  0.5/0.56/0.74, ambient 0.008, sunStrength 0.65, hgG 0.45, flashStrength 1) with live
  `__HAYSTACK_RENDER_DEBUG__.froxel({...})` overrides; `scripts/bench/froxel-captures.mjs`
  shoots spawn/dense/void/edge/up-sun/40°-shaft/beam vantages headless on Metal.

### Deliberate deltas from the §6 sketch (recorded in the doc too)

1. **No froxel binner instance.** Rocks never need binning into view-space cells: the value
   is (a) the baked-density medium and (b) the up-sun march through the WORLD grid. The
   reserved `cellIndexOf` re-instantiation stays unused (two lights ⇒ no light culling —
   §6.3's own argument).
2. **March visits only ray-path cells** (with a consecutive-cell dedupe), not computeSunlit's
   27-neighbour sweep: full-sweep parity would be 921600 froxels × 27 cells × 14 steps ≈
   GB/frame of grid reads. A rock in a cell the ray never enters can clip the penumbra cone
   unseen — accepted soft under-shadowing, pinned by an explicit DOCUMENTED-LIMITATION test.
3. **Composite applies after ScanPulse** (medium in front of the scan shell), matching the
   §1.3 chain order.

### Verification (all green, real Metal)

- CPU spec pins: `tests/integration/gpu-froxels.test.ts` — 22 pass (grid geometry inverse,
  polar trilinear incl. the theta seam, ray reconstruction vs three's own Matrix4 math, HG
  normalization, march cover/product/limitation, scatter+integrate closed forms).
- **New `verifyFroxels` device gate in `verify:gpu`**: GPU scatter+integrate (march +
  flashlight included) vs the CPU spec on identical inputs — synthetic smooth polar density +
  64-rock cluster, the grid image (cellStart/cellCount/sortedItems/pos) read BACK from the
  device so both sides march the same f32 bytes. **PASS on Metal: 100.00% of 3,686,400
  floats within 0.03, worst |Δ| = 0.0010; shadowed columns present (last-slice in-scatter
  min/max 0.0116/0.0826); beam column 5.5× over off-cone (0.0686/0.0124).** Full
  `verify:gpu`: ALL PASS (9 gates incl. all pre-existing).
- Suites: `bun run verify` 165 pass / 0 fail (the old server.test.ts:921 failure no longer
  exists on this base).
- Visual gates (screenshots, real Metal): dense-pocket depth haze vs CLEAR resonance-gap
  void vs belt-edge structure; up-sun forward-scatter glare; 40°-off-sun shaft view with
  down-sun darkening behind rocks; flashlight halo dead-on + oblique cone. DM'd to hv at
  each milestone.

### Perf (prod = vite build + preview, real Metal, froxels + every-frame binner live)

- **`verify:gpu-live:prod`: GPU_LIVE_RESULT=PASS — 60.1 fps, p95 16.7 ms, max 16.8 ms,**
  scan gate PASS, shadow gate PASS (tier1=604 tier2=373 noise=125 baseLit=3698
  blendLit=3044), console free of Dawn errors. The whole froxel slice (scatter with the
  march + integrate + composite) plus the now-unconditional collision binner fits inside
  the same 16.7 ms frame the pre-froxel build held — no measurable budget loss at the
  spawn pocket.
- **`bench:gpu-cross:prod` (cell-cross regression): 718 frames median 16.7 ms, p99
  16.8 ms, over33=0, over50=0; worst cross bucket 23.4 ms — vs CURRENT MAIN measured
  back-to-back on the same machine: 28.3 ms (716 frames, over33=0).** No new hitches; the
  froxel pass adds zero main-thread field work (the old 13.9–14.3 ms session-3 numbers
  reflect a quieter machine, hence the same-day A/B).
- Froxel cost structure: scatter 921,600 lanes × (8-tap trilinear + ≤14-step march when
  σ_t > 1e-4, TRANS_FLOOR early-out, lights skipped in vacuum froxels) + integrate 14,400
  lanes × 64 slices; ~50–100 MB/frame of grid reads worst-case; froxelAccum 14.7 MB +
  density 8.4 MB resident. No temporal accumulation needed at 60 fps — deferred until a
  platform misses budget (watch for flashlight-swing smearing if ever added).

### The live shadow gate, made fog-aware + recalibrated (two real findings)

1. **The shadow A/B now runs with the froxel composite OFF** (`dbg.froxel({mix: 0})`,
   restored after): the medium's extinction dims lit faces below the gate's 90-lum baseline
   cut and its in-scatter lifts blacks above the 18-lum "darkened" cut — post-froxel the
   baseline collapsed 15k → 470 lit samples and every threshold lost meaning. The gate's
   job is detecting silently-dead SHADOW tiers; the froxel pass has its own device gate.
2. **The gate's floors were stale against CURRENT MAIN** — with fog isolated, the branch
   still failed (baseLit 3234 > floor 4000? no — under it), so the pre-froxel baseline was
   A/B'd in a clean worktree of main (99b1c8c): **main itself FAILS the gate identically**
   (tier1=555 tier2=295 baseLit=3008 vs the branch's 572/278/3234 — the branch is
   marginally brighter). Root cause: the power-law background-rock radii (a81c400) shrank
   the lit-sample population ~2.5× after the floors were tuned (≈7800-era). Recalibrated
   floors (baseLit > 2000, tier1 > max(0.12·baseLit, 3·noise), tier2 > max(0.06·baseLit,
   2·noise) — tier2's signal on this field is only ~2.3–3.6× the tumble-noise floor, so a
   3·noise arm fails main itself; upper bounds and the noise cap unchanged) keep the
   detection power: a dead tier measures ≈ 1×noise ≈ 0.03–0.04·baseLit, an all-dark
   regression ≈ 1.0 — both still fail. Evidence + per-run numbers in the gate comment.

### Environment gotcha (for the next runner)

`verify:gpu-live[:prod]` defaults to server port 8811/client 5211 — ANOTHER session's dev
server squatting on 8811 makes the gate silently connect to the WRONG game server and fail
with `derivedAsteroidCount` stuck at the seeded 30 ("field did not render in time").
Override with `GPU_LIVE_SERVER_PORT`/`GPU_LIVE_CLIENT_PORT` when sharing a machine.

---

## SESSION 3 (2026-06-09) — inter-asteroid shadowing: diagnosed, fixed, gated

> Orchestrator: Claude Fable 5. Task: take the two-tier inter-asteroid sun shadowing
> (2026-06-07 design) to done-and-visually-verified. Every claim below was run this session.

### What diagnosis found (screenshot A/B, real Metal)

Built `scripts/bench/shadow-diag.mjs`: boots the live game, points the camera DOWN-SUN via a
new `lookDir` debug control (every visible face is sun-facing, so brightness variation
isolates the shadow terms), and toggles each tier via new `shadowTier{1,2}Enable` uniforms in
the `receivedShadowNode` blend. Verdict on the existing implementation — **both tiers were
already alive** (contrary to the task's suspicion that the indirect-draw depth pass silently
renders nothing: three r177's shadow override material copies the object material's
`positionNode` — Renderer.js:2866 — and the depth pass shares the geometry, so the indirect
draws carry into the shadow map). Offline distribution check (`sunlit-hist.ts`): aSunlit at
spawn is bimodal — 44.7% < 0.1, 50.7% > 0.9, 3.6 µs/rock — i.e. the deep field is varied,
not a black wall; one aligned rock fully blocks the ~1° sun, so mid values are rare.

### The real bug: camera-frustum cull starved the shadow map

The cull compacts by MAIN-camera frustum, and the shadow depth pass draws the same compacted
lists — so off-screen up-sun casters didn't exist in the shadow map and near shadows popped
with view direction (the down-sun diagnostic view was the lucky case where occluders sit
between camera and rock, hence on-screen). Fix: rocks whose nearest point is within
`SHADOW_CASTER_SCENE` (≈16.5 scene units — the sphere circumscribing the ortho shadow box)
survive the cull off-frustum (`cull-cpu.ts` + `kernels/cull.ts`, mirrored; the verify:gpu
cull gate re-passed on Metal, visible set 2577 → 14073 at the gate camera). Off-frustum
keeps cost vertex work only (rasterizer clips them). Measured effect: tier-1 darkened-pixel
count in the down-sun A/B went 14935 → 59041. Prod movement bench unchanged: 721/721 frames
@ 16.7 ms, over33=0.

### Shadow quality + stability

- `shadowMapSize` 2048 → 4096 (3.9 m/texel over the 16 km bubble), `normalBias` 0.05 → 0.03,
  `shadowSoftRadius` 2 → 1 (note: R3F `shadows` = PCFSoft, which ignores radius).
- Texel-snapped the camera-following ortho window on the light's fixed image-plane basis
  (`SceneLighting.tsx`) so shadow edges don't shimmer during flight.
- Staged close-up evidence: `shadow-vantage.ts` finds deterministic sun-aligned rock pairs
  near the fixed `stationSpawn`; the diag harness captures them shadow-on vs shadow-off. The
  receiver (`v-43-48-49`, 345 m at 1.6 km, occluder 921 m up-sun) shows a real per-pixel cast
  shadow crossing its lit face, no acne. Handoff: the 5→8 km smoothstep crossfade means a
  rock transitions over ~3 km of travel (~8 s at 360 m/s) — structurally incapable of
  popping; a `SHADOW_DIAG_FLIGHT=1` drift sequence eyeballed clean.
- Known accepted asymmetry: the map's effective up-sun occluder column (~11–19 km depending
  on receiver depth) is longer than Tier 2's K=5 march (5.65 km), so the near bubble is
  statistically darker than the far field (~25% vs ~51% lit). This is the physical look
  (a 200 m rock fully covers the 1° sun out to ~23 km); K=5 deliberately brightens the deep
  field per the design's density coupling. The transition is a smooth radial gradient, not
  a per-rock artifact.

### The repeatable gate (so it can't silently regress)

`verify:gpu-live[:prod]` now includes a SHADOW gate: down-sun camera, four HUD-off captures
(off / off-again / tier2-only / tier1-only). "Darkened" = baseline-lit (>90 lum) pixel driven
near-black (<18) — shadowing in the zero-ambient look goes to true black while the cosmetic
tumble between captures lands on partial lums, so the cut separates signal from noise.
PASS requires tier1 > max(2000, 3·noise), tier2 > max(1000, 3·noise), noise < 600 (noise =
the identical-state capture pair). Healthy Metal run: `SHADOW tier1=8182 tier2=2314 noise=419
PASS`. A silently-dead tier measures ≈ noise and fails. The gate counts toward
`GPU_LIVE_RESULT`.

A fresh-context adversarial review (subagent, no session context) confirmed all evidence and
constraints (verdict: PASS with concerns) and caught a real gate gap: "darkened" only counts
lit→black, so an ALL-DARK regression (aSunlit all-0s — the design's named black-wall failure)
would MAXIMIZE the counts and pass vacuously. Hardened: each tier's darkening is now also
bounded from above (tier1 < 0.8·baselineLit, tier2 < 0.4·baselineLit; healthy ratios 0.53 /
0.15, all-dark ≈ 1.0) and the production blend must retain lit pixels (blendLit > 1200;
healthy ≈ 3600). Re-run: `SHADOW tier1=8315 tier2=2378 noise=439 baseLit=15753 blendLit=3569
PASS`. Review's remaining minor (accepted, recorded): screen-corner receivers at view depth
~6.7–8 km can sit outside the ±8 ortho window laterally while bubbleWeight is still ~0.4, so
a fully-occluded corner rock can render partially lit mid-fade — not visible in any capture;
revisit only if it shows up in play. Also deleted the dead `WorldViewGPU.tsx` step-1
beachhead (imported nowhere, contained a 0.4 ambient that contradicts the zero-ambient
constraint if ever revived).

### Full verification (this session, real Metal unless noted)

- `bun run verify`: 116 pass + the pre-existing server.test.ts:921 failure (honest baseline).
- `verify:gpu` (Metal): ALL PASS (7 gates, incl. the updated cull gate).
- parity-check / parity-edge / parity-sphere: 0 divergence (no derive-path change; insurance).
- `verify:screenshot`, `verify:ui`: ok.
- `verify:gpu-live:prod`: GPU_LIVE_RESULT=PASS — 60 fps (p95 16.8 ms, framesOver50ms=0),
  scan gate PASS, shadow gate PASS, console free of Dawn errors.
- `bench:gpu-cross:prod`: 721/721 @ 16.7 ms, over33=0, worst cross 14.3 ms — the 4096 map
  and the bigger kept set cost nothing measurable.

---

## DONE & VERIFIED — ON GPU (live device, both SwiftShader headless + real Apple Metal)

Run: `bun run verify:gpu` (bundled Chromium/SwiftShader) or
`CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" bun run verify:gpu` (real Metal).
It serves the repo from `127.0.0.1`, boots `THREE.WebGPURenderer` via the repo's own `gpu-verify.html`
harness, and runs the END-STATE gates on a live device. **Result on BOTH adapters: `GPU asteroid
verification — ALL PASS`:**

- **base round-trip (§8.6 #3):** `getArrayBufferAsync(base) === deriveBase` — **bit-identical over 50,000
  rocks (200,000 floats).** Closes step 3 end-to-end: CPU derive → GPU upload → readback, on Metal + SwiftShader.
- **binner scan (§2.3):** GPU exclusive scan === `binCPU` — **bit-identical over all 262,144 cells.**
- **binner scatter (§2.3):** valid grouping — every item exactly once, each inside its cell's
  `[cellStart, cellStart+cellCount)` range (within-cell order is a non-deterministic atomic race, so verified
  by invariant, not byte-equality).

**4 real kernel bugs caught by the live device + fixed** (CPU tests could not see these):

1. `verify-gpu.ts` base round-trip threw `'size' of undefined` — `getArrayBufferAsync` on a storage node never
   used in a pass. Fix: run `genFieldOverlay` (reads `base`) to materialize it before readback.
2. `kernels/binner.ts` `cellCount` is atomic but was cleared/read as plain `u32` (Dawn:
   `cannot assign 'atomic<u32>' to 'u32'`). Fix: `atomicStore`/`atomicLoad`.
3. `count`/`scatter`/`clearCounts` missing a bounds guard → the workgroup-rounded extra lanes over-counted.
   Fix: `If(instanceIndex < numItems/G)`.
4. Scan off-by-one at cell 237857 — a _symptom_ of #3 (tail over-count shifts the prefix sum). Fixed by #3.
   Also: `scatter` atomicAdd'd the non-atomic `cellStart`; fixed with a dedicated atomic `cellCursor` +
   `initCursor` (mirrors `binCPU`'s `cursor = copy(cellStart)`).

## DONE & VERIFIED (real, runnable gates — pasted output below)

### Baseline (clean tree, before any edits)

- `tsc --noEmit`: **exit 0, 0 errors.**
- `bun test tests/integration`: **54 pass / 1 fail.** The 1 failure is **pre-existing and NOT mine**:
  `tests/integration/server.test.ts:921` "diagnoses million-scale virtual asteroid index without
  materializing the field" expects `materializedAsteroids < 10000` but gets `407360`. This is a consequence
  of the earlier `renderedLimit 2000 → 50000` bump (commit `71b8596`). I did not touch it. After my work the
  suite is **84 pass / 1 fail** (+30 new GPU tests, all pass; same single pre-existing failure).

### Step 3 — determinism / base parity — commit `70c3956`

The load-bearing half of step 3's gate. `base` is CPU-derived from the SAME `deriveVirtualField` the server
uses and uploaded; the GPU never regenerates it (§3.2).

- Files: `src/client/eve/gpu/buffers.ts`, `src/client/eve/gpu/base-derive.ts`,
  `tests/integration/gpu-base-parity.test.ts`.
- **Gate: `bun test tests/integration/gpu-base-parity.test.ts` → `6 pass / 0 fail`, 96211 assertions.**
- What it proves (headless, no GPU): the upload-SOURCE bytes are the exact f32 image of `deriveVirtualField`
  in order; a **non-circular** check recomputes positions from the raw server noise formula; full 50k scale;
  determinism (two derives byte-identical); capacity clamping; `seedBaseFromCPU` writes the real
  `instancedArray` backing store.
- **UNVERIFIED:** the end-state `getArrayBufferAsync(base)` GPU round-trip (needs a device). The determinism
  contract — the part that actually rules out a wrong GPU `frac(sin)` field — IS verified.

### Step 5 — Blelloch prefix-sum binner spike — commit `e149544`

The doc's "research-grade TSL" risk, retired in isolation per §9.2 before anything depends on it.

- Files: `src/client/eve/gpu/binner-cpu.ts` (executable spec), `src/client/eve/gpu/kernels/binner.ts` (TSL),
  `tests/integration/gpu-binner-parity.test.ts`.
- **Gate: `bun test tests/integration/gpu-binner-parity.test.ts` → `12 pass / 0 fail`, ~1.98M assertions.**
- What it proves (headless): `binner-cpu.ts` is a GENUINE three-phase work-efficient (Blelloch up/down-sweep)
  tiled exclusive scan — I read it line-by-line to confirm it is NOT a naive loop in disguise, so
  "tiled == naive" is a meaningful proof. Validated at G = 1024 / 70000 / 262144 / 921600 over edge + seeded
  random histograms; scatter is a valid permutation with every item inside its cell range; exclusive-scan
  invariants hold. The TSL kernel mirrors it pass-for-pass behind an inlined `cellIndexOf` (§2.3).
- **UNVERIFIED:** GPU execution of `kernels/binner.ts`. **KNOWN GPU GAP (must fix before use):** `scatter`
  calls `atomicAdd` on the non-atomic `cellStart` node — on a real device this needs an atomic view of that
  buffer (the file documents this). A GPU-vs-CPU parity gate is mandatory before collisions depend on it.

### Step 4 (partial) — slotMeta id↔slot bridge — commit (see `git log`)

The most-flagged step-4 trap, retired with a runnable CPU gate (the rest of step 4 — ring re-seed of crossed
slabs + GPU cull/LOD indirect — is NOT built; see below).

- Files: `slotMeta` buffer + `backingU32Of` in `buffers.ts`; `idFromSlotMeta` + `seedU32FromCPU` + slotMeta
  derivation in `base-derive.ts`; `tests/integration/gpu-slotmeta-bridge.test.ts`.
- **Gate: `bun test tests/integration/gpu-slotmeta-bridge.test.ts` → `5 pass / 0 fail`, 106504 assertions.**
- What it proves (headless): `slotMeta` (uvec4 cx,cy,cz,epoch) reconstructs the EXACT `deriveVirtualField` id
  `v-cx-cy-cz` for every slot, so temporal per-rock state can key on slotMeta and NEVER on the
  non-deterministic compacted draw slot (§2.2). All cells lie in the FIELD 100³ id-space [0,99] (NOT the
  collision 64³ — the documented off-by-one trap); residencyEpoch is carried; `seedU32FromCPU` writes the
  real buffer backing.

### Step 1 — WebGPU renderer beachhead — commit `f918023`

Section 7 step 1 + §8 bring-up code, as an **isolated, non-destructive** module set. **Does NOT touch the
working WebGL `WorldView.tsx`/`App` — the existing app still boots unchanged.**

- Files: `capability.ts`, `renderer-factory.ts`, `kernels/overlay.ts`, `kernels/render-node.ts`,
  `components/WorldViewGPU.tsx`, `tests/integration/gpu-capability.test.ts`,
  `tests/integration/gpu-overlay-bound.test.ts`.
- **Gates that pass:** `tsc --noEmit` clean (strict + `exactOptionalPropertyTypes`); `vite build` bundles
  three/webgpu + all modules (`✓ built in ~1.4s`); `bun test gpu-capability gpu-overlay-bound` →
  `7 pass / 0 fail`. Capability detection is tested against a mocked `navigator` (all 3 branches incl. the
  exact unsupported message); the ±40 m bounded-overlay invariant is tested over a phase×frame sweep.
- WebGPU-only, no fallback (capability check refuses non-WebGPU). StrictMode double-init guarded via a
  per-canvas `WeakMap` renderer-promise memo (I reviewed `renderer-factory.ts` — the guard is correct).
- **UNVERIFIED (no device):** renderer boot/`init()`, overlay dispatch, zero-copy draw, floating-origin
  render, the StrictMode double-mount path on a live device. Per its definition-of-done the _boot_ itself is
  the gate and it cannot be exercised here — step 1 is **code-complete + statically verified, boot pending a
  real GPU.**

---

## HOW TO RE-RUN THE GPU GATES (now automated, headless, zero installs)

The GPU gates are now push-button and already PASS (see "DONE & VERIFIED — ON GPU"):

```bash
bun run verify:gpu                  # bundled Chromium / SwiftShader (deterministic, CI-grade)
CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" bun run verify:gpu   # real Metal
```

The runner (`scripts/bench/gpu-verify-run.mjs`) serves the repo from `127.0.0.1` (required — WebGPU needs a
secure context) and drives the repo's own `gpu-verify.html` harness headless. Exit 0 iff every gate PASSes.

**Still needing a real-GPU human smoke test (visual, not automatable as a gate):** load the actual game
(`bun run dev:client`, open `http://localhost:5173/`) and confirm the field renders on WebGPU. The post stack
(scan VFX/bloom/ACES) is intentionally absent until step 2 (TSL PostProcessing).

---

## DECISIONS MADE (my best judgment — user asked me to decide; please ratify, §9.1)

The user went to sleep saying "make your best judgement calls on the open questions." All four §9.1 decisions
were resolved toward the **cosmetic-only** end-state, which keeps steps 8–9 correctly un-built and lets 1–7
proceed as pure client-GPU cosmetic work:

1. **Do collisions need to MATTER beyond cosmetic? → NO (recommended default).** Collisions stay cosmetic;
   anything that must matter is server-simulated in the small. This preserves the static-field ~0-wire
   free-ride and avoids the entire promotion-netcode burden (deposit synthesis, fingerprint collapse,
   two-body cascade, demotion-during-contact, non-determinism→shared-authority race). **⇒ Step 8 NOT built.**
2. **Do minable rocks ever MOVE? → NO.** The visual-only boundary holds; the authority problem dissolves.
   `base` stays static/server-matched; only the renderer reads `pos`.
3. **Is the ship ever STOPPED/bounced by rocks? → NO (out of scope).** `ship-motion.ts` stays
   asteroid-unaware; the GPU plough is cosmetic on the ship side too. (A server ship-vs-asteroid test is a
   larger net-new piece; not in scope.)
4. **`MAX_RESIDENT` client capacity → 50,000.** Matches the default `renderedLimit`; 3.2 MB bulk-render
   (64 B/body) at 50k, comfortable. Headroom to 256k documented in `buffers.ts` as a later tuning knob.

If any of these should be "yes", step 8 (promotion authority netcode) is the gated dependency and must be
designed before collisions can be made authoritative.

---

## NOT BUILT (and why) — steps 2, 4, 6, 7, 8, 9

- **Step 4 remainder (ring re-seed + GPU cull/LOD indirect):** the slotMeta id-bridge above is done; the ring
  bookkeeper (CPU derive of crossed slabs + sub-range upload into a fixed-capacity window) and the per-LOD
  `IndirectStorageBufferAttribute` + `setIndirect` cull/compaction are NOT built. The ring re-seed is
  CPU-gateable and a good next CPU-verifiable target; the cull/LOD indirect needs a device (and a stable
  slot↔cell window design that differs from the current distance-sorted `deriveBase` layout — a design choice
  to make deliberately, which is why I did not improvise it unverified).
- **Step 2 (TSL post stack + ScanPulse), Step 6 (cosmetic
  motion: spin + gravity wells), Step 7 (collisions narrow phase):** their definition-of-done gates are
  **fundamentally GPU-execution / screenshot-visual** (parity screenshots, occupancy heatmap, 100k dense-belt
  validation, `renderer.info` instrumentation). None can pass without a device. Per the mission ("3 steps that
  genuinely pass beat 6 that don't") I did NOT produce unverifiable code for them — it would risk calcifying
  wrong. They are ready to start once a GPU is available; the binner (step 5) and base/overlay (steps 1/3) they
  build on are in place. NOTE: `bloom` is in `three/addons` (not `three/tsl`) — step 2 will import it from there.
- **Step 8 (promotion authority netcode):** HARD-GATED behind the product decisions above. Decision #1 = NO,
  so it stays unbuilt by design. Do not build without reversing decision #1.
- **Step 9 (froxel volumetric lighting):** explicitly future/additive. Not built.

---

## NEXT STEP (exactly where to resume)

1. ✅ DONE: GPU verification path established (`bun run verify:gpu`); steps 3 (base round-trip) and 5 (binner
   scan + scatter) are FULLY closed on a live device (SwiftShader + real Metal). The known binner atomic
   `scatter`/`cellStart` gap is fixed (dedicated atomic `cellCursor` + `initCursor`).
2. **Human visual smoke test:** load the actual game on WebGPU (`bun run dev:client` → `http://localhost:5173/`)
   and confirm the GPU-resident field renders. (Automatable gates pass; pixels need an eyeball.)
3. Proceed to **Step 2** (TSL post stack + ScanPulse, re-derived player-distance basis) — restores the scan
   VFX/bloom/ACES removed when switching off the WebGL EffectComposer. Its screenshot gate can now run via the
   same headless-Chromium-from-localhost path. Then step 4 (ring re-seed + GPU cull/LOD indirect), 6, 7.
4. Cleanup: remove the dead legacy WebGL asteroid path in `WorldView.tsx` (AsteroidChunk / patchAsteroidShader
   / createAsteroidMaterial) once step 4's TSL shadow/LOD lands.

---

## HONESTY CHECK — what is verified vs not

- **VERIFIED ON A LIVE GPU** (SwiftShader headless + real Apple Metal, `bun run verify:gpu`): base round-trip
  (`getArrayBufferAsync(base) === deriveBase`, bit-identical 50k rocks); binner GPU scan === `binCPU`
  (bit-identical 262144 cells); binner scatter valid grouping. These were FAILING until the 4 device-caught
  bugs were fixed — they are real passes, re-run on demand.
- **VERIFIED ON CPU** (bun tests): determinism contract (base == derive, non-circular); Blelloch tiled-scan +
  scatter algorithm vs naive reference; slotMeta id-bridge; capability detection; bounded-overlay invariant;
  strict typecheck; production build bundling three/webgpu into the main app.
- **NOT YET VERIFIED (needs a human eyeball or later steps):** the actual game rendering correctly on WebGPU
  (visual smoke test — the automatable gates pass, but no screenshot-diff of the live game yet); the post
  stack (removed, returns in step 2); ring/cull indirect + collisions (steps 4/7, not built). The e2e
  screenshot suite (`verify:e2e`) will fail under Playwright's bundled Chromium when it hits the game page
  unless served from localhost with WebGPU — adapt those to the secure-context runner pattern when needed.
