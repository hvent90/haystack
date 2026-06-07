# Procedural SFX System for Haystack — Design Spec

> **Status:** Approved design (2026-06-07). Next step: implementation plan (writing-plans), then build in a worktree.
> **Scope:** A complete, programmatically-generated sound-effects bed for Haystack's browser-based space-flight sim — one-shot SFX, a real-time engine drone, and 3D spatialized remote-ship audio. No hand-authored audio asset files: every sound is generated from code.
> **Aesthetic target:** Elite-Dangerous-derived "weighty, designed" sci-fi, kept "mid-scifi grounded" to match `goal.md`. Deliberately polished audio over the goal's intentionally low-poly dev-art visuals.

---

## 1. Goal & constraints

Generate **all** SFX a flight sim needs, procedurally, in the browser, with the Web Audio API as the only audio substrate. Two senses of "programmatically generate," both required:

1. **Real-time procedural synthesis** at play-time — e.g. an engine drone whose pitch/volume/timbre track throttle, boost, heat, and cruise-lock.
2. **Code-defined one-shots** rendered to `AudioBuffer`s at init (and to `.wav` offline for review) — UI clicks, target-lock blips, docking chimes, etc. — so the repo ships **no hand-authored asset files**.

Hard constraints:

- Browser runtime; Web Audio API only (no native engine).
- TypeScript only, full strictness; `oxfmt`; Bun; integration tests (per `goal.md`).
- Lean dependencies — one small new dependency (`jsfxr`) is acceptable; no heavy framework (Tone.js rejected).
- Must integrate cleanly into the existing `src/client/eve/EveApp.tsx` event surface without putting audio logic in React components.

## 2. Decisions (locked)

| Decision | Choice | Rationale |
|---|---|---|
| **Scope of first pass** | Everything: one-shots + real-time engine drone + 3D spatialization | User call; full flight-sim bed in one pass. |
| **Synthesis approach** | **jsfxr cores + raw-Web-Audio layering** for one-shots; **hand-rolled raw Web Audio** for the continuous engine drone and ambience | jsfxr gives fast one-shot iteration; a raw-WA layering chain (filter/pitch/reverb/sub) sands off its chiptune character for the ED aesthetic. The drone needs per-frame param control, so it's hand-rolled. |
| **Player controls** | **Per-category mix**: master + engine / sfx / ui / alarm bus sliders + mute | User call; the bus graph is useful internally regardless. |
| **Library posture** | Raw Web Audio graph + `jsfxr` (one small MIT dep). No Tone.js, no Howler. | Howler is playback-only (no synthesis). Tone.js is too heavy for a lean codebase and reduces low-level control over voicing. |
| **3D audio** | Three.js `AudioListener` + `PositionalAudio` (wrappers over Web Audio `PannerNode`) | Already in the dep tree; integrates with object transforms. |
| **Asset strategy** | SFX defined as code; rendered to `AudioBuffer`s at runtime via `OfflineAudioContext`; a Playwright harness renders the same recipes to `.wav` for review/Discord | No hand-authored assets; `.wav` are derived artifacts for review only. |

## 3. Architecture

Framework-agnostic engine under `src/client/audio/` with a single imperative facade. React/EveApp only **calls** the facade and **feeds** it state; no audio logic in components.

```
src/client/audio/
  context.ts        — AudioContext lifecycle, gesture-unlock, suspend/resume
  buses.ts          — master -> {engine, sfx, ui, alarm} GainNodes; volume persistence (localStorage)
  synth/
    noise.ts        — white/pink/brown noise AudioBuffer generators (Math.random()*2-1 + shaping)
    filters.ts      — BiquadFilterNode helpers (bandpass/lowpass/highpass, sweeps)
    env.ts          — AR/ADSR gain envelopes via setValueAtTime + linearRampToValueAtTime
    voices.ts       — FM/subtractive voice builders (osc + filter + env composites)
    render.ts       — OfflineAudioContext "render graph -> AudioBuffer" utility
  sfx/
    catalog.ts      — every one-shot: jsfxr param struct (core) + raw-WA layering recipe
    pool.ts         — voice pool: reuse nodes, cap concurrency, no per-shot GC churn
  drone.ts          — hand-rolled continuous engine (throttle/boost/heat/cruise/speed driven)
  ambience.ts       — continuous low rumble bed
  spatial.ts        — AudioListener (on camera) + per-remote-ship PositionalAudio voices
  scheduler.ts      — "A Tale of Two Clocks" lookahead scheduler for repeating sounds
  events.ts         — PURE: game event / snapshot-diff -> audio action list (testable core)
  AudioEngine.ts    — facade: init/unlock/playOneShot/setEngineState/setRemoteShips/setBusVolume/dispose
  useAudio.ts       — React hook bridging EveApp <-> AudioEngine
  AudioControls.tsx — per-category mix UI (sliders + mute)
```

