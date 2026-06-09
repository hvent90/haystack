# GPU-Resident Asteroid Field — Architecture

This document is the authoritative description of the WebGPU-resident asteroid field as it is built: one
`WebGPURenderer` + TSL-compute pipeline, the field is GPU-resident, inter-asteroid collisions are
first-class, and froxel volumetric lighting remains reachable.

**Date:** 2026-06-08
**Repo:** `/Users/hv/repos/haystack`

---

## 1. Architecture overview & invariants

### 1.1 The architecture

A single `WebGPURenderer` pipeline in which the asteroid field is **GPU-resident**: per-body state lives in
WebGPU storage buffers (`instancedArray`), mutated by TSL compute kernels, and read **zero-copy** by the
render material via `material.positionNode`. A capability check refuses to start on browsers without WebGPU;
there is no second rendering path.

This replaces the former CPU-side `deriveVirtualField → packField → unpackField → reconcileChunks →
per-chunk InstancedMesh` pipeline; the field is now GPU-resident.

Three end-state properties define the architecture:

1. **GPU-resident field.** A fixed-capacity ring of `MAX_RESIDENT` slots (default **50k**, headroom 256k)
   holds the bodies near the camera. The "1M" is a **global id-space** (`cellsPerAxis³ = 100³ = 1,000,000`,
   server-hard at `field.ts`) streamed *through* the ring as the camera moves — never co-resident. Per-body
   state is struct-of-arrays `vec4` storage buffers; each binding stays ≤16MB at 256k, legal under
   `maxStorageBufferBindingSize = 128MiB`.

2. **Inter-asteroid collisions are first-class.** A GPU broad phase (world-space uniform grid via atomic
   count → prefix-sum → scatter) plus a narrow phase (sphere pushout + restitution impulse, deferred-apply,
   substepped). They are *cosmetic-only* by construction (Section 4), which bounds how much they can "matter"
   without crossing into server-authoritative netcode. What *makes* collisions happen at the field's native
   ~1-rock-per-1130 m density (where rocks essentially never overlap) is **manufactured local density**:
   sparse gravity wells (Section 4.3) and authored dense belts.

3. **Froxel volumetric lighting stays reachable.** The TSL post substrate (Section 5), MRT normal+depth,
   readable depth, the `vec4`-SoA accumulator convention, and the shared count→scan→scatter binner all exist
   for independently-required reasons (the WebGPU renderer and first-class collisions) and are exactly what a
   froxel pass needs. The froxel prerequisites fall out of the architecture at near-zero added cost
   (Section 6).

### 1.2 The two load-bearing guarantees

- **Gameplay is id-keyed, not position-on-wire.** Scan targets and mine requests carry only the
  `v-cx-cy-cz` string id (`MineRequest = {asteroidId, depositId}`, `shared/types.ts`). The server
  *independently re-derives the STATIC noise base position* from that id (`field.ts` `virtualAsteroidAt`,
  `virtualScanHits`; `sim.ts` `mineDeposit`) and validates against its own DB row (slack `radius + 1400`).
  **Client GPU motion physically cannot desync gameplay STATE** — gameplay reads `base`; only the renderer
  reads `pos`. This is enforced by the data path, not by convention.

- **The static field streams at ~0 wire bytes/tick** via the cell-stable `ASTEROIDS_FINGERPRINT`
  (`sim.ts`). The cosmetic GPU motion of the bulk adds **nothing** to the wire. This free-ride exists *only
  because the authoritative field is static*; it is a property of the (gated) promotion tier (Section 4.5)
  that promoting moving rocks collapses it back to per-tick serialization.

### 1.3 Per-frame data flow

```
mutate uniforms (dt, originMeters, viewProj, gridOrigin, frameCounter)
  │
  ├─ on cell-cross: genFieldOverlay re-seed crossed ring slabs   (overlay only; base uploaded — see §3.2)
  ├─ integrate/overlay step  (bounded wobble + quaternion spin + sparse K-well gravity)
  ├─ ── SHARED BINNER (count → scan → scatter), WORLD-SPACE instance ──  (collision broad phase)
  ├─ collision narrow phase  (27-cell deferred-apply pushout + impulse, 1–2 substeps)
  ├─ collision apply  (each lane writes only dp[i]/dv[i])
  ├─ GPU cull/LOD compaction → per-LOD IndirectStorageBufferAttribute
  │
  └─ render:
       scenePass + MRT(output, normal, [depth])
         → ScanPulse TSL node (samples MRT normal + depth)
         → [future] froxelApply node            ← attaches HERE, before bloom
         → bloom()
         → renderOutput() / ACES tonemap
```

The collision world grid is built **every frame before** the (future) froxel pass; froxels *read* the world
grid for volumetric rock shadows. Reading the grid does not reshape the collision grid to a frustum — the
two stay separate instances (Section 6).

---

## 2. The unified GPU data model

All buffers are struct-of-arrays. `std430` `vec4` stride = 16B, no padding; `uvec4` likewise.

### 2.1 Per-body buffers (SoA)

