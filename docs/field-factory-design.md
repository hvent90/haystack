# Asteroid Field Factory — design & learnings

Branch: `field-design/impl` (off `gpu-asteroids/impl`). Companion docs:
`gpu-asteroids-architecture.md` (rendering), `gpu-asteroids-impl-log.md`.

## What it is

A composable, deterministic generator for asteroids, clusters and belt-scale
structure, replacing the uniform one-rock-per-1.13km-cell scatter. Three pure
octaves, every level a function of `(seed, coords)` — the field stays virtual
and streamed, no global pass:

1. **Macro** (`MacroParams`, ~24 km wavelength): tri-linear value-noise fBm
   over world space, shaped by `voidThreshold` (true empty regions), `gamma`
   (contrast) and `floor` (everywhere-haze). Decides where the belt is thick,
   thin, or empty.
2. **Cluster** (`clusterCells` ≈ 3.4 km coarse grid): each coarse cell hashes
   to a cluster archetype or none. **Macro gates cluster _existence_, not
   intensity** — thick regions grow more fully-formed clusters, voids grow
   none. (Multiplying intensities instead left faint half-clusters everywhere
   and crisp ones nowhere — first thing visual iteration killed.)
3. **Rock** (per 1.13 km fine cell): 0–8 rocks (`maxRocksPerCell`), count =
   `macro·baseDensity + Σ archetype.countScale·intensity`, deterministic
   stochastic rounding. Per-rock: jitter → squeeze onto the dominant cluster's
   geometry, radius from the archetype's distribution, spin rate, gameplay
   scalars (signature, mineralRichness, rareMineral via per-archetype weights).

All randomness is integer hashing (`imul`/xor-shift mix) — bit-exact on every
JS engine, unlike the legacy `frac(sin)` noise. The old field survives as the
`legacy-uniform` preset, reproduced bit-for-bit (including its sin noise) for
A/B and as the default until a belt is approved.

## Files

| file                                                         | role                                                                                  |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `src/shared/field-factory.ts`                                | octaves, archetype geometry, queries (`rocksInCell`, `rocksInSphere`, `clustersNear`) |
| `src/shared/field-presets.ts`                                | data-driven archetypes + composed presets (solo-_ for debugging, belt-_)              |
| `src/cli/render-field-preview.ts` + `field-preview-entry.ts` | offline WebGPU preview harness (see below)                                            |
| `scripts/bench/parity-factory.ts`                            | server==client parity gate + legacy bit-exactness                                     |
| `scripts/bench/field-factory-stats.ts`                       | numeric density/mix smoke test                                                        |

## Archetypes (data, not code — `ArchetypeParams`)

- **pocket** — bimodal sizes: 180–360 m anchors (chance scales with
  intensity², so they sit at cores) + 18–70 m gravel halo.
- **filament** — rocks squeezed onto a line segment, tube ~150 m, λ ≈ 7–9 km.
- **sheet** — disc slab, ~120 m half-thickness, reads as veils at distance.
- **ring-arc** — 55% arc of a circle, soft angular ends, crisp 140 m tube.
- **drift** — sparse mid-size loners; the connective quiet tissue.
- **gravel-swarm** — 12–60 m rocks only, count×20; hazard/mining clouds.
- **cathedral** — ~1 lone 380–700 m megarock per cluster, near-static spin.

Composed presets: `belt-v1` (moody, quiet zones + landmarks), `belt-v2-dense`
(~2.5×, EVE-style spectacle), `belt-v3-planar` (sheets+arcs lead, cathedrals
sprinkled), `belt-v4-disk` (macro slab → classic flattened belt), and
**`belt-natural` — the shipped default**: hv's direction (2026-06-09) was that
pockets read as natural gravitational clumping while strings/rings/sheets look
too authored, so belt-natural is pocket 22% / gravel-swarm 8% / cathedral 3% /
drift 50% over macro voids, with a guaranteed home pocket at spawn
(`FieldPreset.home`). See screenshots/field/ history and the Discord DM thread.

## The preview harness (the sketchbook)

