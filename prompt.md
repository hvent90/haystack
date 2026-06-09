# Handoff — GPU-Resident Asteroid Field (WebGPU migration) — **COMPLETE**

**Status: every un-gated architecture step (1–7) is built and device-verified.** This doc was the
working handoff; it now records the completed state. The deep references remain:

- `docs/gpu-asteroids-architecture.md` — the **authoritative end-state architecture** (WebGPU-only, no WebGL
  fallback ever). Build order was its **Section 7 (steps 1–9)**.
- `docs/gpu-asteroids-impl-log.md` — the **detailed implementation log**: every gate run, actual output,
  commit hashes, decisions, device-caught bugs (7 of them), and the honesty record.

**Branch:** `gpu-asteroids/impl` (off `ralph/client-render-100k`, which is off `main`). Tracked tree is clean.
**Never** push, open a PR, or merge to main without being asked.
**Completed:** 2026-06-09 (sessions 1–2 in the impl log).

---

## TL;DR of the final state

The game boots on WebGPU as the main app. The asteroid field is fully GPU-resident: `base` is CPU-authored
(bit-exact with the server derive, §3.2) and ring-streamed incrementally (id→slot reconcile, sub-range
uploads); per frame the overlay compute writes `pos = base + bounded wobble + capped gravity-well pull +
hard-capped collision offset`; a GPU cull/LOD pass compacts visible slots into per-LOD lists drawn by FOUR
`drawIndirect` calls (GPU-written instance counts, zero CPU in the cull); rocks tumble (Rodrigues
position+normal rotation); the TSL post stack (ScanPulse with the re-derived floating-origin basis → bloom →
ACES) is live; inter-asteroid collisions run first-class through the shared binner (27-cell deferred-apply
narrow phase, restitution, Nc==0 gating) — all cosmetic-tier, every displacement hard-capped inside the
radius+1400 m mine slack. 60 fps locked on Apple Metal with everything on; production-build movement bench:
721/721 frames at 16.7 ms across 13 cell crossings.

**Steps 8 (promotion authority netcode) and 9 (froxel volumetrics) remain correctly UN-BUILT per the hard
gates and the ratified cosmetic-only decisions (§9.1).**

## The standing gates (all green, re-runnable)

```bash
bun run verify            # typecheck + format + 115 integration tests
                          #   (+1 pre-existing server.test.ts:921 failure, NOT ours — see impl log)
bun run verify:gpu        # 6 on-device gates: base round-trip, binner scan+scatter, cull/LOD,
                          #   overlay bound (wobble+wells), collisions vs dense belt
                          #   PASS on SwiftShader AND real Metal (CHROME_PATH=<chrome>)
bun run verify:gpu-live   # live game: 2K screenshots (HUD-on + HUD-off field/scan), console,
                          #   perf trace, 60fps frame stats, V-key ScanPulse visual gate
bun run verify:gpu-live:prod   # same against the PRODUCTION build (vite build + preview)
bun run bench:gpu-cross[:prod] # movement bench: forces cell crossings, per-cross stats,
                          #   optional CDP trace (CROSS_TRACE=1) / V8 profile (CROSS_PROFILE=1)
```

## What the original open work became (all closed)

1. **"158 ms hitch per cell-crossing" — misattributed, root-caused, fixed.** It was the one-time
   first-paint SYNCHRONOUS derive (the worker was bypassed on first field), not a per-cross cost. Fixed:
   boot derive goes through the worker; step-4 ring streaming (incremental id→slot reconcile + sub-range
   uploads) replaced the full 50k repack. Live gate: `fieldDeriveMs` 164.8 → 9.4, `worstCellCrossFrameMs`
   174.1 → 20.0.
2. **"42.9 ms React task" — dev-mode artifact.** react-dom development's performance-track props diffing
   over the 50k array (plus the GC storm it causes) produced 1.0–1.8 s stalls in the DEV harness only.
   Production: zero frames over 33 ms. Perf claims must cite the `:prod` harnesses.
3. **Step 2 (TSL post stack + ScanPulse)** — live, with the §5 trap handled (player-distance basis
   re-derived from depth + camera world matrix; the player IS the scene origin; NOT `-getViewZ`) and a
   screenshot gate (idle vs mid-pulse teal counts).
4. **Cleanup** — legacy WebGL path deleted (AsteroidChunk/patchAsteroidShader/createAsteroidMaterial/
   field-chunks.ts), AudioContext teardown guard (0 warnings), 404 URLs logged, HUD-off captures,
   trace-analysis/ gitignored.
5. **Step 4 remainder** — GPU cull/LOD + indirect draws + TSL aSunlit two-tier shadow (`receivedShadowNode`
   blend, sun-occlusion march computed in the field worker and cache-primed). `setIndirect` works on three
   0.177.
