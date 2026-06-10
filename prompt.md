# Goal: Physically-Grounded Asteroid Belt Generation (Sim → Bake → Runtime)

Build an asteroid belt generation pipeline whose large-scale structure comes from a real
physics simulation and whose fine detail is generated deterministically at runtime, then
integrate it as the source of Haystack's asteroid field. The end state: flying through the
belt feels like flying through something that formed naturally — resonance gaps, collisional
families, arcs, voids, and clumps — not through layered noise, and the whole thing ships in a
few megabytes.

## Source Of Truth

This file is the contract for this `/goal` loop. Re-read it before each implementation pass.
`context.md` in the repo root contains the design conversation that motivated this work —
read it first; it explains the reasoning behind every phase below and the failure mode to
avoid.

## Why This Exists

Haystack's current field (`src/server/field.ts` → `src/client/eve/field-core.ts`) is a
seeded hash: every cell rolls position/radius/minerals from `frac(sin(...))`. It scales
beautifully but its structure is statistical texture all the way down — no belt-scale
identity. The game's core loop is needle-in-a-haystack search across orders of magnitude, so
the belt's macro-structure (where it's dense, where it's empty, where the families clump) IS
the gameplay terrain. A physics sim produces that structure for free: moons carve resonance
gaps (Kirkwood-style), breakup families shear into arcs, density varies in ways noise
octaves can't fake.

