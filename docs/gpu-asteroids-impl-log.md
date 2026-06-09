# GPU-Resident Asteroid Field — Implementation Log (overnight autonomous run)

**Run date:** 2026-06-09 (overnight, unattended). **Branch:** `gpu-asteroids/impl` (off `ralph/client-render-100k`).
**Orchestrator:** Claude Opus 4.8. **Source of truth:** `docs/gpu-asteroids-architecture.md`.

> **READ THIS FIRST — the one fact that shaped the whole run:** there is **NO executable WebGPU in this
> environment.** `navigator.gpu` is absent in node, in Playwright's bundled Chromium, and in system Chrome
> (`channel:"chrome"`) — **headless AND headed** (the automation context has no GPU-backed display session).
> Probes: `scripts/bench/probe-webgpu.mjs`, `probe-webgpu-chrome.mjs`, `probe-webgpu-headed.mjs` — all report
> `{"gpu":false}`. Therefore **no live-GPU gate could be run tonight** (boot, `getArrayBufferAsync`, kernel
> dispatch, screenshots). I built to the gates that ARE runnable headless and flagged the rest. No fake green.

---

## DONE & VERIFIED (real, runnable gates — pasted output below)

### Baseline (clean tree, before any edits)
- `tsc --noEmit`: **exit 0, 0 errors.**
- `bun test tests/integration`: **54 pass / 1 fail.** The 1 failure is **pre-existing and NOT mine**:
  `tests/integration/server.test.ts:921` "diagnoses million-scale virtual asteroid index without
  materializing the field" expects `materializedAsteroids < 10000` but gets `407360`. This is a consequence
  of the earlier `renderedLimit 2000 → 50000` bump (commit `71b8596`). I did not touch it. After my work the
  suite is **79 pass / 1 fail** (+25 new GPU tests, all pass; same single pre-existing failure).

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
  render, the StrictMode double-mount path on a live device. Per its definition-of-done the *boot* itself is
  the gate and it cannot be exercised here — step 1 is **code-complete + statically verified, boot pending a
  real GPU.**

---

## HOW TO VERIFY THE GPU HALF IN THE MORNING (on a real GPU)

The CPU halves are green. To close the GPU-unverified gaps, run on a machine where Chrome has WebGPU
(`chrome://gpu` shows "WebGPU: Hardware accelerated"):

1. **Start the client dev server:** `bun run dev:client` (vite).
2. **Open the verification harness** in your real Chrome (NOT Playwright): `http://localhost:5173/gpu-verify.html`.
   It boots `WebGPURenderer`, seeds `base` via `deriveBase`+`seedBaseFromCPU`, reads it back with
   `getArrayBufferAsync(base)` and compares to the CPU bytes (the END-STATE step-3 gate), then dispatches the
   binner kernels and compares `cellStart`/`sortedItems` to `binCPU` (the END-STATE step-5 gate). It prints
   PASS/FAIL per gate to the page and console. *(Status: harness is code-complete and typechecks; it was
   authored but NOT run — no device here.)*
3. **Smoke-test the beachhead:** temporarily render `<WorldViewGPU />` from `App.tsx` (or a scratch entry) and
   confirm: console shows the WebGPU adapter; ~50k rocks draw from one InstancedMesh (no `setMatrixAt`); a
   non-WebGPU browser shows the unsupported message. Revert the App edit after.

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

- **Step 2 (TSL post stack + ScanPulse), Step 4 (ring streaming + GPU cull/LOD indirect), Step 6 (cosmetic
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

1. On a real GPU: run the morning verification (section above). If `gpu-verify.html` confirms the base
   round-trip and binner GPU-vs-CPU gates, steps 3 and 5 are FULLY closed.
2. Fix the known binner GPU gap (atomic view for the `scatter` cursor on `cellStart`) and re-run the GPU
   binner gate.
3. Proceed to **Step 2** (TSL post stack + ScanPulse) — the next linear step; needs a device for its
   screenshot gate. Then step 4, 6, 7 in order. Steps 1/3/5 foundations are committed.

---

## HONESTY CHECK — gates I could NOT run, and why

- **Every live-WebGPU gate** (boot, `getArrayBufferAsync(base)` round-trip, any kernel dispatch, ScanPulse/
  bloom screenshots, ring/cull indirect, 100k collision validation): UNVERIFIED — no `navigator.gpu` anywhere
  in this environment (proven by three probe scripts, headless and headed). Nothing GPU was claimed to pass.
- **What IS genuinely verified:** the determinism contract (base == CPU derive, bit-exact f32, non-circular);
  the Blelloch tiled-scan + scatter algorithm (CPU mirror == naive reference at real grid sizes); capability
  detection; the bounded-overlay invariant; project typecheck (strict) and production build with all GPU
  modules bundled; no regression to the existing app (working WebGL path untouched; tracked tree was clean
  before commits).
