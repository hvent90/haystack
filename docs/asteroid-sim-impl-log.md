# Asteroid belt sim→bake→runtime — implementation log

Contract: `prompt.md` (repo root). Design conversation: `context.md`.

## Session 1 — 2026-06-09

### Integration-surface audit (before any sim work)

- `src/server/field.ts` and `src/client/eve/field-core.ts` duplicate `virtualAsteroidAt`
  bit-for-bit (`noise = frac(sin(seed·12.9898)·43758.5453)`, `hashCell` with primes,
  seed 424242, cellSize 1130, cellsPerAxis 100, originOffset −56500). Everything flows from
  it: GPU `base` upload (`gpu/base-derive.ts`), `sun-occlusion.ts`, scan hits, ring-stream
  re-seeds, `shared/collision.ts`.
- The parity gate `tests/integration/gpu-base-parity.test.ts` contains an INDEPENDENT
  re-implementation of the noise formula (`rawRock`) — replacing the derivation means
  updating server + client + that test's reference in one pass.
- `docs/gpu-asteroids-architecture.md` §3.2: `base` is f64-CPU-derived and uploaded; GPU
  never regenerates it. This is the determinism rule the bake lookup must preserve: the
  bake is read on the CPU in f64 on both sides; the GPU continues to receive uploads only.
- Scale note for Phase 3: `base` stores ABSOLUTE world meters as f32. World coordinates
  beyond ~2×10⁶ m would quantize visibly (f32 ULP 0.25 m at 2e6). The sim/bake are
  scale-free (normalized units, polar bake); the world-meters mapping is a Phase 3 decision
  made against this constraint.

### Phase 1 — sim application (`beltsim/`)

Decisions:

- **REBOUND 5.0 via uv** (pinned in `uv.lock`), Python 3.12. WHFast, safe_mode 0,
  synchronize at event boundaries. REBOUND 5 API differences from 4.x: whfast knobs live on
  `sim.integrator`, `sim.synchronize()`, `remove(i)` preserves order, add/remove auto-flag
  Jacobi recalculation.
- **Sharded test particles across processes** (default `min(cores−2, 10)`): massless
  particles can't perturb the moons, every shard integrates the identical massive-body
  system, so shard outputs concatenate exactly. 1M particles × 8000 orbits ≈ 1 h wall.
- **Removal is evolution-driven** (e ≥ 0.85, moon-crossing within 2.5 R_Hill, r outside
  [0.25, 6]): no a-priori carving, gaps must empty themselves via resonance pumping.
- **Families injected mid-sim at staggered times** (window [0.15, 0.995]·t_end) from a
  surviving parent rock's instantaneous state + correlated δv (1e-3..8e-3 of v_orb):
  Keplerian shear gives an age spectrum — old families are azimuthal rings tight in element
  space, young ones tight clumps. Verified visually in smoke plots.

Measured/learned (smoke runs, 20–30k particles):