| Buffer | Type | Contents | Notes |
|---|---|---|---|
| `base` | `instancedArray(MAX_RESIDENT,'vec4')` | xyz = **ABSOLUTE static-noise world meters** (AUTHORITATIVE, server-matched `field.ts`), w = radius (45..355) | **IMMUTABLE** after seed. `.setPBO(true)` marks it CPU-authored and draw-readable. Written by CPU upload, NOT a GPU `frac(sin)` kernel — see §3.2. |
| `pos` | `instancedArray(MAX_RESIDENT,'vec4')` ping-pong pair `pos_a/pos_b` | xyz = rendered world meters = `base + bounded overlay`, w = radius copy | What `material.positionNode` reads. The pair is always allocated; it is *actively swapped* only once integration exists (Section 4.2). At render `pos = base + wobble(phase, frame)`. |
| `velMass` | `instancedArray(MAX_RESIDENT,'vec4')` ping-pong pair | xyz = velocity m/s, w = inverse-mass (0 = immovable) | Meaningful only for collidable/promoted slots; the bulk leaves 0. |
| `orient` | `instancedArray(MAX_RESIDENT,'vec4')` quaternion (xyzw, normalized) | per-body orientation | Spin has no neighbor coupling → **single-buffered**, integrated in place. |
| `angSig` | `instancedArray(MAX_RESIDENT,'vec4')` | xyz = angular velocity rad/s, w = **signature (0.08..0.78)** | `w` carries the signature the field generator produces (`field.ts`), needed for scan-strength parity. The mineral payload lives in `packAttr`. |
| `packAttr` | `instancedArray(MAX_RESIDENT,'vec4')` | x = bit-packed(mineralIdx 0..5 \| pocketId 0..2 \| LOD/flags), y = mineralRichness (0.18..1.0), z = overlay phase seed, w = reserved | Mineral payload lives here. |
| `slotMeta` | `instancedArray(MAX_RESIDENT,'uvec4')` | (globalCellX, globalCellY, globalCellZ, residencyEpoch) | Reconstructs the EXACT id `v-${cx}-${cy}-${cz}` for picking/promotion without a string table. Bridge: `getArrayBufferAsync(slotMeta)` or a GPU pick pass. |

**VRAM.** The bulk-render subset (`base + pos + orient + packAttr` = 64B) = 3.2MB@50k / 16MB@256k. Full sim
(132B incl. ping-pong + slotMeta) = 6.6MB@50k / ~34.6MB@256k / 132MB@1M. Each binding stays under the 128MiB
cap because SoA keeps them split (a single `vec4` binding hits the 128MiB `maxStorageBufferBindingSize` only
at ~8M bodies). `maxComputeWorkgroupsPerDimension = 65535` is non-binding (256k/256 = 1024 groups).

### 2.2 The id ↔ slot bridge

A compacted draw slot is **NOT** a stable rock id (atomic compaction order is non-deterministic). Any
temporal per-rock state (selection highlight, promotion target) keys on `slotMeta` → `v-cx-cy-cz`, never on
the compacted draw index. Picking: a GPU pick pass writes the hit slot's `slotMeta` into a 1-element readback
buffer; the CPU reconstructs the id string client-side.

### 2.3 Shared grid buffers (ONE primitive, instantiated per consumer)

The grid is one primitive:

| Buffer | Type | Contents |
|---|---|---|
| `cellCount` | `instancedArray(G,'uint')` (atomic) | per-cell occupancy histogram, zeroed each rebuild by `clearCounts`. |
| `cellStart` | `instancedArray(G,'uint')` | exclusive prefix-sum of `cellCount`. **Doubles as the atomic write cursor during scatter** (one binding, not two). |
| `sortedItems` | `instancedArray(maxItems,'uint')` | item ids grouped by cell. Consumers loop `[cellStart .. cellStart+cellCount)`. |
| `blockSums` | `instancedArray(ceil(G/256),'uint')` | per-workgroup partial sums for the two-level scan. |

`G` is parameterized: world cells for collisions (Section 4.1), `160·90·64` for the future froxel grid. The
per-body `gridCell` is a value recomputed inline inside `count`/`scatter`, not a stored buffer (one fewer
1-uint-per-body binding).

The binner is parameterized over a **`cellIndexOf(item) → uint`** callback so the SAME kernels serve the
world-space collision grid now and a view-space log-depth froxel grid later. `cellIndexOf` MUST be an
**inlined compile-time TSL `Fn` per instantiation**, NOT a runtime indirection — runtime indirection would
tax the collision narrow-phase hot path (which wants the cell index recomputed inline).

### 2.4 Collision-only deferred buffers (sized at `MAX_COLLIDERS = Nc`, the subset — NOT full N)

| Buffer | Type | Contents |
|---|---|---|
| `dp` | `instancedArray(Nc,'vec4')` | positional correction xyz + contact count w. **Each lane writes ONLY its own `dp[i]`** (no atomics). |
| `dv` | `instancedArray(Nc,'vec4')` | velocity impulse, same single-owner rule. |

### 2.5 Froxel-ready buffer (future; schema committed now)

| Buffer | Type | Contents |
|---|---|---|
| `froxelAccum` | `instancedArray(160*90*64,'vec4')` index `z*W*H + y*W + x` | inScatter.rgb + transmittance.a |

`vec4`-SoA is the project-wide convention, chosen so it survives a `Storage3DTexture`-unavailable path and
shares the `pos`/`velMass` storage-buffer toolchain. The `Storage3DTexture` fallback is a legitimate
capability concern (a missing 3D-storage-texture feature on some adapters), unrelated to any rendering
fallback.

### 2.6 Uniforms (shared with the server via `fieldSummary()`)

```
seed = 424242          // field.ts  fieldSeed
cellSize = 1130        // field.ts
cellsPerAxis = 100     // field.ts — FIELD id-space, 100³ = 1M (NOT the collision grid axis)
originOffset = -56500  // field.ts  = -(100*1130)/2
windowMin (ivec3), windowDim (uint)   // resident ring window in FIELD cells
originMeters (vec3)    // floating-origin; metersPerSceneUnit = 1000
viewProj (mat4), dt, frameCounter
gridOrigin (vec3, ship-cell-snapped)  // COLLISION grid origin (separate near-window)
restitution (~0.15)
```

Constants documentation:

