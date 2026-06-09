# GPU-Resident Asteroid Field — Definitive Build Architecture

**Status:** FINAL PLAN — build from this. Supersedes `docs/webgpu-asteroid-physics-rnd.md` (referenced
as the R&D baseline; this doc *extends* it with collisions promoted to first-class and froxel-readiness
baked in). Adversarial corrections folded in inline and flagged with **[CORRECTED]** / **[FLAG]**.
**Date:** 2026-06-08
**Repo:** `/Users/hv/repos/haystack`
**Decision already made (do not relitigate):** one `WebGPURenderer` + TSL-compute pipeline, GPU-resident
field, inter-asteroid collisions first-class, froxel volumetric lighting must remain reachable. The legacy
WebGL2 CPU-derive + per-chunk `InstancedMesh` path becomes a **permanent fallback**, not a downgrade.

---

## 1. Commitment & end-state

### 1.1 What we are building

A single `WebGPURenderer` pipeline, feature-flagged behind `?webgpu` / capability-detect, in which the
asteroid field is **GPU-resident**: per-body state lives in WebGPU storage buffers (`instancedArray`),
mutated by TSL compute kernels, and read **zero-copy** by the render material via `material.positionNode`.
The CPU-side `deriveVirtualField → packField → unpackField → reconcileChunks → per-chunk InstancedMesh`
machinery is retired on the WebGPU branch and kept intact on the WebGL2 fallback branch.

Three end-state properties:

1. **GPU-resident field.** A fixed-capacity ring of `MAX_RESIDENT` slots (default **50k**, headroom
   256k). The "1M" is a **global ID space** (`cellsPerAxis³ = 100³ = 1,000,000`, server-hard at
   `field.ts:29`) streamed *through* the ring as the camera moves — never co-resident. Per-body state is
   struct-of-arrays `vec4` storage buffers; each binding stays ≤16MB at 256k, legal under
   `maxStorageBufferBindingSize = 128MiB`.

2. **Inter-asteroid collisions are first-class.** A GPU broad-phase (world-space uniform grid via atomic
   count → prefix-sum → scatter) plus a narrow phase (sphere pushout + restitution impulse, deferred-apply,
   substepped). **[FLAG]** They are *cosmetic-only* by construction (Section 4), which bounds how much they
   can "matter" without crossing into server-authoritative netcode. The deliberate answer for what *makes*
   collisions happen at the field's native ~1-rock-per-1130m density (where rocks essentially never overlap)
   is **manufactured local density**: sparse gravity wells (Section 4.3) and authored dense belts.

3. **Froxel volumetric lighting stays reachable.** No renderer choice precludes it. The TSL post substrate
   (Section 6), MRT normal+depth, readable depth, the `vec4`-SoA accumulator convention, and the shared
   count→scan→scatter binner all land for *independently-required* reasons (WebGPU migration + collisions)
   and happen to be exactly what a froxel pass needs. **[CORRECTED]** The honest framing is *not* "we
   invested in froxel-readiness" — it is "froxel prerequisites are a near-zero-cost byproduct of the
   WebGPU migration and first-class collisions" (Section 5).

### 1.2 The two load-bearing truths (verified against source)

- **Gameplay is id-keyed, not position-on-wire.** Scan targets and mine requests carry only the
  `v-cx-cy-cz` string id (`MineRequest = {asteroidId, depositId}`, `shared/types.ts`). The server
  *independently re-derives the STATIC noise base position* from that id (`field.ts:240` `virtualAsteroidAt`,
  `field.ts:204` `virtualScanHits`, `sim.ts:319-340` `mineDeposit`) and validates against its own DB row
  (`sim.ts:337-338`, slack `radius + 1400`). **Therefore client GPU motion physically cannot desync
  gameplay STATE.** This is enforced by the data path, not by convention.

- **The static field already streams at ~0 wire bytes/tick** via a cell-stable fingerprint
  (`realtime.ts:347-353`, `ASTEROIDS_FINGERPRINT`). The cosmetic GPU motion of the bulk adds **nothing** to
  the wire. **[FLAG]** This free-ride exists *only because the authoritative field is static*; promoting
  moving rocks (Section 4.5) collapses it back to per-tick serialization — that is the real cost of "making
  collisions matter," and it is netcode, not GPU work.

### 1.3 End-state diagram (per frame)

```
mutate uniforms (dt, originMeters, viewProj, gridOrigin, frameCounter)
  │
  ├─ on cell-cross: genFieldOverlay re-seed crossed ring slabs   (overlay only; base uploaded — see §3.2)
  ├─ integrate/overlay step  (bounded wobble + quaternion spin + sparse K-well gravity)
  ├─ ── SHARED BINNER (count → scan → scatter), WORLD-SPACE instance ──  (collision broad-phase)
  ├─ collision narrow phase  (27-cell deferred-apply pushout + impulse, 1–2 substeps)
  ├─ collision apply  (K6: each lane writes only dp[i]/dv[i])
  ├─ GPU cull/LOD compaction → per-LOD IndirectStorageBufferAttribute
  │
  └─ render:
       scenePass + MRT(output, normal, [depth])
         → ScanPulse TSL node (samples MRT normal + depth)
         → [future] froxelApply node            ← attaches HERE, before bloom
         → bloom()
         → renderOutput() / ACES tonemap
```

The collision world-grid is built **every frame before** the (future) froxel pass so froxels can query it
for volumetric rock shadows. **[CORRECTED]** "Query it" means froxels *read* the world grid; it does **not**
mean the collision grid is reshaped to a frustum — the two stay separate instances (Section 5.4).

---

## 2. The unified GPU data model

All buffers are struct-of-arrays. `std430` `vec4` stride = 16B, no padding; `uvec4` likewise. Naming
reconciles `foundation-1` (angSig/packAttr/slotMeta) with R&D §3.2 (`angPay`) and the three competing grid
schemas into one primitive (Section 2.3).

### 2.1 Per-body buffers (SoA)