6. **Step 6** — per-rock tumble + K=6 deterministic gravity wells (pull hard-capped at 320 m).
7. **Step 7** — first-class cosmetic collisions (see impl log for the bound reconciliation).

## HARD GATES — still in force

- **Step 8 (promotion authority netcode) — GATED.** §9.1 decisions were ratified cosmetic-only. Do not
  build unless a human reverses Decision #1.
- **Step 9 (froxel volumetric lighting) — future/additive.** Do not build it.
- **Never change server authority, the wire protocol, or gameplay STATE.** Gameplay reads `base`; only the
  renderer reads `pos`. `base` is CPU-authored, never a GPU `frac(sin)` kernel (the parity gates guard it).
- **Never reintroduce a WebGL path.**

## ENVIRONMENT GOTCHAS (unchanged, still load-bearing)

- WebGPU needs a SECURE CONTEXT (`localhost`/`127.0.0.1`/https) — absent on `about:blank`/LAN IPs.
- Headless WebGPU: bundled Playwright Chromium = SwiftShader; `CHROME_PATH=<system Chrome>` = real Metal.
- three is pinned `^0.177` — `setIndirect`/`IndirectStorageBufferAttribute`/`receivedShadowNode`/
  `transformNormalToView` all work; `bloom` is in `three/addons`, NOT `three/tsl`.
- GPU bugs hide from CPU tests — SEVEN were device-caught (see the impl log's honesty record), including:
  WebGPU's default 8-storage-buffers-per-stage limit, a storage/atomic read as a TSL Loop `end` emitting
  empty WGSL, and nested TSL Loops silently corrupting cross-scope loop-variable references (WGSL
  shadowing). Always close the loop with `verify:gpu`/`verify:gpu-live`.
- Tests/CLI run under `bun`; `tsconfig` strict; code under `scripts/` is NOT typechecked.
- The `verify` script exits 1 on the pre-existing `server.test.ts:921` failure (renderedLimit bump fallout,
  commit `71b8596`) — the honest baseline is "all pass except that one".

## KEY FILE MAP (final)

```
src/client/eve/gpu/
  buffers.ts           # MAX_RESIDENT + instancedArray buffers (base/pos/packAttr/slotMeta) + backing helpers
  base-derive.ts       # CPU derive -> buffer images (incl. aSunlit in packAttr.w); seed/sub-range uploads
  ring-stream.ts       # step-4 ring streaming: incremental id->slot reconcile + dirty ranges
  wells.ts             # step-6 gravity wells: deterministic derivation + bounded pull (CPU mirror)
  cull-cpu.ts          # step-4 CPU spec: frustum planes + distance cull + LOD banding
  collide-cpu.ts       # step-7 CPU spec: deferred narrow phase + capped apply
  binner-cpu.ts        # step-5 CPU spec: tiled Blelloch scan + scatter
  capability.ts        # hasWebGPU/assertWebGPU (refuses non-WebGPU)
  renderer-factory.ts  # async R3F WebGPU gl factory + StrictMode double-init guard
  verify-gpu.ts        # the 6 on-device gates
  verify-entry.ts      # DOM entry for gpu-verify.html
  kernels/
    overlay.ts         # pos = base + wobble + well pull + collision offset; setGravityWells
    render-node.ts     # LOD material: positionNode via compacted lists, tumble, aSunlit shadow
    cull.ts            # clearCull/cull/publishCounts + per-LOD indirect args
    collide.ts         # collision pipeline: binner instance + narrow + apply (+ collOffset/collVel)
    binner.ts          # TSL count/scan/scatter (now with itemActive predicate)
src/client/eve/components/ScenePostProcessing.tsx  # step-2 TSL post stack (ScanPulse+bloom+ACES)
src/client/eve/components/WorldView.tsx            # the game Canvas: ring effect + per-frame dispatches
src/client/eve/field-worker.ts                     # off-thread derive + pack + sunlit march
src/client/eve/field-derivation.ts                 # worker-first derive (incl. boot), sunlit cache prime
scripts/bench/gpu-verify-run.mjs                   # runner for verify:gpu
scripts/bench/gpu-live-loop.mjs                    # runner for verify:gpu-live (+ GPU_LIVE_PROD/HUD)
scripts/bench/gpu-cross-bench.mjs                  # movement bench (+ CROSS_TRACE / CROSS_PROFILE)
```

Server parity anchors (do not break): `src/client/eve/field-core.ts` (`deriveVirtualField`),
`src/server/field.ts`, `src/server/sim.ts` (`mineDeposit`, `ASTEROIDS_FINGERPRINT`),
`src/shared/ship-motion.ts`.

## If you pick this up next

The architecture's remaining items are the two gated steps (8, 9 — need a human decision) and optional
hardening: a 100k-field movement bench (`GPU_LIVE_LIMIT=100000 bun run bench:gpu-cross:prod`), 2-substep
collisions (§4.4), and an in-game authored dense belt (the gate-level belt already validates the kernels).