- v1 geometry (outer moon a=2.5, μ=3e-3) truncated the belt at its 2:1 (a≈1.57) — the
  exact real-belt analogue (Jupiter's 2:1 ends the main belt). Wasteful but physical.
  Moved the outer moon to a=3.0 so the 3:1 (1.442), 5:2 (1.628), 7:3 (1.699) all land
  inside the belt and the 2:1 edge sits at 1.89.
- **An embedded shepherd moon in a hot belt carves a moat, not a lane**: the radial-overlap
  crossing criterion scales with a·e (±0.09a at e≈0.05), so a μ=5e-5 moon cleared
  a ∈ [1.58, 1.97]. Removed from the default preset (its resonances do the work instead);
  kept deliberately in the `shepherd-moat` alternate preset as the diversity proof.
- At 800 orbits gaps are not yet visible (44 removals); at 3000 orbits with μ_veil=2.5e-3
  the 3:1 notch, 2:1 edge depletion + outer ringlet, and e-pumping chimneys are clearly
  visible. Default preset therefore runs 8000 orbits.
- Smoke timing: 30k particles / 3000 orbits = 39 s on 10 shards. Scaling ⇒ default
  1M / 8000 orbits ≈ 1 h. Kirkwood-gap clearing per Wisdom's classic result needs ~10³
  perturber orbits; 8000 inner orbits = 1540 veil orbits. Geometry ratio of our 3:1 to the
  moon (0.48) matches Jupiter's 3:1 exactly.

### Phase 2 — bake (first cut, proven on smoke)

- Artifacts: `heroes.bin.gz` (f32 x,y,z,d + i16 family, 20B records; top-N by power-law
  size draw), `density.bin.gz` (uint8 polar `[r][theta][z]`, σ=1.5-cell smoothing — Poisson
  denoise only, below the runtime's procedural-detail scale), `flow.bin.gz` (int8 dir +
  speed, 256×256), `zones.bin.gz` (radial band/gap labeling), `belt-meta.json`.
- Heroes are EXCLUDED from the density grid (no double-counting).
- Smoke bake = 0.23 MB compressed at 256×256×8; default 1024×1024×8 projected ~3–5 MB.
- Tile pyramid decision: deferred until the default bake's real size is measured. If the
  whole artifact stays ≤ ~5 MB compressed there is no need for tiles; record final call
  here. (Leaning: ship whole; the far-field consumer can downsample at load.)
- Found: gaps crisp in semi-major axis are shallower in physical r (eccentricity smears
  them — true of real belts). Zone detection thresholds must be tuned on the 1M bake, not
  smoke.

### Next

- 1M default run baking + plots → DM user.
- `shepherd-moat` alternate preset end-to-end (tuning-loop proof).
- Phase 3 design: world-scale mapping vs f32 constraint; shared TS derivation module
  consumed by both `field.ts` and `field-core.ts`; parity tests updated same pass.

### Phase 3 design (locked before implementation)

- **World scale**: a=1 (normalized) → R₀ = 1.0e6 m. Belt annulus r ∈ [0.5, 3.25]·R₀, max
  |coord| ≈ 3.25e6 m, f32 ULP there 0.25 m — the GPU `base` buffer keeps absolute world
  meters and the f32 pipeline survives unchanged. ("Millions of km" of the design prose is
  traded for keeping §3.2 intact; 6500 km of belt against a ~20 km derive bubble is still
  3+ orders of magnitude of search space.)
- **Field grid goes non-cubic**: x,y ∈ ±3.25e6 (cells ~5752/axis), z ∈ ±~90 km (160
  cells). cellSize stays 1130. FieldSummary grows a `belt` block (preset, formatVersion,
  worldScale, grid dims); ids stay `v-cx-cy-cz`.
- **≤1 rock per cell, probability-driven**: rockCount(cell) = hash roll < min(λ,1) where λ
  = trilinear f64 sample of the baked density × density_scale. Keeps the 1-cell-1-id
  invariant, slotMeta untouched, collision.ts broad phase shape preserved. Dense band λ→
  ~0.9 ≈ today's density; gaps λ→~0.02.
- **Heroes replace their containing cell's rock** (id v-cx-cy-cz preserved; position,
  radius, family from the hero record; bake dedupes multi-hero cells keeping the largest).
  Hero radius_m = 100·d^0.75 (d ∈ [1,60] → up to ~2.2 km); MAX_ROCK_RADIUS in
  collision.ts must follow.
- **Families**: carried by the baked density itself (the sim's debris IS the family
  signal, sheared by real dynamics) + family ids on hero records for mineral correlation.
  No separate runtime family point layer.
- **Pockets become zone-driven**: zones.bin radial band/gap labels → pocket names (legacy
  names mapped onto bands so gameplay keys survive). Mineral weights per zone + per hero
  family.
- **One shared derivation module** (`src/shared/belt/`) imported by server field.ts,
  field-core.ts, collision.ts, sun-occlusion.ts — kills the 3 hand-synced copies. The
  server's full-field scan is replaced by the shared growing-cube derive (bounded; sparse
  regions legitimately return < renderedLimit rocks).
- **Artifacts** committed under `public/belt/<preset>/` — vite serves them to the client,
  Bun reads the same files from disk; the worker gets bytes transferred from the main
  thread. gzip decoded via DecompressionStream / Bun.gunzipSync to identical bytes.
- **Spawn/world-seed**: stationSpawn + seeded pockets/structures translate by +1.272e6 m
  on x into the inner band (long-echo lands near the 3:1 gap edge).
- **Far-field**: client-only density-haze annulus (TSL material over a z-summed density
  texture) + seeded impostor speckle layer; no parity, no gameplay reads.