- The server is hard `cellsPerAxis = 100`, never 64. The FIELD id-space (100³, `cellsPerAxis = 100`) and the
  COLLISION near-window (64³, 768 m cells, Section 4.1) are **different grids** and must be documented as
  such at every seeding/boundary check.
- Server `renderedLimit` is a **stream/derive cap**: a server function reading `HAYSTACK_RENDERED_LIMIT`,
  defaulting to **50000** (`field.ts`), env-tunable, and a bench can drive it to 100k+. It is how many rocks
  the server derives and streams. Client `MAX_RESIDENT` is a **GPU buffer capacity** (default 50k, headroom
  256k). They are different concepts and must not be conflated.
- `originOffset = -56500`, `cellSize = 1130`, and `seed = 424242` all match the server.

---

## 3. The per-frame compute graph

### 3.1 Dispatch list (the honest count)

The Blelloch prefix-sum over `G` is not one pass: per-block scan + scan-the-blockSums + add-block-offsets =
3–4 dispatches by itself. The real per-frame graph:

```
BASE GRAPH (always):
  1. (cell-cross only) genFieldOverlay re-seed crossed slabs    — amortized ~0/frame
  2. step  (overlay wobble + quaternion spin + K-well gravity)
  3. clearCull  (zero per-LOD indirect instanceCount)
  4..7. cull/LOD compaction (≈4 LODs)                            — ~5 dispatches

COLLISION GRAPH (per substep, ×1–2):
  8.  clearCounts
  9.  count
  10. scan: per-block scan
  11. scan: scan blockSums
  12. scan: add block offsets
  13. scatter
  14. narrow (27-cell deferred-apply)
  15. apply  (write dp/dv into pos/velMass)                      — ~8 dispatches/substep
```

Total **≈ 15 dispatches at 1 substep, ≈ 23 at 2 substeps.**

### 3.2 Determinism: base is CPU-derived

Base positions are derived on the **CPU** and uploaded to the GPU; the GPU computes ONLY
`pos = base + bounded overlay`. The GPU never regenerates positions with a `frac(sin)` kernel. This is a
first-class determinism requirement: the rendered base must be bit-identical to what the server derives.

The rationale is **server parity / bit-portability**. The server re-derives the static base on the CPU (f64
`Math.sin`), has no WebGPU, and GPU `sin`/`fract` is not bit-portable. The field generator's noise
(`field-core.ts` `hashCell`, `noise = frac(sin·43758.5453)`) is exquisitely sensitive in f32: `hashCell`
yields `s ≈ 4e10`, so `sin(s·12.9898)` has an argument ≈ 5e11 where one f32 ULP (~32768) sweeps thousands of
sine periods. Measured f32-vs-f64 error over 20k cells: max |Δposition| = **1036 m on a 1130 m cell**
(positions effectively uncorrelated), |Δradius| up to 289 m, and the discrete `rareMineral` index **flips on
~85% of rocks**. A GPU `frac(sin)` regeneration of `base` therefore cannot reproduce the server's field.

(The existing `field-core.ts` "sub-nanometre / purely cosmetic" comment concerns f64-`Math.sin`
cross-JS-engine ULP, where the client is the sole deriver — correct in its own scope. The 1036 m figure is
f32 GPU sin vs f64 CPU sin, a different and far larger error. Both are true; only the GPU-regeneration path
is ruled out here.)

**The rule:**

- `base` is derived on the **CPU** (the existing `field-core.ts` derive / a small per-slab CPU `genField`)
  and **uploaded** to the GPU `base` buffer via the storage-buffer write path. `base` is IMMUTABLE and
  `.setPBO(true)` marks it CPU-authored and draw-readable.
- The GPU does ONLY `pos = base + overlay(phase, frame)`. The overlay is `frac(sin)`-free (a bounded wobble
  from `packAttr.z` phase + `frameCounter`), so its f32 non-portability is genuinely cosmetic.
- **Ring re-seed is a CPU derive + buffer sub-range write**, NOT a GPU kernel: a CPU derive of the crossed
  slab's cells + `setPBO` sub-range upload. `base` has ONE authority — the CPU derive.

**Sun-occlusion coupling.** `sun-occlusion.ts` `computeSunlit` uses the same noise to place up-sun
occluders, and the rendered `aSunlit` shadow is keyed on it. Because `base` comes from the single CPU derive,
render `base` and `aSunlit` occluders share one source — shadows stay attached to rocks.

### 3.3 Dispatch discipline: one submission, never per-pass await

All compute passes are submitted via **`renderer.compute(node)`** in a single frame submission. **NEVER**
`await renderer.computeAsync(pass)` per pass in the hot loop. At ~150µs/await, 23 dispatches = **3.45 ms
(21% of a 16.6 ms frame) of pure CPU↔GPU serialization** before a single byte of work. `computeAsync` is for
one-time init and occasional readback only.

### 3.4 Fixed broad-phase floor + Nc==0 gate

`clearCounts` (4·G = 1MB) + the prefix-sum over `G` (~6.3MB) + ~4–5 dispatches are paid **every frame/substep
even when ZERO rocks collide** — which, at the field's native density, is the common case. Two mitigations,
both mandatory:

- **Gate the entire broad+narrow phase off when `Nc == 0`** (no colliders in the near-window).
- **Scope `G` to where colliders actually are** — build the grid only over the authored-dense sub-region or
  the collider near-window, NOT a static full 49 km / 768 m 262144-cell grid when nothing collides.

2 substeps **doubles the entire collision pipeline including the fixed floor.** Budget for ×2 (Section 4.6),
not ×1.

---

## 4. Collisions & the authority model

### 4.1 Broad phase (world-space uniform grid)

