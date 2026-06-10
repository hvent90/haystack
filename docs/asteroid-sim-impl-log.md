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