| Buffer | Type | Contents | Notes |
|---|---|---|---|
| `base` | `instancedArray(MAX_RESIDENT,'vec4')` | xyz = **ABSOLUTE static-noise world meters** (AUTHORITATIVE, server-matched `field.ts:243-245`), w = radius (45..355) | **IMMUTABLE** after seed. `.setPBO(true)` so the WebGL2-fallback draw can read it. **[CORRECTED]** Written by CPU upload, NOT a GPU `frac(sin)` kernel — see §3.2. |
| `pos` | `instancedArray(MAX_RESIDENT,'vec4')` ping-pong pair `pos_a/pos_b` | xyz = rendered world meters = `base + bounded overlay`, w = radius copy | What `material.positionNode` reads. Pair allocated always; only *actively swapped* once T3 integration exists (Section 2.4 resolution). At T1/render `pos = base + wobble(phase, frame)`. |
| `velMass` | `instancedArray(MAX_RESIDENT,'vec4')` ping-pong pair | xyz = velocity m/s, w = inverse-mass (0 = immovable) | Meaningful only for collidable/promoted slots; bulk leaves 0. |
| `orient` | `instancedArray(MAX_RESIDENT,'vec4')` quaternion (xyzw, normalized) | per-body orientation | Spin has no neighbor coupling → **single-buffered**, integrated in place. |
| `angSig` | `instancedArray(MAX_RESIDENT,'vec4')` | xyz = angular velocity rad/s, w = **signature (0.08..0.78)** | **[RESOLVED]** This is R&D's `angPay` with the mineral payload moved out so `w` carries the signature the field generator actually produces (`field.ts:250`), needed for scan-strength parity. |
| `packAttr` | `instancedArray(MAX_RESIDENT,'vec4')` | x = bit-packed(mineralIdx 0..5 \| pocketId 0..2 \| LOD/flags), y = mineralRichness (0.18..1.0), z = overlay phase seed, w = reserved | Mineral payload lives here, freeing `angSig.w`. |
| `slotMeta` | `instancedArray(MAX_RESIDENT,'uvec4')` | (globalCellX, globalCellY, globalCellZ, residencyEpoch) | Reconstructs the EXACT id `v-${cx}-${cy}-${cz}` for picking/promotion without a string table. Bridge: `getArrayBufferAsync(slotMeta)` or a GPU pick pass. |

**VRAM.** Shippable bulk-render subset (`base + pos + orient + packAttr` = 64B) = 3.2MB@50k / 16MB@256k.
Full sim (132B incl. ping-pong + slotMeta) = 6.6MB@50k / 34MB@256k. Each binding stays under the 128MiB cap
because SoA keeps them split (a single `vec4` binding hits 128MiB only at ~8M bodies).

### 2.2 The id ↔ slot bridge

A compacted draw slot is **NOT** a stable rock id (atomic compaction order is non-deterministic, R&D §3.1
note). Any temporal per-rock state (selection highlight, promotion target) keys on `slotMeta` →
`v-cx-cy-cz`, never on the compacted draw index. Picking: GPU pick pass writes the hit slot's `slotMeta`
into a 1-element readback buffer; the CPU reconstructs the id string client-side.

### 2.3 Shared grid buffers (ONE primitive, instantiated per consumer)

**[RESOLVED]** `foundation-1`'s per-body `gridCell` uint, `foundation-2`'s
`cellCount+cellStart+cellCursor+sortedBodies`, and `foundation-3`'s
`cellCount+cellStart+sortedIndices+cellIndexOf` all collapse into ONE primitive:

| Buffer | Type | Contents |
|---|---|---|
| `cellCount` | `instancedArray(G,'uint')` (atomic) | per-cell occupancy histogram, zeroed each rebuild by `clearCounts`. |
| `cellStart` | `instancedArray(G,'uint')` | exclusive prefix-sum of `cellCount`. **Doubles as the atomic write cursor during scatter** — replaces `foundation-2`'s separate `cellCursor` (the standard idiom: one binding, not two). |
| `sortedItems` | `instancedArray(maxItems,'uint')` | item ids grouped by cell. Consumers loop `[cellStart .. cellStart+cellCount)`. |
| `blockSums` | `instancedArray(ceil(G/256),'uint')` | per-workgroup partial sums for the two-level scan. |

`G` is parameterized: world cells for collisions (Section 4.1), `160·90·64` for the future froxel grid.
`foundation-1`'s per-body `gridCell` is **demoted** from a stored buffer to a value recomputed inline inside
`count`/`scatter` (one fewer 1-uint-per-body binding).

The binner is parameterized over a **`cellIndexOf(item) → uint`** callback so the SAME kernels serve the
world-space collision grid now and a view-space log-depth froxel grid later. **[CORRECTED — critical]**
`cellIndexOf` MUST be an **inlined compile-time TSL `Fn` per instantiation**, NOT a runtime indirection —
otherwise it taxes the collision narrow-phase hot path (which wants the cell index recomputed inline) for a
feature that may never ship.

### 2.4 Collision-only deferred buffers (sized at `MAX_COLLIDERS = Nc`, the subset — NOT full N)

| Buffer | Type | Contents |
|---|---|---|
| `dp` | `instancedArray(Nc,'vec4')` | positional correction xyz + contact count w. **Each lane writes ONLY its own `dp[i]`** (no atomics). |
| `dv` | `instancedArray(Nc,'vec4')` | velocity impulse, same single-owner rule. |

### 2.5 Froxel-ready buffer (future; schema committed now)

| Buffer | Type | Contents |
|---|---|---|
| `froxelAccum` | `instancedArray(160*90*64,'vec4')` index `z*W*H + y*W + x` | inScatter.rgb + transmittance.a |

`vec4`-SoA chosen NOW so it survives a `Storage3DTexture`-unavailable fallback and shares the storage-buffer
toolchain with `pos`/`velMass`. **[CORRECTED]** This is the project-wide convention, not extra froxel
investment.

### 2.6 Uniforms (shared with server via `fieldSummary()`)