`bun src/cli/render-field-preview.ts --preset solo-filament` → contact sheet
(close/mid/wide zooms) in `screenshots/field/`, ~3–10 s round trip. Pattern
cloned from `render-thrusters.ts` (Bun.build → headless Chromium →
`window.renderFieldPreview()`), plus:

- **WebGPU needs a secure context.** `about:blank` has no `navigator.gpu` —
  serve the bundle from `127.0.0.1` (Bun.serve) or you silently get the WebGL
  fallback (which dies on >16 KB uniform blocks for instanced colors).
- Real Chrome (`CHROME_PATH`/auto-detected) gives a Metal adapter headless;
  bundled Playwright Chromium falls back to SwiftShader.
- Contact sheets frame on a real cluster center (`clustersNear`), camera
  perpendicular to the cluster axis (rings/sheets get ~35° tilt), key light
  from behind the camera, near-plane at 12% of cam distance to clip foreground
  blobs, `minWorldRadius ≈ dist·0.004` so distant rocks stay ≥ ~2 px.
- Color = archetype, brighter tint = anchor (role 2).

## Hard-won tuning learnings

- **Count-gate falloff must floor at one cell size.** A filament/sheet/ring
  thinner than the 1.13 km cell otherwise only lights up the rare cell whose
  _center_ lands inside the tube — the structure vanishes. Count with
  `max(3·thickness, cellSize)`, then placement squeezes rocks back onto the
  thin geometry. This single fix is what made thin archetypes readable.
- **Don't scale placement pull by local intensity** — rocks jittered outside
  the falloff see intensity 0 and never move. Sample a residual distance from
  the geometry directly (`scatterScale · u^1.4`), blend by `sharpness`.
- Archetype legibility needs all three: high enough linear density
  (filament countScale ≈ 18), tight thickness, and quiet surroundings.
- Lone megarocks (cathedral): aim `countScale · cells-in-influence ≈ 1`; at
  0.2+ you get a wall of moons, at 0.05 empty clusters.

## Live-game integration (behind `HAYSTACK_FIELD_PRESET`)

`FieldSummary.preset` rides the wire; server `field.ts` and client
`field-core.ts` both generate from the shared factory. Multi-rock cells:

- ids: `v-x-y-z` for in-cell index 0 (legacy-compatible), `v-x-y-z-i` for
  siblings. `PackedField` gains an `indices: Uint8Array` channel (worker
  transfer list updated).
- GPU `slotMeta.x` packs the in-cell index into its high 16 bits (cells < 2^16);
  legacy rocks pack identically to before, so `gpu-base-parity` bytes are
  unchanged with the default preset.
- `sun-occlusion.ts` no longer hardcodes the legacy generator: the march
  occludes against the ACTIVE preset's rocks via `configureSunOcclusion(field)`
  (called by the field worker and FieldDeriver), memoized per cell.

Gates: `scripts/bench/parity-factory.ts` (server==client fingerprints at 4
origins + legacy bit-exactness over 288 cells), `verify:screenshot`,
`verify:gpu`, `verify:gpu-live`, `verify:gpu-live:prod` — all PASS with
belt-natural as the shipped default (p95 16.7 ms, ~60 fps at the 50k budget;
the belt-natural prod run shows the same frame profile as legacy).

### Spawn-zone density & the gpu-live gate

Designed belts have quiet zones; the origin spawn can land in one. Two-part
resolution:

- **Gameplay**: `FieldPreset.home` forces a pocket in the coarse cell
  containing world origin (macro ignored), so spawn/reset always wakes up
  with scenery (~100 rocks, anchor + gravel halo within ~2 km).
- **Verification**: `verify:gpu-live` pins its server to
  `HAYSTACK_FIELD_PRESET=legacy-uniform`. Its SCAN/SHADOW pixel thresholds
  (tier1 ≈ 8k darkened samples, baseLit ≈ 15k) were calibrated against the
  uniform field's wall-of-rocks spawn view — no tasteful belt can satisfy
  them, and the gate's job is catching GPU-pipeline regressions, not judging
  field design. Env still overrides for A/B. A home pocket alone gets
  pulseTeal from 3 to ~double-digits, far below the legacy-calibrated bars.