- Grid: cubic cells of **768 m** over a ship-cell-snapped near-window. `G = 64³ = 262144` covers a ~49 km
  window. Cell index: `cellIndexOf(i) = pack(floor((pos_i - gridOrigin)/cellSize_collision))`, inlined.
- `clearCounts` → `count` (`atomicAdd(cellCount[c], 1)`) → `scan` (Blelloch, Section 3.1 dispatches 10–12,
  using `blockSums`) → `scatter` (`atomicAdd(cellStart[c], 1)` as cursor, write slot id into `sortedItems`).
- Built over the **collidable subset `Nc`** (`MAX_COLLIDERS`), not full `N`, and `G` is scoped to the
  collider region (Section 3.4).

### 4.2 Narrow phase (deferred-apply, race-free)

**EVERY lane scans all 27 neighbor cells and accumulates ONLY its own `dp[i]`/`dv[i]`** from the
inverse-mass-weighted split. No `j≤i` skip, no cross-lane writes, no atomics in resolve. This is the only
race-free deferred form. It **doubles pair work** — negligible at native occupancy (<<1/cell) but
concentrated exactly in the authored-dense validation belt and under gravity-clumping (occ ≈ 1/cell), so the
budget tables (Section 4.6) note the ×2.

Per contact: sphere-sphere positional pushout (half-penetration weighted by inverse mass) + restitution
impulse (`restitution ≈ 0.15`) into `dp`/`dv`. The apply pass (dispatch 15) folds `dp`/`dv` into
`pos`/`velMass`; the ping-pong pair is *actively swapped* here, and only here (Section 2.1).

The ship is injected as immovable pushing spheres (`velMass.w = 0`) from `shipPos` uniforms. Because
`integrateShipTick` (`src/shared/ship-motion.ts:96`) has ZERO asteroid awareness, the ship flies through the
authoritative static field; the GPU plough is cosmetic on the *ship* side too and differs per client. A
server-stopped/bounced ship requires separate server ship-vs-static/promoted collision and is out of scope
(rule (d) / Decision 3).

### 4.3 Density / clustering — what MAKES collisions happen

At native density (1 rock / 1130 m cube; radius 45..355 m → max pair-overlap 710 m < 1130 m spacing) rocks
**essentially never overlap** — a 768 m collision cell averages <<1 occupant. Collisions are *manufactured*:

- **Sparse K-well gravity:** a `gravityWells[K ≤ 8]` attractor loop (O(N·K)) pulls rocks into local knots,
  deliberately raising occupancy to where the 27-cell loop and pushout matter.
- **Authored dense belts:** a hand-placed high-density region (occ ≈ 1/cell) that exercises the narrow phase
  and atomic-contention paths and is the early validation target.

**Atomic contention.** `atomicAdd` on `cellCount`/`cellStart` serializes writers hitting the same cell. At
native occ<<1 this is free; in the authored-dense belt and under K-well clumping (the exact scenario the
feature exists for) hot cells serialize atomics — the feature's worst atomic-contention case. Mitigate by
keeping clumps spread across cells (gentle well amplitude) and validating contention on the dense belt early.

### 4.4 Substeps & timestep

Fixed `dt` with a small accumulator, max **1–2 substeps**, clamped to avoid spiral-of-death on tab refocus.
Drift/spin tolerate variable dt; collisions want the fixed step. 2 substeps doubles the whole collision graph
(Section 3.4).

### 4.5 Authority model — three tiers, four rules

The static-base guarantee is enforced by the data path (Section 1.2). The model achieves safety by making
collisions cosmetic. The single bridge to "mattering" — promotion — is where the costs concentrate.

**TIER 1 — visual bulk (50k–256k resident / 1M id-space):** lives entirely client-GPU. Overlay drift, spin,
AND inter-asteroid collisions are COSMETIC-ONLY, never on the wire, never authoritative. `base` (immutable
static noise) is what gameplay reads; `pos = base + overlay` is what only the renderer reads.

**TIER 2 — collisions:** the GPU narrow phase resolves `pos`/`velMass` for visual pile-ups and ship-plough.
It CANNOT feed any gameplay output.

**TIER 3 — promoted hot set:** anything a ship *touches* (mine/impact/displacement) is INSERT-if-absent into
the SQLite `asteroids` table on its deterministic `v-cx-cy-cz` id and becomes server-authoritative at the
30Hz tick (this fixes the `mineDeposit` "Asteroid not found" gap for `v-` ids). This is real netcode, gated.

**FOUR RULES:**

- **(a) gameplay-reads-static-base.** `virtualScanHits` and `mineDeposit` keep deriving the STATIC base; the
  bulk needs ZERO wire change.
- **(b) movable/minable rocks are promoted** to the server hot set; the client snaps them from the
  `ASTEROIDS_FINGERPRINT` delta.
- **(c) reject 1M client/server lockstep.** GPU `sin`/`fract` is not bit-portable (Section 3.2) AND the
  server has no WebGPU.
- **(d) ship-asteroid impact/damage/stop MUST be a server test** vs the authoritative ship + static/promoted
  positions; the client GPU plough has ZERO effect on ship state.

**Properties and costs of the promotion tier:**

1. **Scan-bearing render-vs-aim divergence (UX, not STATE).** The server bearing points at the static base;
   the rendered rock sits at `base + wobble`. `bearing = unit(...)` rounds each component to **3 decimals**
   (`field.ts`) → ~50 m bearing granularity at 50 km. A wobble inside the 1400 m mine slack can still produce
   a visibly wrong arrow. Cosmetic collision/overlay displacement must stay gameplay-INVISIBLE: use a bounded
   wobble, NOT a free-running integrator, for the bulk.

