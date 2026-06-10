# beltsim — Haystack belt pipeline (sim → bake → runtime artifacts)

Physically-grounded asteroid belt generation. An N-body simulation (REBOUND, WHFast
symplectic integrator) produces the belt's large-scale structure — resonance gaps carved by
moons, collisional families shearing into arcs, moon-truncated edges — and the bake step
compresses that structure into small binary artifacts the Haystack runtime samples
deterministically. Fine detail (individual small rocks) is generated at runtime by seeded
hashing _below_ the bake's resolution; the bake is the single source of macro-structure.

This is a permanent tool, not a one-off script: belt tuning is gameplay tuning, and the
pipeline is designed to be re-run.

## Commands

All commands run from `beltsim/` with [uv](https://docs.astral.sh/uv/) (deps are pinned in
`uv.lock`; `uv sync` installs them):

```sh
uv run beltsim simulate presets/default.json   # N-body sim -> runs/default/particles.npz
uv run beltsim plots    runs/default           # diagnostic plots -> runs/default/plots/
uv run beltsim bake     runs/default           # runtime artifacts -> runs/default/bake/
uv run beltsim validate runs/default           # statistical gates -> runs/default/validation.json
uv run beltsim all      presets/default.json   # end-to-end regeneration, one command

Shipping a bake: copy `runs/<preset>/bake/{belt-meta.json,*.bin.gz}` into the repo's
`public/belt/<preset>/` (the server reads it from disk, vite serves the same files to the
client) and run `bun run verify` — the belt parity suite re-derives against the new
artifacts.
```

`simulate` shards test particles across CPU cores (`--shards N` to override). The default
1M-particle, 8000-orbit run takes on the order of an hour on an M-series laptop; use
`presets/smoke.json` (30k particles, ~1 min) for fast iteration on knobs.

## The model

Normalized units: G = 1, planet mass = 1, belt inner edge at a ≈ 1 (period 2π). Mapping to
world meters happens in the runtime, not here.

- **Moons** are massive perturbers. The default preset's outer moon (`veil`, a=3.0) places
  its 4:1 / 3:1 / 5:2 / 7:3 interior resonances inside the belt and truncates the outer edge
  at its 2:1 (a≈1.89) — the same anatomy Jupiter gives the real main belt (our 3:1 sits at
  the same geometric ratio, 0.48·a_moon). The inner moon (`korr`) erodes the belt's inner
  edge via its exterior 1:2 resonance.
- **Families**: parent-breakup events pick a random surviving rock at a random time inside
  `inject_window` and inject a debris cloud with correlated velocities. Keplerian shear then
  stretches each cloud; by the final epoch old families are rings/arcs in space (but stay
  tight in element space, like real Hirayama families) and young ones are visible clumps.
- **Removal** (what actually empties the gaps): a particle is culled only when its orbit has
  _evolved_ into a terminal state — e pumped past `e_max`, radial excursion crossing a
  moon's orbit within ~2.5 Hill radii, or leaving `r_bounds`. No region is cleared a priori.

A note from tuning: do not put a massive embedded shepherd moon in a dynamically hot belt
(e ~ 0.05) unless you _want_ a huge moat — radial overlap with the moon's crossing band
scales with a·e, so the carved lane is ~10× wider than the moon's Hill sphere. The
`shepherd-moat` alternate preset uses this deliberately; the default belt gets its gaps from
resonances instead.

## Bake artifacts (`runs/<preset>/bake/`)

| file             | contents                                                                          | runtime consumer                                                |
| ---------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `heroes.bin.gz`  | top-N largest bodies, literal positions: f32 x,y,z,d + i16 family (20B records)   | hero asteroid placement (server + client, byte-identical reads) |
| `density.bin.gz` | polar grid `[r][theta][z]`, uint8, lightly smoothed counts of all non-hero bodies | per-cell rock-count sampling + far-field rendering              |
| `flow.bin.gz`    | coarse `[r][theta]` mean-velocity field: int8 unit dir + encoded speed            | debris shear orientation                                        |
| `zones.bin.gz`   | per-r-bin zone id (0 void / odd band / even gap) from the radial profile          | bake-driven pocket zones                                        |
| `belt-meta.json` | dims, scales, format version, moon configuration                                  | everything (header)                                             |

Total compressed size must stay single-digit MB (the default-resolution bake is ~3–5 MB;
check the `bake` command's size printout).

## Knobs and what they cost

All knobs live in one preset JSON. The expensive stage is `simulate`; everything below it is
seconds.

| knob                                | meaning                                    | requires re-running                    |
| ----------------------------------- | ------------------------------------------ | -------------------------------------- |
| `moons[*].a/.mass/.e`               | gap positions, gap widths, edge truncation | **simulate** (structural)              |
| `belt.n_particles`                  | statistical depth of the bake              | **simulate**                           |
| `belt.a_min/a_max`                  | belt span                                  | **simulate**                           |
| `belt.e_sigma/inc_sigma`            | dynamical temperature / vertical thickness | **simulate**                           |
| `families.count/particle_fraction`  | number & richness of clump features        | **simulate**                           |
| `families.dv_*`, `inject_window`    | family tightness / shear-age spectrum      | **simulate**                           |
| `integration.n_orbits`              | gap depth & sharpness                      | **simulate**                           |
| `bake.nr/ntheta/nz`                 | density-field resolution                   | **bake** only                          |
| `bake.hero_count`                   | how many literal landmark rocks            | **bake** only                          |
| `bake.size_slope/size_d_*`          | power-law size distribution                | **bake** only                          |
| `bake.density_scale`                | global density multiplier                  | **bake** only (also a runtime uniform) |
| `bake.r_min/r_max/z_max`            | baked spatial extent                       | **bake** only                          |
| pocket thresholds / mineral weights | gameplay assignment                        | **runtime** config, no re-bake         |

Presets: `default.json` (the shipped belt), `smoke.json` (fast iteration),
`shepherd-moat.json` (alternate tuning proof: an embedded shepherd splits the belt into two
rings separated by a wide moat — run it end-to-end with `uv run beltsim all
presets/shepherd-moat.json`).

## Validation

`plots` renders: the a-histogram with resonance markers (Kirkwood gaps must be visible at
the marked lines), face-on/edge-on density, e-vs-a (pumping chimneys at resonances), and
family panels. The bake step writes its own previews under `runs/<preset>/bake/previews/`
showing exactly what got baked. Statistical gates live in the repo's integration tests once
artifacts are committed; see `docs/asteroid-sim-impl-log.md` for the running record.