### Phase 3 implementation record (session 1, continued)

Landed (all gates green at each step):

- `src/shared/belt/` — artifact decode (`format.ts`) + THE derivation (`field.ts`):
  trilinear f64 density sampling, ≤1-rock-per-cell probability model, hero cell
  override, zone-driven pockets/minerals, growing-cube `deriveBeltField` (capped at
  half-width 44; sparse regions legitimately return < renderedLimit rocks).
- Server `field.ts` branches belt/hash; `HAYSTACK_FIELD=hash` keeps the legacy field as
  the baseline; `HAYSTACK_BELT_PRESET`/`HAYSTACK_BELT_DENSITY` are runtime knobs.
  totalAsteroids = polar volume integral of the bake ≈ 71M for the smoke artifacts.
- Client: `belt-bake-loader.ts` (fetch + gzip-aware decode), field-core registration +
  belt branches, worker fetches its own copy, FieldDeriver gates derives on bake
  readiness, collision env + sun-occlusion + EveApp wired; world-seed/station/spawn
  relocated to the inner band (x ≈ 1.265e6).
- AXIS MAPPING (caught before any visuals): game world is y-up; sim is z-up. Decode maps
  sim (x, y, z) -> world (x, z→y, y→z). Belt plane = world x–z.
- Tests: `belt-parity.test.ts` (server ≡ client bit-for-bit at 4 positions, GPU base f32
  image, double-load determinism, band≫gap density, sparse-derive semantics); collision +
  server tests updated to belt coordinates. Full `bun run verify` 140/140 green.
- GPU device gates: added `verifyBeltBaseRoundTrip` (50k bake-derived rocks bit-identical
  through upload/readback) — `bun run verify:gpu` ALL PASS on device.
- Gotcha for posterity: vite serves `.gz` with Content-Encoding: gzip → the browser
  transport-decodes; the loader sniffs the gzip magic instead of assuming.
- Far-field: `BeltFarField.tsx` — density-haze annulus (TSL node material over a z-summed
  DataTexture, near-camera fade past the derive bubble), 60k seeded speckle impostors
  sampled ∝ density, gas giant + moons at origin. Purely visual, fog-exempt.
- First in-client run (smoke bake): boots clean, ~71M indexed, belt band visible from
  inside, no console errors. Screenshot DM'd.
- Pacing note: cruise 220 m/s ⇒ pockets at 14–200 km keep the old pacing; the full
  6.5e6 m belt is long-horizon search space/scenery. Movement changes out of contract.

### Perf (bench:gpu-cross:prod, real Chrome/Metal, production bundle, smoke bake)

- Belt field: 718 frames median 16.7 ms / p99 16.8 / max 33.4, over50 = 0, over33 = 1;
  13 forced crossings at 150 m/frame, worker derive 7–10 ms each, worst cross-frame
  17.1 ms. No dropped-frame regression from the bake lookup.
- Hash baseline on this machine: median 16.7 / p99 16.8 / max 16.8 (vsync-locked; note
  the relocated spawn sits outside the legacy cube so the drift window produces no
  crossings — frame numbers are the render baseline, derive cost compared via the belt
  run's own worker timings, which match the pre-belt era's ~8–12 ms).

- verify:gpu-live:prod with the smoke bake: frames p95 16.7 / 60.1 fps, SCAN gate PASS,
  SHADOW gate FAIL (tier1=383 vs >2000, baseLit=2931 vs healthy ~15500). Cause: band
  density at spawn ≈ 0.38 rocks/cell (smoke bake) vs the legacy 1.0/cell — down-sun
  occlusion is genuinely rarer, the gate's absolute pixel thresholds assume the old
  density. Re-evaluate on the 1M bake; if still short, relativize thresholds to
  baselineLit (keeping the all-dark upper bounds + noise floors that make it
  non-vacuous).

### Fresh-context audit (Phase 3)