2. **Deposit synthesis.** `mineDeposit` requires BOTH an `asteroids` row AND a `deposits` row keyed on
   `asteroid_id` (`sim.ts`); virtual rocks have NEITHER (only the world seed inserts deposits, `db.ts`, FK
   `ON DELETE CASCADE` to asteroids). Promotion must **deterministically synthesize deposits** too, or every
   promoted rock is minable-but-empty.

3. **Fingerprint collapse.** `ASTEROIDS_FINGERPRINT` is cell-STABLE only because the field is static.
   Promoting MOVING rocks forces the fingerprint to change every tick a promoted rock moves, collapsing the
   asteroids key back to per-tick full serialization for every in-range subscriber — the exact cost the
   fingerprint was built to avoid. This is loss of the static-field free-ride, not mere delta growth.

4. **Two-body cascade.** An inter-asteroid collision is intrinsically multi-body. To be authoritative it must
   promote BOTH bodies plus any cascade; one ship in a dense belt promotes a growing, churning cluster.
   Eviction/demotion must handle bodies STILL IN CONTACT — a rock cannot be demoted mid-pile without
   teleporting back to `base` on the next client re-derive.

5. **Non-determinism laundered into authority.** Clients run independent, non-bit-portable GPU sims (rule c).
   Making a collision result matter via promotion snaps whatever ONE client's non-deterministic GPU produced
   onto everyone (a touch-first race); others see non-reproducible pops.

**Conclusion:** the cosmetic tier does NOT desync gameplay STATE. Everything that MATTERS is
**server-simulated in the small** (the promoted hot set), which is real netcode (deposit synthesis + cascade
promotion + fingerprint cost + demotion-during-contact), not a free byproduct of the GPU sim. The promotion
tier is gated behind a product decision (Section 9).

### 4.6 Performance budget (shared, not collision-in-isolation)

Quote the collidable subset `Nc`, NOT `MAX_RESIDENT`, and state the budget as a SUM:

```
frame budget = collision + render + (future) froxel  ≤ 16.6 ms (60 fps)
```

- Real sustained BW ≈ 60–70% of spec (not theoretical peak). A 400 GB/s M-series Max sustains ~25–28
  full-buffer passes/frame, not 40.
- Render already spends **5–9 ms** (geometry + two-tier shadow + TSL post + bloom). After render there is
  **~7–10 ms** — roughly half the nominal passes.
- The future froxel pass (a 160·90·64 = 921600-cell view grid with an up-sun march reading the world grid)
  is itself a **multi-ms** consumer competing for the SAME bandwidth.

**60 fps line (collidable subset `Nc`, pipelined dispatch, render-adjusted):**

| Platform | `Nc` @ 60 fps | Notes |
|---|---|---|
| M-series Max (~400 GB/s) | **~100k colliders** | ~40 MB/substep@100k, ~80 MB at 2 substeps; comfortable under the render-adjusted budget. Degrades fast above ~250k (151 MB/substep, occ ≈ 0.95/cell, narrow phase ~115 MB) → ~30 fps. |
| base M4 (~120 GB/s) | **~50k colliders** | ~half after render. |

Memory budget: SoA keeps each `vec4` at 16MB@1M (128MiB only at ~8M); full-sim 132B/body = 6.6MB@50k /
~34.6MB@256k / 132MB@1M. `maxComputeWorkgroupsPerDimension = 65535` is non-binding (256k/256 = 1024 groups).

---

## 5. The renderer (WebGPU + TSL)

The renderer is one `WebGPURenderer` with a three-native `PostProcessing` + TSL post stack and NodeMaterials
throughout, instrumented from `renderer.info`.

- **Post stack.** Three-native `PostProcessing` + TSL `pass()` / `setMRT(mrt({output, normal}))` / `bloom()`
  addon / `renderOutput()` ACES. This replaces the pmndrs `EffectComposer` + Bloom + ACES + bespoke
  `ScanPulseEffectImpl` stack.

- **ScanPulse as a TSL node.** The scene pass writes `MRT(output, normal, [depth])`; normals come from an
  explicit `mrt({output, normal})`. The ScanPulse TSL node re-derives the player-distance basis under the
  floating origin (`originMeters`, `metersPerSceneUnit = 1000`) and samples the MRT normal + depth. It does
  **NOT** use `-getViewZ`, which is valid only with the camera at the scene origin under plain perspective
  depth (the old `ScanPulseEffectImpl` relied on exactly that, and its own comment said so). Under the
  floating origin the camera leaves the scene origin, so the basis is re-derived. This is the SAME post
  substrate the future `froxelApply` node slots into.

- **Materials.** Every material is a NodeMaterial (`MeshStandardNodeMaterial` / `MeshBasicNodeMaterial`) —
  asteroids, ships, structures, the sun. The asteroid two-tier shadow/occlusion (formerly the
  `onBeforeCompile` + `ShaderChunk.lights_fragment_begin` patch + `aSunlit` attribute,
  `patchAsteroidShader`) is expressed in TSL as `shadowNode`/`outputNode`
  `mix(aSunlit, shadowOutput, bubbleWeight)`.

- **Dependency requirement.** Requires three `^0.183+` for `RenderPipeline` + `setIndirect` +
  `IndirectStorageBufferAttribute`; the `@types/three` pin and the R3F reconciler are constraints (the
  current repo pin is `^0.177`).

- **Instrumentation.** Sourced from `renderer.info` (`.render.calls` / `.triangles`), not the WebGL-only
  `gl.info` it replaces.

A capability check (`navigator.gpu?.requestAdapter()`) gates startup; on a non-WebGPU browser the app
refuses to start with an unsupported-browser message. There is no second rendering path.

---