```
seed = 424242          // field.ts:27  fieldSeed
cellSize = 1130        // field.ts:28
cellsPerAxis = 100     // field.ts:29  — FIELD id-space, 100³ = 1M (NOT the collision grid axis)
originOffset = -56500  // field.ts:37  = -(100*1130)/2  ✓ matches
cpa = 100              // alias of cellsPerAxis; do NOT confuse with the 64³ collision near-window
windowMin (ivec3), windowDim (uint)   // resident ring window in FIELD cells
originMeters (vec3)    // floating-origin; metersPerSceneUnit = 1000
viewProj (mat4), dt, frameCounter
gridOrigin (vec3, ship-cell-snapped)  // COLLISION grid origin (separate near-window)
restitution (~0.15)
```

**[CORRECTED — constant mismatches that will bite parity]**
- Server is hard `cellsPerAxis = 100` (`field.ts:29`), NOT the 64 of the collision window. The FIELD
  id-space (100³) and the COLLISION near-window (64³, Section 4.1) are **different grids** and must be
  documented as such at every seeding/boundary check, or you reproduce the exact M2 "toroidal ring
  off-by-one ghost cell" bug.
- `renderedLimit` **default is `"20000"`** (`field.ts:34-35`), NOT 50000. Commit `71b8596`
  ("default 2000→50000") changed a *client* constant, not this server default. `MAX_RESIDENT` is a *client*
  capacity choice (default 50k); do not assume the server's `renderedLimit` equals it.
- `originOffset = -56500`, `cellSize = 1130`, `seed = 424242` all match server. Good.

---

## 3. The compute graph per frame

### 3.1 Dispatch list (the honest count)

**[CORRECTED — "six passes" undercounts]** The Blelloch prefix-sum over `G` is **not one pass**: per-block
scan + scan-the-blockSums + add-block-offsets = 3–4 dispatches by itself. The real per-frame graph:

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

### 3.2 [CORRECTED — load-bearing] Do NOT run `frac(sin)` on the GPU

The R&D draft and the input schema say `genField` is a "line-for-line port of `field-core.ts:20-27`
(`hashCell`, `fract(sin(s*12.9898)*43758.5453)`)" and the M2 gate is "`getArrayBufferAsync(base)` vs
`deriveVirtualField` sub-meter." **This is UNACHIEVABLE as written and the gate would always fail.**

Measured (f32 vs f64 over 20k cells, best-case correctly-rounded f32 sin — which real WGSL backends do NOT
even provide for large arguments): max |Δposition| = **1036 m on a 1130 m cell** (positions effectively
*uncorrelated*), |Δradius| up to 289 m, the discrete `rareMineral` index **flips on ~85% of rocks**. Root
cause: `hashCell` yields `s ≈ 4e10`, so `sin(s·12.9898)` has argument ≈ 5e11 where one f32 ULP (~32768)
sweeps thousands of sine periods. R&D line 470 ("worse than the Math.sin caveat") is right; line 298
("sub-nanometre") is badly wrong.

**THE FIX (mandatory):**
- `base` is derived on the **CPU** (the existing `field-core.ts` worker derive, or a small per-slab CPU
  `genField`) and **uploaded** to the GPU `base` buffer via the storage-buffer write path (`base` is
  IMMUTABLE and `.setPBO(true)` already implies a CPU-authored, draw-readable buffer).
- The GPU does ONLY `pos = base + overlay(phase, frame)`. The overlay is `frac(sin)`-free (a bounded wobble
  from `packAttr.z` phase + `frameCounter`), so f32 non-portability is genuinely cosmetic there.
- **Ring re-seed stays a CPU derive + buffer sub-range write**, NOT a GPU kernel. "One sub-ms `genField`
  dispatch" is replaced by "CPU derive of the crossed slab's cells + `setPBO` sub-range upload." This does
  NOT break the architecture — it makes `base` come from ONE authority (the CPU derive), which the next
  point requires anyway.

**[CORRECTED — sun-occlusion coupling gap]** `sun-occlusion.ts` `computeSunlit` (`:47-108`) uses the SAME
`frac(sin)` noise to place up-sun occluders, and the rendered `aSunlit` shadow is keyed on it. If the GPU
regenerated `base` independently, shadows would detach from rocks. Because `base` now comes from the single
CPU derive, render `base` and `aSunlit` occluders share one source — coupling preserved. (This also
eliminates the only player-visible migration risk: a `base`-position jump when toggling `?webgpu`.)

### 3.3 [CORRECTED — must mandate pipelined dispatch]

All compute passes are submitted via **`renderer.compute(node)`** in a single frame submission. **NEVER**
`await renderer.computeAsync(pass)` per pass in the hot loop. At ~150µs/await, 23 dispatches = **3.45 ms
(21% of a 16.6 ms frame) of pure CPU↔GPU serialization before a single byte of work**. The M6 risk text
flags "per-pass await serialization"; this is the explicit prohibition. `computeAsync` is for one-time init
and occasional readback only.

### 3.4 [CORRECTED — the fixed broad-phase floor]

`clearCounts` (4·G = 1MB) + the prefix-sum over `G` (~6.3MB) + ~4–5 dispatches are paid **every
frame/substep even when ZERO rocks collide** — which, at the field's native density, is the common case.
Two mitigations, both mandatory:
- **Gate the entire broad+narrow phase off when `Nc == 0`** (no colliders in the near-window).
- **Scope `G` to where colliders actually are** — build the grid only over the authored-dense sub-region or
  the collider near-window, NOT a static full 49km/768m 262144-cell grid when nothing collides.

The substep multiplier is explicit: 2 substeps **doubles the entire collision pipeline including the fixed
floor.** Budget for x2 (Section 4.6), not x1.

---

## 4. Collision system + authority model

### 4.1 Broad phase (world-space uniform grid)

- Grid: cubic cells of **768 m** over a ship-cell-snapped near-window. `G = 64³ = 262144` covers a ~49 km
  window. Cell index: `cellIndexOf(i) = pack(floor((pos_i - gridOrigin)/cellSize_collision))`, inlined.
