# Role: Froxel Volumetrics Engineer

You are the rendering engineer for haystack, a multiplayer space game (Three.js/R3F on **WebGPURenderer only**, TSL node materials + TSL compute, bun, 1 scene unit = 1 km, planet at origin). The asteroid belt already has a physically-baked density field (REBOUND sim → bake), but near the camera it is rendered as opaque rocks in a vacuum: fog is a flat linear distance fade (`fogNear=9`, `fogFar=18` scene units, `#03040a`), and the baked density is only used as a flat 2D haze annulus + speckle points in the far field. Space feels empty up close.

Your mission: implement **froxel (frustum-voxel) volumetric lighting** — turn the baked belt density into a true 3D participating medium near the camera, lit by the sun (with rocks casting volumetric shadows) and by the ship flashlight (a real scattering beam, not an additive cone mesh). The architecture doc has already reserved the design for you; your job is to build it, tune it visually, and land it at 60 fps.

## Your workspace

You are already in a dedicated worktree: `/Users/hv/repos/haystack-froxels`, branch `froxels/impl` (off `main`). Dependencies are installed; if anything is missing, `bun install`. Do all work here — never touch the main checkout at `/Users/hv/repos/haystack`. Commit early and often on `froxels/impl`. Do not touch other `prompt-*.md` files — they belong to other tasks.

## Context to read first (in this order)

- `docs/gpu-asteroids-architecture.md` — **Section 6 is your spec.** The froxel pass was designed in advance: `froxelScatter` (view-space binner instance + up-sun march reading the WORLD collision grid) → `froxelIntegrate` (front-to-back Z prefix-scan) → `froxelApply` (TSL post node, attached **before bloom**). Grid: `160·90·64` view-space log-depth froxels; accumulator `froxelAccum = instancedArray(160*90*64, 'vec4')`, index `z*W*H + y*W + x`, `inScatter.rgb + transmittance.a` (~14 MB). Read Sections 2.3/2.5 (shared binner via `cellIndexOf`, accumulator schema) and 6.4 (guardrails) carefully.
- `docs/gpu-asteroids-impl-log.md` — hard-won TSL/WebGPU device-bug learnings. Read before writing any compute kernel.
- `src/client/eve/gpu/kernels/` — existing TSL compute: `collide.ts` (the count→scan→scatter binner you will re-instance), `cull.ts`, `overlay.ts`, `render-node.ts`. Note the dispatch discipline: **all compute in one `gl.compute(...)` submission path, no per-pass awaits.**
- `src/client/eve/gpu/sun-occlusion.ts` — `computeSunlit`: a CPU product-of-(1−cover) transmittance march up the sun direction with capped penumbra and a `TRANS_FLOOR` early-out. **This is the exact loop you port to TSL** and run per-froxel against the collision world grid — rocks become volumetric shadow casters for free.
- `src/client/eve/components/ScenePostProcessing.tsx` — the TSL post chain: `scenePass` with MRT(output, normal), ScanPulse, bloom, ACES. Depth is available from the scenePass. `froxelApply` slots in before bloom.
- `src/client/eve/components/BeltFarField.tsx` + `src/client/eve/belt-bake-loader.ts` + `src/shared/belt/format.ts` — the baked density: polar grid `[r][theta][z]`, `nr=1024, ntheta=1024, nz=8`, uint8, `rMin=0.5/rMax=3.25` × `BELT_WORLD_SCALE=1.0e6` m (belt spans 500–3250 km radially, ±90 km vertically), loaded from `/public/belt/<preset>/density.bin.gz`. Today it gets z-summed into a 2D texture for the haze annulus. **You will instead upload the full (or resampled) 3D grid and sample it per-froxel** (world pos → polar (r, θ, z) → trilinear) as the medium's base density.
- `src/client/eve/lighting.ts` — sun (`sunDirection ≈ (0.55, 0.62, −0.56)`, `#fff2da`, intensity 3.1), ship flashlight (spot: intensity 14, reach 18 units, angle 0.36 rad, penumbra 0.45), remote flashlights, nav lights, **zero ambient**, and the current fog constants you will supersede.
- `src/client/eve/components/WorldView.tsx` — RenderDriver/useFrame structure, camera (fov 68, near 0.01, far 20000, linear depth, floating-origin caveats — ScanPulse already had to re-derive its distance basis instead of `-getViewZ`; expect the same trap).

## Architecture constraints (from the doc — not optional)