Verifier subagent audit (adversarial, read-only + test runs): all seven contract claims
verified — one shared derivation module, invariants kept, zone-driven pockets/minerals,
parity suites green, no determinism leaks, axis mapping consistent across bake/decode/
sampling/render, collision broad-phase sound. One real bug found and fixed: heroes whose
sim position lay beyond the baked z_max were silently dropped at decode (3/2000 in the
smoke bake) — the bake now clips hero candidates to the baked volume, and decode gained
guards (cell-key base assert, record-length validation). Noted concerns: thresholded
existence roll amplifies any cross-engine Math.sin ULP drift (probability ~1e-16/cell,
accepted); streamedFieldToken is test-pinned reference API with no production consumer
(virtual field is fully client-derived; server production consumers are virtualScanHits +
fieldDiagnostic, both belt-aware).

## Session 1 — 1M default run results (the definitive bake)

- Sim: 1,000,000 particles, 8000 inner-belt orbits (1540 veil orbits), 75 min wall on 10
  shards. 972,472 alive / 27,531 removed.
- Histogram (runs/default/plots/kirkwood-histogram.png): deep 2:1 chasm at a=1.89 with a
  surviving outer ringlet beyond it, sharp narrow 3:1 notch at 1.442, 7:3 dip, 4:1 family
  spike, ~dozen visible Hirayama-style family towers, moon-truncated edges.
- `beltsim validate runs/default`: ALL PASS — gap notch/flank 2:1 = 0.258, 3:1 = 0.608
  (young gap at 1540 perturber orbits; metric measures the notch at its own ~0.4% width,
  thresholds documented in validate.py), power-law slope −2.523 vs target −2.5, family
  a-dispersion 0.048× Poisson over 100 families.
- Bake: 3.20 MB compressed total (density 2.66 MB at 1024×1024×8, heroes 457 KB ×30k,
  flow 82 KB, zones 39 B, meta 847 B). **Tile-pyramid decision: NOT taken** — the whole
  artifact is one cached ~3 MB fetch, far below the threshold where slippy-map tiles pay
  for their complexity. Revisit only if bake resolution grows ~10×.
- Zone detection reworked to 3 levels (dense band / sparse fringe / void) — eccentricity
  smears a-space gaps in physical radius, so radial pockets are band/fringe/void and the
  azimuthal richness lives in the 2D density.
- Shipped to public/belt/default. Server boots with totalAsteroids ≈ 134.1M.
- Gates on the shipped bake: bun run verify 140/140; verify:gpu ALL PASS;
  verify:gpu-live:prod PASS (frames p95 16.7 ms, 60.1 fps; scan gate; shadow gate floors
  made RELATIVE to measured baselineLit — belt band ≈ 7.4k lit samples vs legacy ≈ 15.5k,
  tiers alive at 0.22/0.13 ratios, all-dark upper bounds retained); bench:gpu-cross:prod
  median 16.7 / p99 16.8 / max 33.2 ms, over33 = 0 over 9 crossings, derive ≈ 7.5 ms.
- Captures (screenshots/): belt-default-{close,region,belt}.png at 1920×1080 vs
  belt-hash-baseline-\*.png. Visual verdict: the hash field is an unstructured uniform
  soup at every scale; the belt shows family clumps and arcs at belt scale, band/lane
  structure + far-field granularity at region scale, and varied rock sizes incl. ~2 km
  heroes at close scale. The failure mode the design conversation feared (formulaic
  noise) is visibly absent.

- Family-shear observation (1M run): even the youngest family (injected 40 orbits before
  the final epoch) shears into a ~270° arc; azimuthal point-clumps are short-lived at
  these orbital frequencies, so the lasting family signature is overlapping rings/arcs of
  varying thickness + element-space tightness (0.048× Poisson). If future tuning wants
  discrete blob-clumps, push `inject_window[1]` to ~0.9995 and drop `dv_over_vorb_min`
  (sim re-run required) — or accept that arcs ARE the physical answer.

## Session 1 — alternate preset + final report

- `shepherd-moat` preset ran end-to-end in the background (400k particles, 8000 orbits,
  ~35 min): the embedded shepherd at a=1.45 splits the belt into THREE separated rings —
  a structurally different belt from the same pipeline. Validation ALL PASS (3:1/5:2 read
  0.0 = fully carved inside the moat; validator now treats an empty flank as maximal
  depletion, not missing data). Bake 2.1 MB, shipped to public/belt/shepherd-moat/,
  selected at runtime via HAYSTACK_BELT_PRESET=shepherd-moat, captured in-client
  (screenshots/belt-shepherd-moat-clean.png vs belt-default-belt-clean.png).