The central risk, stated in `context.md`: summary statistics throw away phase information,
and phase is where the interesting stuff lives. So the contract is — **keep the sim's actual
output at low frequency (baked density/velocity fields, hero asteroids), go procedural only
at high frequency** (individual small rocks below the bake's resolution). Do not replace the
bake with fitted noise parameters; that reintroduces the formulaic look this project exists
to kill.

## What To Build

### Phase 1 — Offline simulation (run once, tooling)

- N-body sim around a gas giant: 2–4 massive moons as perturbers, on the order of 1–10M
  massless test particles, integrated long enough for resonance gaps, shepherded ringlets,
  and spiral wakes to emerge (10³–10⁴ orbits with a symplectic integrator).
- Seed collisional families: ~100 parent-breakup events injecting debris clouds with
  correlated velocities, allowed to shear out over sim time. This is where unique clumpy
  geometry comes from.
- The sim is offline tooling, not app code: pick whatever gets a trustworthy result fastest
  (REBOUND via Python is the known off-the-shelf path; a custom TS/WebGPU integrator is
  acceptable if you verify it against known belt behavior). The app itself stays
  TypeScript-only; the sim/bake application's language is your call.
- The sim + bake application is a permanent first-class part of the repo, not a throwaway
  script: give it its own dedicated top-level folder (e.g. `beltsim/`) with its own README,
  pinned dependencies, and documented commands. We will re-run it repeatedly to tune the
  belt, so treat it like a tool we keep, not a one-off.
- Real-belt data (MPCORB / AstDyS, per `context.md`) is available as ground truth for
  validating that the sim's gaps, power-law size distribution, and family clustering look
  right. Use it as a reference check, not necessarily as the source field.

### Phase 2 — Bake (compress without losing the chaos)

- Hero asteroids: store the top tens of thousands of largest bodies as literal
  positions/elements. They are few (power law) and carry the belt's visual identity.
- Density field: bake the remaining millions into a quasi-2D polar map (radius × azimuth ×
  small vertical extent — something like 1024×1024×8). This preserves the sim's actual
  clumps, arcs, and gaps.
- If the density field is baked to image-like tiles, consider serving it through a quadtree
  tile pyramid (the slippy-map pattern): clients fetch small high-resolution tiles around
  their current position and coarse tiles for distant regions, instead of downloading the
  full-resolution field up front. The full bake stays server-side; what goes over the wire
  scales with where the player actually is. Decide based on measured tile sizes and fetch
  cost, and record the decision in the impl log.
- This implies two distinct consumers of the density data, with different requirements:
  - **Local derivation bubble** (the `renderedLimit` real rocks around the ship): cells here
    must derive from the same tile data the server uses, at full resolution, so server/client
    parity holds. This bubble is small, so it never needs more than a handful of full-res
    tiles.
  - **Far-field view**: the player can look across the belt and should see its structure —
    bands, gaps, clumps — millions of km out, where no individual rocks are derived. Coarse
    tiles are exactly the right input for this; render it with whatever modern distant-field
    technique fits (impostors, point-cloud sprites, volumetric/billboard density haze — your
    call, this is an invitation to use state-of-the-art tricks). It's purely visual, reads
    no gameplay state, and needs no parity with anything.
- Velocity/orientation field: per-region flow direction so debris shears plausibly.
- Total baked artifact budget: single-digit megabytes compressed, committed to the repo with
  a documented regeneration path.

### Tunability — this is a gameplay tool, not just a renderer

The belt's density, gap widths, family tightness, and vertical thickness are gameplay
levers: they set how hard it is to hide, find, and navigate. Design the pipeline so we can
tune them without re-deriving everything from scratch:

- Expose the knobs that matter as named parameters in one config file in the sim/bake
  folder: moon configuration (masses/orbits → gap positions and widths), particle counts,
  family count/spread, overall density scale, ring band radii/thickness, vertical scale
  height.
- Cheap knobs should be cheap: global density scaling, mineral weighting, and pocket
  thresholds should be adjustable at bake time (or runtime) without re-running the N-body
  sim. Only structural changes (moving gaps, new families) should require a re-sim.
- Document in the sim README which knob changes require which pipeline stage to re-run, and
  keep end-to-end regeneration a single command so tuning iterations stay fast.
- Ship at least one alternate tuning preset alongside the default to prove the pipeline is
  actually re-runnable (the design conversation suggests multiple moon configs as a cheap
  diversity lever).

### Phase 3 — Runtime generation (replace the current field's structure source)

- Keep the existing architecture's load-bearing invariants; this phase changes WHERE
  structure comes from, not how it's queried or rendered:
  - Deterministic per-cell derivation: same cell + seed → same rocks, on both server
    (`src/server/field.ts`) and client (`src/client/eve/field-core.ts` worker derive), with
    the existing f64-CPU-derive → GPU-upload determinism rule intact (the GPU never
    regenerates `base`; see `docs/gpu-asteroids-architecture.md` §3.2).
  - Stable ids (`v-cx-cy-cz` or a successor), O(rendered) queries, `renderedLimit`
    streaming, fingerprint-based change detection.
- New hierarchy per the design: hero asteroids (from the bake) → procedural families
  clustered around a fraction of them with bake-driven shear → background small rocks whose
  per-cell density is sampled from the baked density field, placed with hash jitter.
- The current pocket zones (`inner-drift` / `black-thread` / `long-echo`) and mineral
  assignment must survive in some form — gameplay keys off them — but their spatial
  definition may (should) become bake-driven rather than coordinate-band hardcoded.

### Phase 4 — Validate (the failure mode is visible to the eye, not to a metric)

- Statistical checks: radial density histogram shows the sim's gaps; size distribution
  follows the power law; family clustering measurably tighter than Poisson.
- Visual checks: scripted flythrough paths rendered through the real client, screenshots
  (≥1080p) captured at belt scale, region scale, and close scale. Produce a side-by-side
  against the current hash field as the "pure noise baseline" the design conversation calls
  for, and write up what's visibly different.
- All existing gates stay green: `bun run verify`, `bun run verify:gpu`, the GPU parity
  suites (`tests/integration/gpu-base-parity`, ring-stream, cull/binner/collide parity), and
  `bench:gpu-cross:prod` perf numbers comparable to current main.

## Constraints

- Runtime/app code: TypeScript, strict, Bun, formatted with `oxfmt` — same standards as the
  repo. Offline sim tooling is exempt from the TypeScript-only rule but must be reproducible
  (pinned deps, documented invocation).
- Server stays authoritative and the server/client derive must stay bit-identical; any
  change to derivation math lands on both sides in the same pass with a parity test proving
  it.
- Don't break scale: the field must still plausibly support millions of virtual rocks
  without eager materialization. The bake adds a lookup, not a list.
- Don't add features beyond this contract — no new gameplay systems, no refactors of
  adjacent code that the pipeline doesn't require.

## Working Rules

- You are operating autonomously. For reversible actions that follow from this contract,
  proceed without asking. Pause only for destructive actions, real scope changes, or input
  only the user can provide — and if you hit one, ask and end the turn rather than ending on
  a promise.
- Start by auditing `src/server/field.ts`, `src/client/eve/field-core.ts`,
  `docs/gpu-asteroids-architecture.md`, and the existing parity tests so the integration
  surface is understood before sim work begins.
- Work in scoped, verifiable passes. After each meaningful slice run typecheck, format, and
  the relevant test subset. Use fresh-context verifier subagents to check completed phases
  against this contract rather than relying on self-review.
- Before reporting progress, audit each claim against a tool result from this session. Only
  report work you can point to evidence for; if something is not yet verified, say so
  explicitly. If tests fail, say so with the output.
- DM the user screenshots on Discord (use the `discord-dm` skill) regularly as visual
  progress lands — sim output plots, the first rendered bake, the first in-client belt,
  flythrough captures, before/after tuning comparisons. This is a visual project and the
  user wants to watch it take shape without sitting at the terminal; a short caption saying
  what they're looking at is enough. Don't wait for a phase to be "done" to share.
- Keep an implementation log (e.g. `docs/asteroid-sim-impl-log.md`) recording decisions,
  measured results, and anything the next session needs — sim parameters chosen, bake
  resolutions tried, what looked wrong and why.
- If a phase is too large for one pass, ship the smallest real vertical slice that proves
  the pipeline end to end (e.g. a low-particle-count sim → tiny bake → one belt region
  rendered) before scaling up.

## Completion Criteria

Do not call the goal complete until all of the following are true, with evidence:

- The sim/bake application lives in its own permanent repo folder with a README, runs from a
  documented command, and its output demonstrably shows resonance gaps and
  collisional-family clustering (plots or measured histograms in the impl log).
- The tuning config exists with documented knobs, the README maps each knob to the pipeline
  stage it requires re-running, and at least one alternate preset has been generated
  end-to-end to prove the tuning loop works.
- Baked artifacts (heroes + density field + flow field) are committed, within the size
  budget, with a regeneration script.
- The runtime field derives its structure from the bake on both server and client, parity
  tests prove bit-identical derivation, and all pre-existing integration/GPU gates pass.
- Perf on `bench:gpu-cross:prod` and `verify:gpu-live:prod` is within tolerance of current
  main (no dropped-frame regressions from the bake lookup).
- Flythrough screenshots (≥1080p) at three scales are captured from the real client, with a
  baseline comparison against the current hash field, and the visual verdict is recorded in
  the impl log.
- The final report lists commands run, artifact sizes, screenshot paths, and any
  intentionally deferred work — without hiding missing criteria.
