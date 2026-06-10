# Task: Asteroids shadowing other asteroids

I'm building haystack, a multiplayer space game (Three.js/R3F on WebGPU, bun, 1 unit = 1 km). I want the asteroid field to read as a real, physically-lit deep field: rocks visibly casting sun shadows on each other — nearby rocks with crisp per-pixel shadows, and the far field (out to tens of thousands of rocks) still mutually shadowing so the depth reads. The end state I care about: I fly through the field and see asteroids darken each other from the sun's direction, at every distance, at 60 fps, and it looks good.

Your job is to take this from wherever it currently is to **done and visually verified**, end to end.

## Context you should read first

- `docs/superpowers/specs/2026-06-07-asteroid-inter-shadowing-design.md` — the approved design
  (two-tier: per-instance sun-occlusion scalar for the deep field + a near-camera shadow-map
  bubble). **Caveat:** this doc was written against the old WebGL renderer, two days before the
  WebGPU migration landed. Treat its _intent and mechanism_ (the two tiers, the occlusion march,
  the brightness/density coupling, the testing ideas) as authoritative; treat its _file-level
  instructions_ (onBeforeCompile chunk patching, near/far InstancedMesh split, etc.) as obsolete
  where the new architecture already solved the same problem differently.
- `docs/gpu-asteroids-architecture.md` and `docs/gpu-asteroids-impl-log.md` — the current
  GPU-resident architecture (branch `gpu-asteroids/impl`) and the honest record of what was built
  and what bugs only showed up on-device.
- Pieces of this feature already exist in some form: a sun-occlusion march
  (`src/client/eve/sun-occlusion.ts`, computed in the field worker), an `aSunlit` value carried
  per instance, a `receivedShadowNode` blend in `src/client/eve/gpu/kernels/render-node.ts`, and
  shadow-light setup in `SceneLighting.tsx`. **Do not assume any of it actually works visually.**
  Part of your job is to determine what's real: whether the shadow map actually receives the
  GPU-driven asteroids (indirect draws + custom positionNode and the depth pass are a classic
  silent-failure pair), whether `aSunlit` produces visible inter-shadowing in the live game, and
  whether the tuning (march depth vs. field density) makes the deep field look right rather than
  uniformly black or uniformly lit. Diagnose first with your own eyes (screenshots), then fix or
  build what's missing.

## Hard constraints

- Never change server authority, the wire protocol, or gameplay state. Gameplay reads `base`;
  only the renderer reads `pos`. `base` stays CPU-authored (parity gates guard this).
- WebGPU only — never reintroduce a WebGL path. Steps 8 (promotion netcode) and 9 (froxels) of
  the architecture are hard-gated; don't build them.
- Zero-ambient vacuum look is intentional: a fully shadowed face goes to true black. Don't add
  ambient light to "fix" darkness.
- Shadow cost must stay decoupled from total rock count and the 60 fps budget must hold.
- Never push, open a PR, or merge without being asked. Commit locally as you go with clear
  messages.

## Verification (this is where past sessions won or lost)

- GPU bugs hide from CPU tests — seven were device-caught in this codebase. Close every loop on
  a real device: `bun run verify` (one pre-existing `server.test.ts:921` failure is the honest
  baseline), `bun run verify:gpu` (on-device gates; `CHROME_PATH=<system Chrome>` for real Metal
  instead of SwiftShader), `bun run verify:gpu-live[:prod]` (live game screenshots + frame
  stats), `bun run bench:gpu-cross[:prod]` (movement bench). Dawn errors are JS-silent — always
  read the captured browser console.
- Perf claims must cite the `:prod` harnesses (dev-mode react instrumentation fabricates stalls)
  — but the user plays in dev mode, so a dev-only hitch is still a real bug.
- "It compiles and the blend node exists" is not done. Done means screenshots from the live game
  showing inter-asteroid shadows near (crisp) and far (per-rock), no acne, no pop at the
  near/far handoff, and the deep field varied rather than a black or bright wall. Add a
  repeatable gate for this so it can't silently regress.
- Before reporting progress, audit each claim against a tool result from this session. Only
  report work you can point to evidence for; if something is not yet verified, say so. If tests
  fail, say so with the output.
- Establish a method for checking your own work as you build; periodically verify with
  fresh-context subagents against the design's goals rather than trusting your own summary of
  what you did.

## Working style

- You are operating autonomously over a long trajectory. When you have enough information to
  act, act. Don't re-litigate the approved design direction or ask permission for reversible
  steps that follow from this task. Pause only for destructive actions, real scope changes, or
  input only the user can provide — and if blocked, say exactly what you need.
- The look is the deliverable, and tuning is expected work, not a bug: the design doc explains
  that march depth, rock size, and density jointly set how dark the deep field gets. Iterate
  with screenshots until it reads well. Asteroid size/density are yours to adjust if the field
  doesn't read.
- Don't add features, refactors, or abstractions beyond what the task requires.
- Known device-bug patterns worth respecting (from the impl log): the 8-storage-buffers-per-
  stage default limit; TSL `Loop` with a storage/atomic read as the loop end emitting empty
  WGSL; nested TSL loops corrupting cross-scope variables (flatten and `.toVar()`); cosmetic
  GPU motion must be a smooth function of time, never a per-frame hash.
- Keep notes: append decisions, gate outputs, and device-caught surprises to
  `docs/gpu-asteroids-impl-log.md` as you go, one honest entry per work session — the log's
  value is that it records what actually happened, including failures.
- Final summary: write it for someone who saw none of the work. Lead with the outcome in plain
  sentences, attach the evidence (screenshots, gate output), then anything you need from me.