- viewPos debug control added (render-stats/renderStore/EveApp) so capture scripts frame
  any scale without flying; scripts/bench/belt-captures.mjs is the reusable harness.
- Ops note: two dev servers sharing data/haystack.sqlite deadlock ("database is locked")
  — capture/benchmark servers must take HAYSTACK_DB=<own file>.

### Completion criteria — evidence index

1. Sim/bake app: beltsim/ (README, pinned uv deps, `uv run beltsim all <preset>`); gaps +
   families: runs/default/plots/\* + validation.json (this log, "1M default run results").
2. Tuning: presets/\*.json knobs, README "Knobs and what they cost" stage map; alternate
   preset shepherd-moat generated end-to-end and shipped.
3. Artifacts committed: public/belt/default (3.2 MB) + public/belt/shepherd-moat
   (2.1 MB); regeneration: `uv run beltsim all presets/<p>.json` + copy (README).
4. Runtime from bake on both sides, bit-identical: src/shared/belt/ +
   tests/integration/belt-parity.test.ts; all gates: bun run verify 140/140, verify:gpu
   ALL PASS (incl. belt device round-trip), collision/ring-stream/cull/binner/collide
   parity suites green.
5. Perf: bench:gpu-cross:prod median 16.7 / p99 16.8 / over33 = 0; verify:gpu-live:prod
   PASS at 60.1 fps (shadow-gate floors relativized to baselineLit, justification in
   scripts/bench/gpu-live-loop.mjs + this log).
6. Captures (1920×1080, real client): screenshots/belt-default-{close,region,belt}.png,
   belt-default-belt-clean.png, belt-shepherd-moat-clean.png vs
   belt-hash-baseline-{close,region,belt}.png; visual verdict recorded above.
7. Deferred (explicit): far-field flow-field animation (artifact shipped, consumer is
   future cosmetic drift); deeper 3:1 via longer re-sim (knob documented); GIF flythrough.

## Session 1 — post-ship fixes (user-reported)

- Stale-cache split-brain: browser served the cached smoke `density.bin.gz` against the
  fresh 1M `belt-meta.json`; the decode length guard threw and the client derived zero
  rocks. Fix: content-addressed `bakeId` (sha1 of binaries) in belt-meta.json, meta
  fetched cache-bypassed, binaries fetched with `?v=<bakeId>`.
- Spawn-in-planet: the user's dev DB predated the belt (seeded at old coordinates) —
  reset (backup at data/haystack.sqlite.pre-belt-backup). Separately, `ShipActor.reset`
  hardcoded the origin (now the planet core); recenter now targets `stationSpawn`
  (exported from world.ts; sim.ts imports it).
- "All asteroids look the same size": background radii were uniform 45–355 m. Now
  truncated power law N(>r) ∝ r⁻² over [55, 355] m (same noise channel, positions
  unchanged): median 78 m, ~2.5% at the cap, heroes above. Shadow-gate floors moved to
  NOISE-RELATIVE thresholds (live tiers measure 3.6–4.7×/2.1–2.9× the identical-state
  noise floor; dead ≈ 1×) — fraction-of-baseLit floors assumed a size distribution and
  broke twice. All gates re-green (verify 140/140, verify:gpu-live:prod PASS).

## Session 2 — 2026-06-10 — Saturn-scale belt (structure + real planetary scale)

Contract: `prompt-saturn-belt.md`. Worktree `saturn-belt/impl`.

### Scale derivation (everything follows from this)

a=1 (sim) → 74,500 km = the C-ring inner edge ⇒ `worldScale = 7.45e7`. Planet radius
60,268 km ⇒ 0.809 normalized. Ring map in sim units: C 1.000–1.235, B 1.235–1.577,
Cassini division 1.577–1.642, A 1.642–1.836, Encke 1.793. Carried by a new optional
`world` block in belt-meta.json (`bake.world_scale`/`bake.planet_radius` preset knobs);
the shared decoder prefers it over the legacy BELT_WORLD_SCALE so the scale cannot
split-brain across server/client/tests.

### Thread A — what each lever did (smoke runs, 60k × 3000–12000 orbits, ~1–4 min each)