Bus graph: `master -> {engine, sfx, ui, alarm} -> destination`. Each bus is a `GainNode`; values persist to localStorage like the window layout.

**Why this shape:** the facade is the only EveApp touchpoint; `events.ts` holds the "what plays when" logic as pure functions (unit-testable without a browser); all synthesis internals are swappable behind the facade. Smaller, focused files reasoned about independently.

## 4. Data flow

Two channels into the facade:

- **Discrete events** — EveApp calls the facade at existing call sites:
  - boost (`sendBoostInput`) -> `playOneShot('boost')` + drone boost-mod
  - stabilize (`KeyX` flag in `buildFlightInput`) -> `brake`
  - scan (`runScan`) -> `honk`, then start `scanPulse` loop until report resolves
  - mine (`mineDeposit`) -> start `miningLaser`, stop on completion
  - dock / deploy / sell (`deployHab`, `sellAllCargo`) -> `chime`
  - target select (`setSelection`) -> `targetLock`
  - UI button/hover -> `uiClick` / `uiHover`
  - chat received (snapshot diff) -> `comms`
- **Continuous state** — fed every `flightInputIntervalMs` tick from the `myShip` snapshot:
  - `setEngineState({ throttle, boost, heat, cruiseLock, speed })` drives `drone.ts`
  - snapshot diffs in `events.ts` derive edge-triggered cues: heat crossing the ~96 lockout threshold -> `alarm`; new scan contacts -> `ping`; remote ship appears/leaves -> spawn/kill its positional engine voice.

## 5. SFX catalog (ED-derived recipes)

Every sound applies the distilled ED principles: **layer a tonal core over a filtered-noise body, add low-end weight, share one UI sonic family, parameterize by ship state.**

| Sound | Type | Recipe |
|---|---|---|
| **Engine drone** | continuous | sub sine (~30–60 Hz) + low saw (throttle->pitch+gain) + filtered brown-noise body (throttle->cutoff+gain); smoothed via `setTargetAtTime`. Keystone "feel" sound. |
| **Boost** | one-shot + mod | drone bright-noise swell + pitch bump; layered upward noise-sweep whoosh + sub thump |
| **Brake / stabilize** | one-shot | short filtered-noise burst + descending tone; heat-locked variant = dull clunk |
| **Heat / overheat alarm** | repeating | pulsing two-tone warning, lookahead-scheduled, intensifies toward lockout |
| **Scan honk** | one-shot | big resonant low->high sweep (the "honk") |
| **Scan pulse** | repeating | rhythmic filtered ping loop while scanning |
| **Mining laser** | continuous | gritty mid-band buzz + sub, modulated while mining |
| **Docking / gear / deploy** | one-shot | clean two-note tonal chime (UI family) |
| **Target-lock blip** | one-shot | short rising two-blip |
| **UI click / hover** | one-shot | tiny filtered transient, shared waveform/filter family |
| **Comms received** | one-shot | soft blip (UI family) |
| **Low rumble / ambience** | continuous | very-low filtered-noise bed under everything |

**UI sonic family:** click, hover, chime, target-lock, and comms share a waveform + filter family so the interface "sounds like one machine."

## 6. Spatialization

`AudioListener` mounts on the R3F camera in `WorldView`. My own ship's engine/UI/alarms are **non-positional** (first-person) on the buses. **Remote ships** get a lighter `PositionalAudio` engine drone attached to their mesh; mining beams are positional at their target. The floating-origin rebase (own ship pinned at origin, world ÷9000 around it) *helps*: the listener is at origin = me, and remote ships are already positioned relative to me, so panning/distance are correct without extra work.

## 7. Lifecycle, scheduling, performance (non-negotiables)

