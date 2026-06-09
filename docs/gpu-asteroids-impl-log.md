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