## 6. Froxel volumetric-lighting readiness

The architecture stays compatible with a future froxel volumetric-lighting pass at near-zero added cost. The
enabling substrate exists for independently-required end-state reasons.

### 6.1 Why the prerequisites already exist

Nearly every "froxel-ready" line item is mandated by something else:

- **TSL post stack:** the end-state renderer's post stack (Section 5).
- **MRT normal+depth:** required to carry the core ScanPulse VFX (Section 5).
- **vec4-SoA accumulator convention:** the project-wide storage-buffer convention (Section 2).
- **The binner:** required for first-class collisions (Section 4).

The froxel prerequisites are therefore a near-zero-cost byproduct of the architecture, not a speculative tax.

### 6.2 Shared kernels, separate instances

The share is the **count/scan/scatter CODE via `cellIndexOf`**, NOT one grid or shared buffers. The two are
separate instances:

- **Topology differs:** world cubic `64³ = 262144` vs view-space `160·90·64 = 921600` frustum-warped
  log-depth cells. Different `cellIndexOf` functions.
- **Invalidation differs:** collisions rebuild on camera *translation*; froxels rebuild on *rotation* too.
- **Buffers are additive, not shared:** running both means two `cellCount/cellStart/blockSums` sets at
  different `G` plus the ~14MB `froxelAccum` — ~2× grid storage. Cheap on unified-memory Apple silicon, but
  stated.

Headline: **shared kernels, separate instances.**

### 6.3 Sun-occlusion-march affinity

Haystack has ~2 lights (sun directional + ship flashlight, `lighting.ts`); a 921600-cell Forward+ light
binner for 2 lights would be waste, so light culling is not the froxel value. The real coupling:
`sun-occlusion.ts` `computeSunlit` is ALREADY a world-space product-of-(1-cover) transmittance march up the
sun direction, capped penumbra, early-out at `TRANS_FLOOR` — a froxel up-sun shadow march evaluated
per-rock-cell on CPU. The future froxel pass ports this loop to TSL and marches per-froxel, reading the SAME
world grid the collisions build. This is where "the collision world grid built before the froxel pass so
froxels can query it for rock shadows" is genuinely valuable: the volumetric shadow caster (rocks) is exactly
what the collision grid already indexes in world space.

### 6.4 Guardrail: do not couple grid origins

Building the collision world grid before the froxel pass must NOT later collapse the collision grid's
ship-cell-snapped world-cubic origin/extent into a camera-frustum shape to please froxels. The two stay
separate instances (collision = world cubic; froxel = view-space) where froxels READ the world grid. Never
couple their `gridOrigin`s; never collapse the collision origin into a frustum shape.

### 6.5 The future froxel pass (additive)

`froxelScatter` (view-space binner instance + up-sun march reading the WORLD grid, porting the
`sun-occlusion.ts` march to TSL) → `froxelIntegrate` (front-to-back Z prefix-scan) → `froxelApply` node into
the TSL post chain **BEFORE bloom**. All enabling choices already exist; this pass is explicitly future and
purely additive.

---

## 7. Build sequence (single-architecture bring-up)

This is the order in which the one WebGPU system is brought up. Each step is an end-state-valid piece of the
single architecture.

1. **WebGPU renderer beachhead.** The game boots on `WebGPURenderer`; materials are authored as
   NodeMaterials; the capability check refuses non-WebGPU browsers. *(Risk: R3F async-gl factory +
   StrictMode double-init guard.)*

2. **TSL post stack + ScanPulse.** Scan VFX + bloom + ACES via three-native `PostProcessing`;
   `mrt({output, normal})`; ScanPulse re-derives the player-distance basis (not `-getViewZ`). A
   screenshot/visual-correctness gate confirms the VFX. *(Risk: floating origin breaks `-getViewZ` —
   re-derive the basis.)*

3. **GPU-resident base + zero-copy render.** 50k–256k static rocks GPU-resident; `base` uploaded from the CPU
   derive (NOT a GPU `frac(sin)` kernel); `pos = base + overlay`; `material.positionNode` with `originMeters`.
   The CPU-derive worker is what this replaces. Parity gate = `getArrayBufferAsync(base)` vs
   `deriveVirtualField` **EXACT / bit-identical** (same CPU source), not "sub-meter after a GPU port". *(Risk:
   keeping `base` strictly CPU-authored.)*

4. **Ring streaming + GPU cull/LOD indirect.** A CPU ring bookkeeper re-seeds crossed slabs (CPU derive +
   sub-range upload); a cull pass + per-LOD `IndirectStorageBufferAttribute` + `setIndirect`; the aSunlit
   two-tier shadow in TSL; instrumentation from `renderer.info`. *(Risks: clear/cull/draw ordering races; the
   compacted slot is NOT a stable id — key temporal state on `slotMeta`; FIELD 100³ vs collision 64³
   off-by-one.)*

5. **Shared binning primitive** (lands early — serves BOTH collisions and the future froxel binner). A
   tested, reusable `count→scan→scatter` binner (`cellCount/cellStart/sortedItems/blockSums`) behind an
   inlined `cellIndexOf`; a world-space instance + a debug occupancy heatmap. *(Risk: Blelloch prefix-sum
   over `G = 262144` with `workgroupArray`/`storageBarrier` is research-grade in TSL; keep `cellIndexOf`
   inlined per instance.)*

6. **T1/T2 cosmetic motion.** A moving field that stays gameplay-safe: bounded wobble
   `f(phase, frameCounter)` (re-derivable, eviction-lossless) + quaternion spin + `gravityWells[K≤8]` to
   manufacture clumping. *(Risk: keep the overlay BOUNDED under the radius+1400 m mine slack AND
   gameplay-invisible vs the 3-decimal bearing.)*