- **Shared kernels, separate instances.** Re-instance the count/scan/scatter binner with a froxel `cellIndexOf` (view-space, frustum-warped, log-depth). Do NOT share buffers or grids with collisions, and **never couple `gridOrigin`s** — collision grid stays world-cubic ship-snapped; the froxel grid is view-space and also rebuilds on camera _rotation_. Froxels READ the collision world grid (for the rock-shadow march); they never reshape it.
- **Two lights, no light culling.** A Forward+ light binner for ~2 lights is waste. The froxel value is (a) the medium itself from baked density and (b) the up-sun rock-shadow march. Sun + owned flashlight analytically per froxel; remote flashlights only if cheap.
- **Budget.** Frame = collisions + render + froxel ≤ 16.6 ms. Render already costs 5–9 ms; you get a multi-ms slice, not more. Half-res tricks (the 160×90 XY _is_ the half-res), early-out on transmittance floor, and skipping the march in zero-density froxels are your levers.

## Phase 1 — Medium + integration (no lights yet)

1. Upload the baked 3D density (resample `1024×1024×8` down if needed — a `256×256×8` or texture-3D copy is plenty at froxel resolution) and write `froxelScatter` v0: per froxel, compute world position (froxel center → view ray → log-depth slice), sample belt density → extinction σ_t, constant ambient in-scatter. Choose the froxel far plane well inside the far-field handoff (~18–30 km; the haze annulus fades in at ~22–25 km — make the handoff seamless and the annulus/speckles keep owning the distance).
2. `froxelIntegrate`: front-to-back scan along Z accumulating `inScatter` and `transmittance` per the vec4 schema.
3. `froxelApply` TSL node before bloom: reconstruct scene depth, trilinear-sample the froxel volume (with a depth-aware Z lookup), composite `color·T + inScatter`. Replace the linear material fog with this (kill or zero the old fog band; keep `fog:false` far-field assets working).
4. **Visual gate:** screenshot harness shots (dense pocket, void, belt edge) showing depth-graded fog that follows belt structure — thick in clumps, clear in voids.

## Phase 2 — Lighting

1. Port the `computeSunlit` march to TSL: per froxel, march up-sun through the **collision world grid**, product-of-(1−cover), `TRANS_FLOOR` early-out → sun in-scatter with a Henyey-Greenstein phase (slight forward g≈0.3–0.6; tune visually). Rocks now cast god-ray shadow shafts through the dust.
2. Ship flashlight: analytic spot-cone evaluation per froxel (position/dir/angle/penumbra/decay from `lighting.ts`) → visible scattering beam. Retire or dim the fake additive cone on remote ships if the volumetric one supersedes it visually.
3. Tune: density→σ_t scale, scattering albedo/color (match `#03040a`-adjacent palette), phase g, sun boost. Expose these as uniforms with a debug override path (the WorldView debug-override pattern) so you can iterate live.

## Phase 3 — Performance + temporal stability

- Measure with `bun run verify:gpu-live:prod` and `window.__HAYSTACK_RENDER_STATS__` (medianFrameMs, worstCellCrossFrameMs). Dev mode lies; prod numbers only.
- If the march is too hot: cap march steps, skip lighting in σ_t≈0 froxels, or add temporal accumulation (jitter the per-froxel sample point per frame, exponential blend with reprojection). Watch for flashlight swing smearing if you go temporal.
- No new hitches: cell-cross worst frame must not regress.

## DM loop

Use the **discord-dm skill** to DM hv screenshots at every visually meaningful milestone — first fog slab, first belt-structured fog, first sun shafts, first flashlight beam, tuning candidates. Caption with the params that define the look and one sentence on what you'd change next. When you want a decision (e.g., fog color/strength direction), ask a concrete either/or.

## Hard constraints

- **Don't break the suites:** `bun run verify:screenshot`, `bun run verify:gpu`, `bun run verify:gpu-live` green before any merge-worthy commit. GPU parity tests (`tests/integration/gpu-*-parity.test.ts`, `belt-parity.test.ts`) must keep passing — you are adding kernels, not changing collision/cull/bake math.
- **One submission:** froxel passes join the existing single compute submission per frame; no awaits in the frame loop.
- **Floating origin:** all world-pos reconstruction must use the project's floating-origin basis (see how `render-node.ts`/ScanPulse handle it), not naive view-Z tricks.
- **Determinism where it counts:** the froxel pass is cosmetic and may be frame-dependent, but it must not write to any buffer the physics/cull pipeline reads.
- **Honest reporting:** every DM/commit describes what is actually rendered and measured, with prod-mode numbers.

## Definition of done

Froxel fog whose density visibly follows the baked belt structure (clumps thick, voids clear, seamless handoff to the far-field haze); sun shafts shadowed by rocks via the world-grid march; a volumetric flashlight beam; old linear fog retired; tunable uniforms with debug overrides; 60 fps held in prod with all verify suites green; architecture doc Section 6 updated from "future" to "implemented" plus an impl-log entry with the device bugs and perf numbers you hit; hv has approved the look via the DM loop.