- **Autoplay unlock:** `AudioContext` starts suspended; `resume()` on first user gesture (pilot creation click / pointer-lock request already provide one). Subtle "audio off — click to enable" indicator until unlocked. Re-check `state === 'suspended'` on interaction; handle iOS/Safari resume edge cases.
- **Scheduling:** repeating sounds (alarm, scan pulse) use the lookahead "A Tale of Two Clocks" scheduler (setTimeout ~25 ms, schedule ~100 ms ahead against `AudioContext.currentTime`), not bare `setInterval`.
- **Performance:** voice pooling (no `new` node per shot -> avoids GC churn); prefer direct `.value` sets over `AudioParam` event chains except where smoothing is required (use `setTargetAtTime`/`linearRampToValueAtTime` only to kill zipper noise on drone params); cap concurrent voices.

## 8. "No hand-authored assets" + Discord review loop

SFX are **defined as code** (jsfxr param structs + layering recipes + drone params) and rendered to `AudioBuffer`s at runtime via `OfflineAudioContext` on init — nothing pre-baked ships in the repo. Separately, a render harness `src/cli/render-sfx.ts` runs the **same** recipes under **Playwright** (already a dep; `OfflineAudioContext` needs a browser) to dump `.wav` files into `samples/` for review. Those `.wav`s are DM'd to the user's Discord for aesthetic approval before deep integration. The continuous drone is reviewed via a short rendered capture rather than a single "sample" file. `samples/` is gitignored (derived artifacts).

## 9. Testing strategy

Matches the repo's verifier ethos (`bun run verify` = typecheck + format + integration; `verify:e2e` = Playwright).

- **bun unit tests:**
  - `events.ts` mapping (pure functions: event/state-diff -> audio action list)
  - parameter smoothing / mapping math (throttle->pitch curves, heat->alarm intensity)
  - catalog integrity: every game event maps to a sound; param structs valid
  - jsfxr cores render to non-silent buffers of expected length (jsfxr runs in pure JS — no browser)
- **Playwright tier:** reuse the render harness to assert layered/drone sounds render non-silent at expected durations.
- `typecheck` + `oxfmt` stay green throughout.

## 10. Dependencies

- **Add:** `jsfxr` (MIT). One-shot SFX core generation; renders in both browser and pure JS.
- **Reuse:** `three` (PositionalAudio/AudioListener), `playwright` (offline `.wav` render harness), `react` (thin bridge only).
- **Reject:** Tone.js (too heavy), Howler.js (playback-only, no synthesis).

## 11. Out of scope (this pass)

- Music / dynamic score (SFX only).
- Voice/VO.
- Reverb impulse-response asset files (procedural/algorithmic reverb only, to keep "no assets").
- Per-asteroid/material mining timbre variation (single mining sound first).

## 12. Open implementation questions (resolve during planning)

- Exact concurrent-voice cap and pool sizes for expected SFX density.
- Whether the physically-informed car-engine model (Baldan et al. 2015 / Antonio-R1) is worth retargeting vs. the simpler layered osc + filtered-noise drone — **default: simpler layered drone first.**
- Specific Safari/iOS resume workarounds for this game's lifecycle.
- The exact post-jsfxr layering chain per one-shot (reverb amount, sub-layer, pitch) to hit "polished, not chiptune."

---

## Sources (verified during research)

- MDN — Web Audio API *Advanced techniques* (noise, BiquadFilterNode, gain envelopes), *Best practices* (autoplay, library guidance), *Using AudioWorklet*, *Audio for Web Games*.
- jsfxr (chr15m) — canonical modern sfxr port; `toBuffer`/`toWave` offline generation.
- Bfxr (increpare) — sfxr lineage, subtractive synthesis + 12-waveform palette + ADSR/LP-HP model.
- Three.js docs — `PositionalAudio` (PannerNode-backed) + `AudioListener` setup.
- web.dev / Chris Wilson — "A Tale of Two Clocks" lookahead scheduling.
- Paul Adenot — Web Audio performance (dropouts, AudioParam cost, node pooling).
- designingsound.org — "100% synthesized SFX for stylized realism" (the translatable ED principle: tonal core + noise body, low-end weight, state-driven modulation).
- Matthew Florianz (Frontier audio designer, Elite Dangerous) — first-party ED sound-design reference.