7. **T3 inter-asteroid collisions (first-class).** 27-cell deferred-apply pushout + restitution into
   `dp`/`dv` (each lane writes only its own slot), apply, fixed dt 1–2 substeps, ship as immovable pushing
   spheres. Validate at 100k against an authored dense belt. *(Risks: deferred-apply correctness; pipelined
   dispatch mandatory (Section 3.3); fixed broad-phase floor / gate when Nc==0; atomic contention in the
   dense belt.)*

8. **Promotion authority netcode** (GATED behind a product decision). INSERT-if-absent on `v-cx-cy-cz`;
   deterministic deposit synthesis; nullable velocity/orientation cols; fingerprint-collapse mitigation;
   eviction/demotion handling bodies still in contact; the client snaps hot instances from the delta. *(Risks:
   fingerprint free-ride loss; deposit synthesis; two-body cascade; non-determinism → shared-authority
   touch-race.)*

9. **Froxel volumetric lighting** (explicitly future / additive). `froxelScatter → froxelIntegrate →
   froxelApply` before bloom. *(Risk: competes for the same bandwidth (Section 4.6).)*

---

## 8. Bring-up reference: boot + CPU-base + overlay + floating-origin render

The boot path stands up `WebGPURenderer`, NodeMaterials, the CPU-base upload, and the first TSL compute (the
`genFieldOverlay` overlay kernel) to prove boot + zero-copy draw end-to-end. Per Section 3.2, `base` is
CPU-uploaded; the kernel shown here is the OVERLAY kernel, which is `frac(sin)`-free and safe to run on the
GPU.

### 8.1 Files

```
src/client/eve/gpu/
  renderer-factory.ts     # async WebGPURenderer gl factory
  capability.ts           # navigator.gpu?.requestAdapter() detection; refuses to start without WebGPU
  buffers.ts              # instancedArray allocations (base, pos, packAttr) + MAX_RESIDENT
  kernels/overlay.ts      # genFieldOverlay TSL Fn (frac(sin)-FREE) + seedBaseFromCPU upload
  kernels/render-node.ts  # material.positionNode with originMeters floating-origin
src/client/eve/components/
  WorldView.tsx           # the single R3F <Canvas gl={factory}> WorldView
```

### 8.2 The async gl factory (R3F)

```ts
// renderer-factory.ts
import * as THREE from 'three/webgpu';
import { extend } from '@react-three/fiber';
extend(THREE as any); // register three/webgpu node objects with the R3F reconciler

export function makeWebGPUFactory() {
  return async (props: { canvas: HTMLCanvasElement }) => {
    const renderer = new THREE.WebGPURenderer({
      canvas: props.canvas,
      antialias: true,
    });
    await renderer.init();          // MUST await before first render (StrictMode double-init guard below)
    return renderer;
  };
}
```

```ts
// capability.ts — WebGPU adapter detection; refuses to start without WebGPU.
export async function hasWebGPU(): Promise<boolean> {
  const adapter = await (navigator as any).gpu?.requestAdapter?.();
  return !!adapter;
}

export async function assertWebGPU(): Promise<void> {
  if (!(await hasWebGPU())) {
    throw new Error('This application requires WebGPU; your browser does not support it.');
  }
}
```

**StrictMode guard:** the async factory can run twice under StrictMode double-mount. Memoize the renderer
promise per canvas and `renderer.dispose()` on the discarded mount; do not start `setAnimationLoop` until the
awaited renderer is the live one.

### 8.3 The overlay seed kernel + base upload (proves boot + zero-copy)

```ts
// kernels/overlay.ts
import * as THREE from 'three/webgpu';
import { Fn, instancedArray, instanceIndex, uniform, vec3, fract, sin } from 'three/tsl';

export const MAX_RESIDENT = 50_000;

// base: CPU-authored, IMMUTABLE, draw-readable. (§3.2 — do NOT regenerate on GPU.)
export const base     = instancedArray(MAX_RESIDENT, 'vec4').setPBO(true); // xyz=meters, w=radius
export const pos      = instancedArray(MAX_RESIDENT, 'vec4').setPBO(true); // xyz=base+overlay, w=radius
export const packAttr = instancedArray(MAX_RESIDENT, 'vec4');              // z = wobble phase seed

// Upload base from the EXISTING CPU derive (field-core.ts deriveVirtualField / worker).
// This is the single source of truth shared with sun-occlusion (§3.2).
export function seedBaseFromCPU(renderer: THREE.WebGPURenderer, derived: Float32Array /* xyzr*N */) {
  // write `derived` into base's backing store, then renderer marks it for upload.
  // (use the storage-buffer write API.)
}

const frameCounter = uniform(0);

// OVERLAY kernel: frac(sin) here is on a SMALL bounded phase (cosmetic), NOT the hashCell argument,
// so f32 non-portability is genuinely harmless. pos = base + bounded wobble.
export const genFieldOverlay = Fn(() => {
  const i  = instanceIndex;
  const b  = base.element(i);
  const ph = packAttr.element(i).z;
  const t  = frameCounter.mul(0.01);
  const wob = vec3(
    fract(sin(ph.add(t)).mul(43758.5453)).sub(0.5),
    fract(sin(ph.add(t).add(1.7)).mul(43758.5453)).sub(0.5),
    fract(sin(ph.add(t).add(3.1)).mul(43758.5453)).sub(0.5),
  ).mul(80.0); // BOUNDED ±40m wobble — well under the 1400m mine slack AND gameplay-invisible
  const p = pos.element(i);
  p.xyz.assign(b.xyz.add(wob));
  p.w.assign(b.w);
})().compute(MAX_RESIDENT);
```