- `clearCounts` → `count` (`atomicAdd(cellCount[c], 1)`) → `scan` (Blelloch, Section 3.1 dispatches 10–12,
  using `blockSums`) → `scatter` (`atomicAdd(cellStart[c], 1)` as cursor, write slot id into `sortedItems`).
- Built over the **collidable subset `Nc`** (`MAX_COLLIDERS`), not full `N`. **[FLAG]** `G` must also be
  scoped to the collider region (Section 3.4) or the win never materializes.

### 4.2 Narrow phase (deferred-apply, race-free)

**[RESOLVED — the only correct deferred form]** `foundation-2`'s text contradicted itself ("skip j≤i" vs
"accumulate only the i-side"). Decided in favor of the second: **EVERY lane scans all 27 neighbor cells and
accumulates ONLY its own `dp[i]`/`dv[i]`** from the inverse-mass-weighted split. No `j≤i` skip, no
cross-lane writes, no atomics in resolve. This is the only race-free deferred form (matches the R&D
determinism fix over test2's read-write-same-buffer race). It **doubles pair work** — negligible at native
occupancy (<<1/cell) but the cost concentrates exactly in the authored-dense validation belt and under
gravity-clumping (occ ≈ 1/cell), so the budget tables (Section 4.6) note the ×2.

Per contact: sphere-sphere positional pushout (half-penetration weighted by inverse mass) + restitution
impulse (`restitution ≈ 0.15`) into `dp`/`dv`. Apply pass (dispatch 15) folds `dp`/`dv` into `pos`/`velMass`
(the ping-pong pair is *actively swapped* here, and only here — Section 2.4).

Ship is injected as immovable pushing spheres (`velMass.w = 0`) from `shipPos` uniforms. **[FLAG — one-sided
plough]** Because `integrateShipTick` (`ship-motion.ts:96`) has ZERO asteroid awareness, the ship flies
through the authoritative static field; the GPU plough is cosmetic on the *ship* side too and differs per
client. A ship actually *stopped/bounced* by rocks requires separate server ship-vs-static/promoted
collision — a larger net-new piece than the authority model's rule (d) admits. Ship-plough ships as
cosmetic-only; "ship is stopped by rocks" is out of scope unless that server collision is built.

### 4.3 Density / clustering — what MAKES collisions happen

At native density (1 rock / 1130m cube; radius 45..355m → max pair-overlap 710m < 1130m spacing) rocks
**essentially never overlap** — a 768m collision cell averages <<1 occupant. So collisions are *manufactured*:

- **Sparse K-well gravity (T2, M5):** `gravityWells[K ≤ 8]` attractor loop (R&D §3.2 N-body template, O(N·K))
  pulls rocks into local knots, deliberately raising occupancy to where the 27-cell loop and pushout matter.
- **Authored dense belts:** the M6 validation target — a hand-placed high-density region (occ ≈ 1/cell) that
  exercises the narrow phase and atomic-contention paths.

**[CORRECTED — atomic contention]** `atomicAdd` on `cellCount`/`cellStart` serializes writers hitting the
same cell. At native occ<<1 this is free; in the authored-dense belt and under T2 clumping (the exact
scenario the feature exists for) hot cells serialize atomics — the feature's *worst* atomic-contention case.
Mitigate by keeping clumps spread across cells (gentle T2 amplitude) and validating contention on the dense
belt early.

### 4.4 Substeps & timestep

Fixed `dt` with a small accumulator, max **1–2 substeps**, clamped to avoid spiral-of-death on tab refocus.
Drift/spin tolerate variable dt; collisions want the fixed step. 2 substeps doubles the whole collision
graph (Section 3.4).

### 4.5 Authority model — three tiers, four rules

**[VERDICT: sound-with-corrections.]** The static-base guarantee is REAL and enforced by the data path
(Section 1.2). The model achieves safety by making collisions cosmetic — which is in tension with "collisions
must MATTER." The single bridge to "mattering" (promotion) is where the costs concentrate. Stated honestly:

**TIER 1 — visual bulk (50k–256k resident / 1M id-space):** lives entirely client-GPU. Overlay drift, spin,
AND inter-asteroid collisions are COSMETIC-ONLY, never on the wire, never authoritative. Structural
guarantee: `base` (immutable static noise) is what gameplay reads; `pos` (base + overlay) is what only the
renderer reads.

**TIER 2 — collisions:** the GPU narrow phase resolves `pos`/`velMass` for visual pile-ups and ship-plough.
It CANNOT feed any gameplay output.

**TIER 3 — promoted hot set:** anything a ship *touches* (mine/impact/displacement) is INSERT-if-absent into
the SQLite `asteroids` table on its deterministic `v-cx-cy-cz` id and becomes server-authoritative at the
30Hz tick (fixes the `sim.ts:326` "Asteroid not found" gap for `v-` ids).

**FOUR RULES:**
- **(a) gameplay-reads-static-base.** `virtualScanHits` (`field.ts:204`) and `mineDeposit` (`sim.ts:319-340`)
  keep deriving the STATIC base; the bulk needs ZERO wire change.
- **(b) movable/minable rocks are promoted** to the server hot set; client snaps them from the
  `ASTEROIDS_FINGERPRINT` delta (`realtime.ts:350`).
- **(c) reject 1M client/server lockstep.** GPU `sin`/`fract` is not bit-portable (Section 3.2) and the
  server has no WebGPU.
- **(d) ship-asteroid impact/damage/stop MUST be a server test** vs authoritative ship + static/promoted
  positions; the client GPU plough must have ZERO effect on ship state.

**[CORRECTED — where the model leaks, stated so the engineer is not surprised]:**

1. **Scan-bearing render-vs-aim divergence (UX, not STATE).** The server bearing points at the static base;
   the rendered rock sits at `base + wobble`. `bearing = unit(...)` rounds each component to **3 decimals**
   (`field.ts:310-312, 324-325`) → ~50 m bearing granularity at 50 km. A wobble inside the 1400 m mine slack
   can still produce a *visibly wrong arrow*. **Hard cap: cosmetic collision/overlay displacement must stay
   gameplay-INVISIBLE**, which bounds how much collisions can "matter." Use bounded wobble, NOT a
   free-running integrator, for the bulk.

2. **Promotion is the real desync surface and is under-costed:**
   - **[GAP — deposits]** `mineDeposit` requires BOTH an `asteroids` row AND a `deposits` row keyed on
     `asteroid_id` (`sim.ts:330-331`); virtual rocks have NEITHER (only the world seed inserts deposits,
     `db.ts:196`, FK `ON DELETE CASCADE` to asteroids, `db.ts:124`). Promotion must **deterministically
     synthesize deposits** too, or every promoted rock is minable-but-empty. This is net-new deterministic
     generation not in the original M7 scope — **added to M7 below.**
   - **[GAP — fingerprint collapse]** `ASTEROIDS_FINGERPRINT` is cell-STABLE only because the field is
     static. Promoting MOVING rocks forces the fingerprint to change every tick a promoted rock moves,
     collapsing the asteroids key back to per-tick full serialization for every in-range subscriber — the
     exact cost the fingerprint was built to avoid. M7 must size this honestly (it is loss of the
     static-field free-ride, not mere "delta growth").
   - **[GAP — two-body cascade]** An inter-asteroid collision is intrinsically multi-body. To be
     authoritative it must promote BOTH bodies plus any cascade; one ship in a dense belt promotes a growing,
     churning cluster. The eviction/demotion budget must handle bodies STILL IN CONTACT (cannot demote a rock
     mid-pile without it teleporting back to `base` on the next client re-derive).
   - **[GAP — non-determinism laundered into authority]** Clients run independent, non-bit-portable GPU sims
     (rule c). If a collision result is "made to matter" via promotion, the authoritative post-collision state
     is whatever ONE client's non-deterministic GPU produced, snapped onto everyone (a touch-first race);
     others see non-reproducible pops.

**The honest conclusion:** the cosmetic tier does NOT desync gameplay STATE. Everything that MATTERS must be
**server-simulated in the small** (the promoted hot set), and that hot set must be sized honestly — it is
real netcode (deposit synthesis + cascade promotion + fingerprint cost + demotion-during-contact), not a
free byproduct of the GPU sim. M7 is **gated behind an explicit product decision** (Section 9).

### 4.6 Performance budget (shared, not collision-in-isolation)

**[CORRECTED]** Quote the collidable subset `Nc`, NOT `MAX_RESIDENT`, and state the budget as a SUM:

```
frame budget = collision + render + (future) froxel  ≤ 16.6 ms (60 fps)
```

- Real sustained BW ≈ 60–70% of spec (NOT theoretical peak). A 400 GB/s M-series Max sustains ~25–28
  full-buffer passes/frame, not "40."
- Render already spends **5–9 ms** (geometry + two-tier shadow + TSL post + bloom). After render you have
  **~7–10 ms** — roughly *half* the nominal passes.
- Future froxel (a 160·90·64 = 921600-cell view grid with an up-sun march reading the world grid) is itself
  a **multi-ms** consumer competing for the SAME bandwidth.

**Honest 60 fps line (collidable subset `Nc`, pipelined dispatch, render-adjusted):**

| Platform | `Nc` @ 60 fps | Notes |
|---|---|---|
| M-series Max (~400 GB/s) | **~100k colliders** | ~40 MB/substep@100k, ~80 MB at 2 substeps; comfortable under render-adjusted budget. Degrades fast above ~250k (151 MB/substep, occ ≈ 0.95/cell, narrow phase ~115 MB) → ~30 fps. |
| base M4 (~120 GB/s) | **~50k colliders** | ~half after render. |

Memory budget is honest: SoA keeps each `vec4` at 16MB@1M (128MiB only at ~8M); full-sim 132B/body =
6.6MB@50k / 34.6MB@256k / 132MB@1M. `maxComputeWorkgroupsPerDimension = 65535` is non-binding (256k/256 =
1024 groups).

---

## 5. Froxel volumetric-lighting readiness

**[VERDICT: sound-with-corrections — genuinely low-cost insurance, NOT over-engineering.]** Restated
honestly per the adversarial lens.

### 5.1 The over-engineering rebuttal (state this explicitly)

Nearly every "froxel-ready" line item is **independently mandated**:
- **TSL post stack (M1):** the #1 WebGPU blocker — pmndrs `EffectComposer` (`ScenePostProcessing.tsx`) has
  no WebGPU path. Built anyway.
- **MRT normal+depth (M1):** required to port the CORE ScanPulse VFX (`ScanPulseEffectImpl.ts:28,41` samples
  a NormalPass + `getViewZ(depth)`). Built anyway.
- **vec4-SoA accumulator convention:** the project-wide storage-buffer convention. Costs nothing.
- **The binner (M4):** required for first-class collisions. Built anyway.

So **froxel-readiness is a near-zero-cost byproduct**, not a speculative tax.

### 5.2 [CORRECTED] "One primitive serves both" is SHARED CODE, not a shared grid

The honest claim (already in `conflictsResolved[5]`): the share is the **count/scan/scatter CODE via
`cellIndexOf`**, NOT one grid or shared buffers. The two are SEPARATE INSTANCES:
- **Topology differs:** world cubic `64³ = 262144` vs view-space `160·90·64 = 921600` frustum-warped
  log-depth cells. Different `cellIndexOf` functions.
- **Invalidation differs:** collisions rebuild on camera *translation*; froxels rebuild on *rotation too*.
- **Buffers are additive, NOT shared:** running both means two `cellCount/cellStart/blockSums` sets at
  different `G` plus the 14MB `froxelAccum` — ~2x grid storage. Cheap on unified-memory Apple silicon, but
  state it; do not let "one primitive" obscure it.

Downgrade the executive headline from "the same primitive generalizes to the froxel grid" to **"shared
kernels, separate instances."**

### 5.3 [CORRECTED] Drop the light-binning rationale; promote the sun-occlusion-march affinity

- **Drop:** Haystack has ~2 lights (sun directional + ship flashlight, `lighting.ts:5-30`). A 921600-cell
  Forward+ LIGHT binner for 2 lights is pure waste. Light culling is NOT the froxel value here.
- **The real, undersold coupling:** `sun-occlusion.ts` `computeSunlit` (`:47-108`) is ALREADY a world-space
  product-of-(1-cover) transmittance march up the sun direction, capped penumbra, early-out at
  `TRANS_FLOOR` — i.e. **a froxel up-sun shadow march evaluated per-rock-cell on CPU**. The future froxel
  pass ports exactly this loop to TSL and marches per-froxel, reading the SAME world grid the collisions
  build. THIS is where "the collision world grid built before the froxel pass so froxels can query it for
  rock shadows" is genuinely true and valuable: the volumetric shadow caster (rocks) is exactly what the
  collision grid already indexes in world space.

### 5.4 [CORRECTED — guardrail] Do not couple grid origins

"Build the collision world-grid before the froxel pass so froxels can query it" must NOT later collapse the
collision grid's ship-cell-snapped world-cubic origin/extent into a camera-frustum shape to please froxels.
Keep them separate instances (collision = world cubic; froxel = view-space) where froxels READ the world
grid. Do not couple their `gridOrigin`s.

### 5.5 The future froxel pass (M8, additive)

`froxelScatter` (view-space binner instance + up-sun march reading the M4 WORLD grid, porting
`sun-occlusion.ts:53-105` to TSL) → `froxelIntegrate` (front-to-back Z prefix-scan) → `froxelApply` node into
the M1 TSL post chain **BEFORE bloom**. All enabling choices already landed.

---

## 6. Renderer migration plan (kept live throughout)

The TSL compute is the easy part; the cost of going live inside `WorldView` is the surrounding WebGL-coupled
stack (R&D §6.1, all verified in-repo).

- **#1 blocker — postprocessing.** `ScenePostProcessing.tsx` uses `@react-three/postprocessing`
  `EffectComposer` + Bloom + ACES, plus the bespoke `ScanPulseEffectImpl` (extends pmndrs `Effect`, GLSL
  `mainImage` sampling a NormalPass via `getViewZ`). pmndrs targets WebGLRenderer with no migration path. On
  WebGPU the entire post stack moves to three-native `PostProcessing` + TSL `pass()` / `setMRT(mrt({output,
  normal}))` / `bloom()` addon / `renderOutput()` ACES.
- **ScanPulse port — [CORRECTED, it is a REWIRING not a translation]:**
  - `ScanPulseEffectImpl.ts:28-30` computes radial distance as `-getViewZ(depth)` and its OWN comment
    (`:13-15`) is explicit this is valid ONLY because the camera sits at the SCENE ORIGIN with plain
    perspective depth. The new floating-origin `originMeters` (metersPerSceneUnit=1000) **breaks this if the
    camera leaves origin.** The TSL re-port MUST re-derive the player-distance basis, not just translate
    GLSL→TSL.
  - ScanPulse currently pulls normals from `EffectComposerContext.normalPass` (`ScanPulseEffect.tsx`).
    three-native `PostProcessing` has NO such context, so the NormalPass becomes an explicit
    `mrt({output, normal})` the TSL node samples — this changes HOW/WHERE normals are produced, not just the
    shader language. This is the SAME post substrate the future `froxelApply` slots into.
- **#2 — materials repo-wide.** `WebGPURenderer` rejects `MeshStandardMaterial` → every material becomes
  `MeshStandardNodeMaterial` / `MeshBasicNodeMaterial` (asteroids, ships, structures, the sun in
  `SceneLighting.tsx`). The asteroid `onBeforeCompile` + `ShaderChunk.lights_fragment_begin` patch + `aSunlit`
  attribute (`WorldView.tsx:1116-1169`, `patchAsteroidShader`) has NO NodeMaterial equivalent; the two-tier
  shadow/occlusion blend re-expresses as TSL `shadowNode`/`outputNode` `mix(aSunlit, shadowOutput,
  bubbleWeight)`.
- **#3 — three bump.** `^0.177 → ^0.183+` (RenderPipeline + `setIndirect` + `IndirectStorageBufferAttribute`)
  under the strict `@types/three ^0.177` pin and the R3F reconciler.
- **#4 — instrumentation.** `RenderDriver` reads `gl.info.render.calls`/`.triangles`/`.autoReset`
  (`WorldView.tsx:1018-1026`) — WebGLRenderer-only. Re-source from `renderer.info` on WebGPU.
- **Fallback is permanent and a DIFFERENT code path.** `WebGPURenderer` on a WebGL2 backend **cannot run
  compute** (R&D §6.2). The fallback is the existing CPU-derive + per-chunk `InstancedMesh` pipeline.
  `setPBO(true)` only helps the storage-buffer-backed *draw* fall back, not compute. Two code paths until a
  WebGPU floor is set.

---

## 7. Re-sequenced milestone roadmap (real-thing-first, collisions in-scope)

**[CONFLICT RESOLVED]** R&D phases collisions to "cuttable M6" and froxels to "never"; the prompt mandates
collisions FIRST-CLASS and froxel-readiness early. Resolved by promoting the shared binner to **M4 (early)**
serving both, keeping the collision narrow phase as a real in-scope **M6**, and landing all froxel-enabling
infra in M1/M4 while deferring only the volumetric pass to M8. M0/M1 are HARD PREREQS that ship the WebGPU
path at VFX parity before any field rewrite, with WebGL2 CPU-derive as permanent fallback.

| M | Title | Deliverable | Effort | Risk | Deps |
|---|---|---|---|---|---|
| **M0** | WebGPU renderer beachhead | Live game boots on WebGPU behind `?webgpu`; materials re-authored as NodeMaterials; capability-gate → WebGL2 fallback. | ~1–2d | R3F async-gl factory + StrictMode double-init race | — |
| **M1** | TSL post stack + ScanPulse port | WebGPU path ships with scan VFX + bloom + ACES at parity (screenshot-diff gate). `mrt({output,normal})`; ScanPulse re-derives player-distance basis (NOT `-getViewZ`). Same substrate froxelApply uses. | ~3–4d | **#1 risk: dropping the core scan VFX**; floating-origin breaks `-getViewZ` (re-derive) | M0 |
| **M2** | GPU-resident base + zero-copy render | 50k–256k static rocks GPU-resident; CPU-derive worker retired on WebGPU branch. `base` uploaded from CPU derive (**NOT** a GPU `frac(sin)` kernel); `pos = base + overlay`; `material.positionNode` with `originMeters`. | ~2–3d | **[CORRECTED]** sin/fract NOT on GPU; parity gate = `getArrayBufferAsync(base)` vs `deriveVirtualField` **exact** (same CPU source), not "sub-meter after a GPU port" | M0, M1 |
| **M3** | Ring streaming + GPU cull/LOD indirect | Streaming GPU field at parity with legacy at 50k+. CPU ring bookkeeper re-seeds crossed slabs (CPU derive + sub-range upload); cull pass + per-LOD `IndirectStorageBufferAttribute` + `setIndirect`; aSunlit two-tier shadow ported to TSL. Instrumentation re-sourced from `renderer.info`. | ~3–4d | clear/cull/draw ordering races; compacted slot is NOT a stable id — key temporal state on `slotMeta`; toroidal ring off-by-one (FIELD 100³ vs collision 64³) | M2 |
| **M4** | SHARED BINNING PRIMITIVE | Tested, reusable count→scan→scatter binner (`cellCount/cellStart/sortedItems/blockSums`) behind **inlined** `cellIndexOf`; world-space instance + debug occupancy heatmap. Lands early because it is BOTH the collision broad-phase AND the froxel binner. | ~1–2wk | **Blelloch prefix-sum over G=262144 with workgroupArray/storageBarrier is research-grade in TSL**; keep `cellIndexOf` inlined per instance | M3 |
| **M5** | T1/T2 cosmetic motion | A moving field that stays gameplay-safe: bounded wobble `f(phase, frameCounter)` (re-derivable, eviction-lossless) + quaternion spin + `gravityWells[K≤8]` to MANUFACTURE clumping that makes collisions matter. | ~2–3d | keeping overlay BOUNDED under the radius+1400m mine slack (`sim.ts:338`) AND gameplay-invisible vs the 3-decimal bearing | M3 (M4 for clumping feedback) |
| **M6** | T3 inter-asteroid collisions (first-class) | Visible collisions in dense regions (flagged). 27-cell deferred-apply pushout + restitution into `dp`/`dv` (each lane writes only its own slot), K6 apply, fixed dt 1–2 substeps; ship as immovable pushing spheres. Validate at 100k against an AUTHORED dense belt. | ~2–3wk | deferred-apply correctness; **pipelined dispatch mandatory** (Section 3.3); fixed broad-phase floor (gate when Nc=0); atomic contention in the dense belt | M4, M5 |
| **M7** | Promotion authority netcode (GATED) | INSERT-if-absent on `v-cx-cy-cz` before `sim.ts:322/336/755` (fixes "Asteroid not found"); **deterministic deposit synthesis** (Section 4.5 gap); nullable velocity/orientation cols; **fingerprint-collapse mitigation**; eviction/demotion budget handling **bodies still in contact**; client snaps hot instances from the delta. | ~1–2wk+ | **[CORRECTED, under-costed]** fingerprint free-ride loss; deposit synthesis; two-body cascade; non-determinism → shared authority touch-race | M6 (or M5 if only movable-minable). **Behind a product decision.** |
| **M8** | Froxel volumetric lighting (future) | `froxelScatter` (view-space binner instance + up-sun march reading M4 WORLD grid, porting `sun-occlusion.ts:53-105` to TSL) → `froxelIntegrate` → `froxelApply` before bloom. Purely additive. | ~2–3wk | competes for the SAME bandwidth (Section 4.6) | M1, M4 |

---

## 8. Executable M0 spec (start immediately)

**Goal:** the live game boots on `WebGPURenderer` behind `?webgpu`, with the field still rendered by the
existing path but materials re-authored as NodeMaterials and a capability gate falling back to WebGL2. Plus
the very first TSL compute: a `genFieldOverlay` seed kernel writing `pos`/`packAttr` for a small instanced
draw, to prove the boot + zero-copy draw end-to-end. (Per Section 3.2, `base` is uploaded from the CPU
derive; the kernel demonstrated here is the OVERLAY kernel, which is `frac(sin)`-free and safe to run on GPU.)

### 8.1 Files

```
src/client/eve/gpu/
  renderer-factory.ts     # async WebGPURenderer gl factory + capability gate
  capability.ts           # navigator.gpu?.requestAdapter() detection, ?webgpu flag
  buffers.ts              # instancedArray allocations (base, pos, packAttr) + MAX_RESIDENT
  kernels/overlay.ts      # genFieldOverlay TSL Fn (frac(sin)-FREE) + seedBaseFromCPU upload
  kernels/render-node.ts  # material.positionNode with originMeters floating-origin
src/client/eve/components/
  WorldViewGPU.tsx        # R3F <Canvas gl={factory}> variant gated by ?webgpu
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
      forceWebGL: false,
      antialias: true,
    });
    await renderer.init();          // MUST await before first render (StrictMode double-init guard below)
    return renderer;
  };
}
```

```ts
// capability.ts
export async function preferWebGPU(): Promise<boolean> {
  if (!new URLSearchParams(location.search).has('webgpu')) return false;
  const adapter = await (navigator as any).gpu?.requestAdapter?.();
  return !!adapter;
}
```

**StrictMode guard:** the async factory can run twice under StrictMode double-mount. Memoize the renderer
promise per canvas and `renderer.dispose()` on the discarded mount; do not start `setAnimationLoop` until the
awaited renderer is the live one.

### 8.3 The overlay seed kernel + base upload (proves boot + zero-copy)

```ts
// kernels/overlay.ts
import * as THREE from 'three/webgpu';
import { Fn, instancedArray, instanceIndex, uniform, float, vec3, vec4, fract, sin } from 'three/tsl';

export const MAX_RESIDENT = 50_000;

// base: CPU-authored, IMMUTABLE, draw-readable. (Section 3.2 — do NOT regenerate on GPU.)
export const base     = instancedArray(MAX_RESIDENT, 'vec4').setPBO(true); // xyz=meters, w=radius
export const pos      = instancedArray(MAX_RESIDENT, 'vec4').setPBO(true); // xyz=base+overlay, w=radius
export const packAttr = instancedArray(MAX_RESIDENT, 'vec4');              // z = wobble phase seed

// Upload base from the EXISTING CPU derive (field-core.ts deriveVirtualField / worker).
// This is the single source of truth shared with sun-occlusion (§3.2).
export function seedBaseFromCPU(renderer: THREE.WebGPURenderer, derived: Float32Array /* xyzr*N */) {
  // write `derived` into base's backing store, then renderer marks it for upload.
  // (use the storage-buffer write API; base.setPBO(true) keeps the WebGL2 draw legal too.)
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
// inside WorldViewGPU useFrame / setAnimationLoop
originMeters.value.copy(ownShipMeters);
frameCounter.value += 1;
renderer.compute(genFieldOverlay);   // pipelined, NOT computeAsync-awaited (§3.3)
renderer.render(scene, camera);
```

### 8.6 Verification

1. **Boot:** with `?webgpu`, console shows the WebGPU adapter; without it (or no adapter), the WebGL2
   fallback renders unchanged.
2. **Zero-copy draw:** a single `InstancedMesh` of `MAX_RESIDENT` rocks draws from `pos`, no `setMatrixAt`,
   no per-chunk meshes.
3. **Base parity (the corrected gate):** `new Float32Array(await renderer.getArrayBufferAsync(base))` ===
   the CPU `deriveVirtualField` output **exactly** (same CPU source, so bit-identical), NOT "sub-meter after
   a GPU port." Add `scripts/bench/parity-base.ts`.
4. **Overlay bounded:** assert `|pos - base| ≤ 40m` for every slot (gameplay-invisible vs the 3-decimal
   bearing).
5. **No await stall:** the frame submits all compute in one `renderer.compute` call; verify no per-pass
   `computeAsync` in the hot path.

---

## 9. Open product decisions + what to prototype first

### 9.1 Open product decisions (gate before building the dependent milestone)

1. **Do collisions need to MATTER beyond cosmetic?** If yes, M7 promotion is required, and with it: deposit
   synthesis, fingerprint-collapse cost, two-body cascade promotion, demotion-during-contact, and a
   non-deterministic-GPU-result-becoming-shared-truth race. This is real netcode sized in the small. Default
   recommendation: **collisions are cosmetic; gameplay that must matter is server-simulated in the small.**
2. **Do minable rocks ever MOVE?** If no, the visual-only boundary holds and the authority problem dissolves.
   If yes → server-streamed sparse hot set (M7), never lockstep.
3. **Is the ship ever STOPPED/bounced by rocks?** That requires server ship-vs-asteroid collision
   (`ship-motion.ts` has none today) — a larger net-new piece than rule (d). Out of scope unless decided in.
4. **WebGL2 fallback longevity:** keep the CPU-derive path indefinitely, or set a WebGPU floor and drop
   legacy clients? Determines how long two code paths persist.
5. **`MAX_RESIDENT` default:** 50k client capacity vs the server `renderedLimit` default of 20000
   (`field.ts:35`) — pick the client cap independently and document it.

### 9.2 What to prototype first

**M0 + the base-parity gate**, exactly as Section 8. It proves the async gl factory, `extend(three/webgpu)`,
the CPU-base upload + zero-copy draw, and the floating-origin render node — with ZERO authority/post-stack
entanglement — and it establishes the corrected determinism discipline (`base` from CPU, overlay on GPU)
before any of it can calcify the wrong way. Immediately after, **M4's Blelloch prefix-sum spike** is the next
highest-risk unknown (research-grade TSL); prototype it in isolation against a parity test before M6 depends
on it.

---

## Appendix — source anchors (verified this pass)

- `field-core.ts:20-27` (`hashCell`, `noise = frac(sin·43758.5453)`); `:76` `virtualAsteroidAt`; `:103`
  `deriveVirtualField`; `:188-287` pack/unpack.
- `src/server/field.ts:27-37` (`fieldSeed=424242`, `cellSize=1130`, `cellsPerAxis=100`, `renderedLimit`
  default `"20000"`, `originOffset=-56500`); `:204-226` `virtualScanHits` (`bearing = unit(...)`); `:240-251`
  `virtualAsteroidAt`; `:304-325` `unit()`/`round()` (3-decimal quantization).
- `src/server/sim.ts:319-340` `mineDeposit` (`:326` "Asteroid not found", `:330-331` deposits row required,
  `:337-338` slack `radius+1400`); `:738` `virtualScanHits(ship.position, ship.scanPower, 52000, 10)`;
  `:755` scan `SELECT ... WHERE id = ?`.
- `src/server/db.ts:124` deposits FK `ON DELETE CASCADE`; `:191/196` only-world-seed INSERTs.
- `src/server/realtime.ts:347-353` `ASTEROIDS_FINGERPRINT` cell-stable fingerprint.
- `src/server/ship-motion.ts:96` `integrateShipTick` (pure thrust, zero asteroid awareness).
- `ScanPulseEffectImpl.ts:13-15, 28-30` (camera-at-origin `-getViewZ` assumption; NormalPass uniform).
- `WorldView.tsx:1018-1026` (`gl.info` instrumentation); `:1116-1169` `patchAsteroidShader`/`aSunlit`.
- `lighting.ts:5-30` (~2 lights); `sun-occlusion.ts:47-108` `computeSunlit` (the in-disguise froxel march).
- `docs/webgpu-asteroid-physics-rnd.md` (R&D baseline this doc extends).