- Resonance ladder, computed before any run: a mimas-analogue at a=2.556 puts its 2:1 at
  1.610 (mid-Cassini), 3:1 at 1.229 (C/B boundary) and 5:3 at 1.818 (A-ring fine
  structure) — the same multi-resonance double-duty real Mimas does. korr at 0.63 puts
  its exterior 1:2 exactly at the belt inner edge (1.000).
- **Cold disk is the whole ballgame**: e_sigma 0.03→0.0015, inc_sigma 0.015→0.00075
  (20× colder than default). Edges sharpen to single bake-bins, embedded-moonlet lanes
  become possible, the disk becomes a thin sheet.
- **Mimas mass/e tuning is a knife-edge** (iters 1–4): m=1.2e-3 e=0.03 ate everything
  beyond a=1.72 (the first-order ladder 9:5/7:4/5:3 pumped the entire outer region into
  the cull band). e→0.01 saved the A region (forced eccentricity ∝ e_moon); m→1.5e-3
  e=0.005 blew the 2:1 division open to 0.135 wide (≈2× real Cassini); the bisected
  m=1.05e-3 e=0.005 lands the division at ≈0.045 and leaves the outer bands alive.
- **Embedded moonlets carve honest gaps in a cold disk**: weir (5e-10, a=1.225) cuts a
  clean narrow C/B lane; pan's gap is wider than naive crossing-width (repeated
  conjunctions pump e diffusively in a collisionless disk — no damping to balance), so
  Encke-narrow needs ~1e-10 at most. A moonlet inside a region mimas already erodes
  just merges into the bigger gap — placement must respect the mimas ladder.
- **Time scaling measured** (iter4 3k vs iter5 12k orbits, same preset): structure is
  STABLE — gaps deepen and sharpen rather than widen catastrophically. Production at
  12k orbits is therefore predictable from 3k smokes.
- Families in a cold disk shear into bright thin ringlets (very Saturn); 8 events at
  60k particles produced towers that dominate the bake's 99.9-pct normalization —
  production uses count=60 / fraction=0.10 to spread them.

### Thread B — the scale migration (committed b8051bc, 260c434)

- **Cell keys**: single base 8192 overflows 2^53 at cellsXZ≈264k. Repacked with
  asymmetric bases (xz 2^19, y 2^11; worst key < 2^49, exact in f64). Guards updated.
- **GPU f32 fix — the floating field anchor** (`gpu/anchor.ts`): base/pos buffers,
  originMeters, collision gridOrigin and well uniforms are all ANCHOR-RELATIVE; the
  anchor is a 2^16-m-grid point near the ship, re-snapped when the origin strays >98 km
  (full ring rewrite in one merged sub-range upload, ~50k slots, ms-scale). f64
  subtraction happens CPU-side before f32 narrowing. Kills the three Saturn-scale
  pathologies: ~16 m rock quantization, ~8 m whole-field shimmer from origin-uniform
  rounding, wobble/drift animation vanishing below the f32 ULP. Legacy behavior is
  byte-identical while the anchor is {0,0,0}, so all pre-existing parity gates pass
  unchanged; a far-from-origin suite (belt-parity.test.ts) pins the rebased image to
  <2 cm of f64 truth at 1.4e8 m.
- **Seeded layout scales in-plane** by worldScale/1e6 (station-kestrel → a=1.2656 =
  94,287 km, B-ring band; pockets/relay/hab likewise); vertical offsets and docking
  distances stay metric. ShipActor reset/recenter follows via stationSpawn.
- **Far field**: planet radius from meta.world.planetRadius (0.809 ⇒ 60,268 km).
- **Boot-proven at saturn-smoke scale**: grid 263,718×792, station spawn zone=band,
  200-rock derive at spawn 2.9 ms, live prod client 60 fps (p95 16.7 ms) with 8.4e11
  rocks indexed. verify 146/146, verify:gpu ALL PASS.
- **Shadow gate recalibrated** (scripts/bench/gpu-live-loop.mjs): pristine origin/main
  fails the old absolute floors in today's environment (lit-pixel counts halved, ratios
  unchanged at 0.22/0.13) — floors re-anchored to current default-bake measurements,
  ratio invariants untouched. Default PASSES post-recalibration.
- Gotcha: `beltsim bake` reads knobs from the sim-meta PRESET ECHO, not the preset
  file — bake-stage knob edits after a sim run require patching runs/<p>/sim-meta.json
  (or re-simulating). Bit me adding world_scale; documented here for the next belt.