### 8.4 The render node (floating-origin)

```ts
// kernels/render-node.ts
import * as THREE from 'three/webgpu';
import { Fn, instanceIndex, uniform, attribute } from 'three/tsl';
import { pos } from './overlay';

export const originMeters = uniform(new THREE.Vector3());

export function makeAsteroidMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial({ color: '#6f6a60', roughness: 0.96 });
  mat.positionNode = Fn(() => {
    const p   = pos.element(instanceIndex);
    const rel = p.xyz.sub(originMeters).div(1000);          // metersPerSceneUnit = 1000
    return attribute('position').mul(p.w.div(1000)).add(rel);
  })();
  return mat;
}
```

### 8.5 Per-frame loop

```ts
// inside WorldView useFrame / setAnimationLoop
originMeters.value.copy(ownShipMeters);
frameCounter.value += 1;
renderer.compute(genFieldOverlay);   // pipelined, NOT computeAsync-awaited (§3.3)
renderer.render(scene, camera);
```

### 8.6 Verification

1. **Boot:** the console shows the WebGPU adapter; on a browser without WebGPU the app refuses to start with
   an unsupported-browser message (no second renderer).
2. **Zero-copy draw:** a single `InstancedMesh` of `MAX_RESIDENT` rocks draws from `pos`, with no
   `setMatrixAt` and no per-chunk meshes.
3. **Base parity:** `new Float32Array(await renderer.getArrayBufferAsync(base))` === the CPU
   `deriveVirtualField` output **exactly** (same CPU source, so bit-identical), not "sub-meter after a GPU
   port". Add `scripts/bench/parity-base.ts`.
4. **Overlay bounded:** assert `|pos - base| ≤ 40m` for every slot (gameplay-invisible vs the 3-decimal
   bearing).
5. **No await stall:** the frame submits all compute in one `renderer.compute` call; verify no per-pass
   `computeAsync` in the hot path.

---

## 9. Open product decisions + what to prototype first

### 9.1 Open product decisions (gate before building the dependent step)

1. **Do collisions need to MATTER beyond cosmetic?** If yes, the promotion tier is required, and with it:
   deposit synthesis, fingerprint-collapse cost, two-body cascade promotion, demotion-during-contact, and a
   non-deterministic-GPU-result-becoming-shared-truth race. This is real netcode sized in the small. Default
   recommendation: **collisions are cosmetic; gameplay that must matter is server-simulated in the small.**
2. **Do minable rocks ever MOVE?** If no, the visual-only boundary holds and the authority problem dissolves.
   If yes → a server-streamed sparse hot set (the promotion tier), never lockstep.
3. **Is the ship ever STOPPED/bounced by rocks?** That requires server ship-vs-asteroid collision
   (`ship-motion.ts` has none today) — a larger net-new piece than rule (d). Out of scope unless decided in.
4. **`MAX_RESIDENT` client capacity.** The client GPU buffer capacity (default 50k, headroom 256k) is a
   choice to pick independently and document. (The server `renderedLimit` defaults to 50000 and is
   env-tunable; it is a stream/derive cap, a different concept — Section 2.6.)

### 9.2 What to prototype first

**The boot path (Section 8) + the base-parity gate.** It proves the async gl factory, `extend(three/webgpu)`,
the CPU-base upload + zero-copy draw, and the floating-origin render node — with ZERO authority/post-stack
entanglement — and it establishes the determinism discipline (`base` from CPU, overlay on GPU) before any of
it can calcify the wrong way. Immediately after, the **Blelloch prefix-sum spike** (Section 7 step 5) is the
next highest-risk unknown (research-grade TSL); prototype it in isolation against a parity test before
collisions depend on it.

---

## Appendix — source anchors

The constants and source references shared with the server form the parity contract. (Treat `field.ts` line
numbers as approximate; they drift.)

- `field-core.ts` (`hashCell`, `noise = frac(sin·43758.5453)`, `virtualAsteroidAt`, `deriveVirtualField`,
  pack/unpack).
- `src/server/field.ts` (`fieldSeed = 424242` ~:22, `cellSize = 1130` ~:23, `cellsPerAxis = 100` ~:24,
  `renderedLimit()` reading `HAYSTACK_RENDERED_LIMIT` default `"50000"` ~:29–30, `originOffset = -56500`
  ~:32); `virtualScanHits` ~:146 (`bearing = unit(...)`); `virtualAsteroidAt` ~:182 (position ~:184–188,
  `signature` ~:192); `unit()` ~:246 / `round()` ~:266–267 (3-decimal quantization).
- `src/server/sim.ts` `mineDeposit` ("Asteroid not found", deposits row required, slack `radius + 1400`),
  the promotion insertion points, `virtualScanHits(...,52000,10)`, scan `WHERE id = ?`;
  `ASTEROIDS_FINGERPRINT` defined ~:41, computed ~:266, from `asteroidsForPilot` ~:935–947 (read by
  `realtime.ts` ~:350).
- `src/server/db.ts` deposits FK `ON DELETE CASCADE` + only-world-seed INSERTs.
- `src/shared/ship-motion.ts:96` `integrateShipTick` (pure thrust, zero asteroid awareness).
- `ScanPulseEffectImpl` (camera-at-origin `-getViewZ` assumption; NormalPass uniform).
- `WorldView.tsx` (`gl.info` instrumentation; `patchAsteroidShader` / `aSunlit`).
- `lighting.ts` (~2 lights); `sun-occlusion.ts` `computeSunlit` (the world-space up-sun transmittance march).
- `shared/types.ts` `MineRequest`.
- `docs/webgpu-asteroid-physics-rnd.md` (earlier R&D notes).