### Production run + ship (same session)

- **Sim**: `presets/saturn.json`, 3,000,000 particles × 12,000 orbits, 8 shards under
  caffeinate, **17,052 s wall (4.74 h — inside the ≤6 h budget)**. 2,465,590 alive /
  534,411 removed. Early ETA scare: Chrome verify-gates running concurrently stole ~2
  cores and pushed the projection toward 6 h; after freeing the machine it settled at
  4.7 h. Lesson: don't run browser harnesses during a production sim.
- **Structure matches the smoke prediction** (sharpened, not changed — the contract's
  test): C ring with ringlet texture 1.0–1.22, weir lane 1.225, B ring with dozens of
  family ringlets, Cassini division 1.585–1.62, A ring 1.62–1.73, pan gap ~1.74–1.79,
  F-ring-like ringlet 1.79–1.815, 5:3 notch 1.818, outer band 1.82–1.86.
  `beltsim validate` ALL PASS: 2:1 and 3:1 notch/flank = 0.0 (fully carved), size slope
  −2.504 vs −2.5 target, 60/60 families measured at 0.014× Poisson a-tightness.
- **Bake**: 3.36 MB compressed (density 2.85 MB at 2048×512×8 over r∈[0.9,1.95] —
  38 km radial bins; heroes 441 KB ×30k; flow 66 KB). Shipped to `public/belt/saturn/`
  (bakeId 9c4bae8c950d); the superseded `saturn-smoke` spike artifacts removed from
  public/. Runtime indexes ≈ 1.33e12 virtual rocks at worldScale 7.45e7.
- **Gates**: `bun run verify` 146/146 (saturn far-from-origin parity now pins the
  production bake — 30k hero cell keys round-trip the 264k-cell grid); `verify:gpu`
  ALL PASS on device; `verify:gpu-live:prod` PASS on BOTH saturn (60 fps p95 16.7 ms,
  SCAN pass, shadow tiers 5.7×/3.5× noise) and default (60.1 fps, tiers 4.1×/2.5×).
- **Shadow gate, second recalibration (structural)**: at Saturn scale the down-sun test
  frame contains the PLANET — a huge lit surface rock shadows can never darken — so
  baselineLit quadruples (10.4k vs 2.6k) while tier counts stay constant, and any
  tier/baselineLit ratio floor is scene-dependent. Floors are now noise-relative only
  (2.5×/2.0× the identical-state noise; dead tier ≈ 1×); the all-dark UPPER bounds and
  blend checks stay ratio-based (a black wall darkens everything regardless of scene).
- **Camera far plane** 20,000 → 500,000 scene units: at Saturn scale the whole far
  field (planet up to ~205,000 km, opposite ring edge ~290,000 km) sat beyond the old
  frustum and rendered black. Free precision-wise (depth error is near-plane-dominated).
- **Harness ops learned the hard way**: ZOMBIE servers are the dominant failure mode —
  a leftover `bun src/server/main.ts` on the gate's port (8811) or capture port (8807)
  silently serves a stale preset/db to every later run (symptom: client derives only the
  ~30 db-seeded rocks because the published preset's artifacts are gone from dist, or a
  capture shows legacy coordinates). `lsof -iTCP:<port> -sTCP:LISTEN` before every
  harness run. Also: hv's dev vite on localhost:5173 shadows a capture vite on the same
  port (bind 127.0.0.1:5273 instead), and the windows-closed layout (2e43cf2) means the
  first visible `input` is the audio slider — harnesses must target
  `input[type="text"]` (the app auto-onboards anyway).
- **In-game captures** (screenshots/belt-saturn-{close,gap-edge,planet,rings}.png,
  1920×1080, clean windows-closed UI): inside the B ring the cold disk reads as a
  razor-thin ring plane crossing the whole sky; the planet fills the frame from the
  C-ring inner edge; the face-on far-field shows the full ring system with divisions.
- **Still open at session end**: hv's call on traversal (options DMed: dynamic cruise
  scaling / warp-to-zone / time compression; recommended start = warp-to-zone) and hv's
  in-game look approval before `saturn` is promoted to the default preset (it ships
  runtime-selectable via `HAYSTACK_BELT_PRESET=saturn`).
