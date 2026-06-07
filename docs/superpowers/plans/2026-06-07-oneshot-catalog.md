# One-Shot SFX Catalog Implementation Plan (Plan 2 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Fill out the remaining one-shot SFX (`uiHover`, `targetLock`, `comms`, `boost`, `brake`, `scanHonk`, `chime`) as code-defined recipes, register them so they render, play, verify, and DM as `.wav`, and trigger them at the right EveApp sites.

**Architecture:** Each sound is a `OneShotRender` (the interface from Plan 1: `{ durationSeconds, build(ctx, destination, startTime) }`). Two recipe styles: **pure raw-Web-Audio** (oscillators + noise + filters + envelopes, like `uiClick`) and **jsfxr-core + raw-WA layering** (decode a fixed jsfxr sound into an AudioBuffer, then filter/shape it in the offline graph). All are rendered offline to cached `AudioBuffer`s and played through the appropriate bus.

**Tech Stack:** Same as Plan 1. jsfxr API (confirmed v1.4.1, see `tests/audio/jsfxr.test.ts` + `src/types/jsfxr.d.ts`): `sfxr.toWave(synthdef).buffer` is normalized floats in [-1..1] at 44100 Hz — use THAT (not `toBuffer`, which is byte pairs) to build AudioBuffers.

**Spec:** `docs/superpowers/specs/2026-06-07-procedural-sfx-design.md` §5 (catalog) and §3.

> **Working dir:** worktree `/Users/hv/repos/haystack-procedural-sfx`, branch `procedural-sfx`. After every task: `bun run typecheck` + `bunx oxfmt .` must pass before commit. These recipes are FIRST-PASS aesthetic guesses — they will be tuned by ear after the controller DMs the rendered batch; correctness here means "renders non-silent at the right duration on the right bus," not "final voicing."

---

## Design notes the implementer must honor

- **UI sonic family** (`uiClick`, `uiHover`, `targetLock`, `comms`, `chime`): keep them tonally related — same general band (highpassed, bright, short) so the interface "sounds like one machine." `uiClick` already exists as the reference.
- **Low-end weight** on `boost` and `brake` (sub layer ~40–70 Hz) — these are ship-mass sounds, not UI.
- **`scanHonk`** is the big diegetic "honk": a resonant low→high sweep, longer (~0.6 s), goes on the `sfx` bus.
- jsfxr cores suit `targetLock`/`boost`/`brake` (transient, gritty); pure raw-WA suits the tonal `comms`/`chime`/`scanHonk`/`uiHover`. The implementer may choose per sound, but must justify in the commit body.
- Bus assignment: `uiHover`,`targetLock`,`comms`,`chime` → `ui`; `boost`,`brake`,`scanHonk` → `sfx`.

---

## Task 1: jsfxr-core → AudioBuffer helper

**Files:**
- Create: `src/client/audio/sfx/jsfxrCore.ts`

- [ ] **Step 1: Implement the helper**

Decode a fixed jsfxr sound definition into an AudioBuffer usable inside an offline graph. Use `sfxr.toWave(def).buffer` (normalized floats). A "fixed def" is a plain params object (NOT `sfxr.generate`, which randomizes) so durations are stable.

Create `src/client/audio/sfx/jsfxrCore.ts`:

```ts
import { sfxr } from "jsfxr";

/**
 * Build an AudioBuffer from a fixed jsfxr sound definition.
 * Uses sfxr.toWave(def).buffer (normalized floats in [-1..1] at 44100 Hz) so the
 * core can be layered/filtered in an OfflineAudioContext graph. `def` MUST be a
 * concrete params object (not sfxr.generate, which randomizes) for stable output.
 */
export function jsfxrCoreToBuffer(ctx: BaseAudioContext, def: object): AudioBuffer {
  const wave = sfxr.toWave(def);
  const floats = wave.buffer;
  const length = Math.max(1, floats.length);
  const buffer = ctx.createBuffer(1, length, 44100);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i += 1) {
    data[i] = floats[i] ?? 0;
  }
  return buffer;
}
```

- [ ] **Step 2: Confirm jsfxr's fixed-def shape**

Inspect the installed package to learn the exact params-object schema for a fixed def (look at `src/types/jsfxr.d.ts`, `node_modules/jsfxr/*.mjs`, and how `toWave` accepts input — it may accept a `Params`-like object or a serialized string). Write a tiny throwaway check (`bun -e "..."`) confirming `jsfxrCoreToBuffer`-style decoding yields a non-empty float array for one concrete def. Record the confirmed def schema as a comment at the top of `jsfxrCore.ts`. Remove the throwaway.

- [ ] **Step 3: Typecheck + format + commit**

```bash
bun run typecheck && bunx oxfmt src/client/audio/sfx/jsfxrCore.ts
git add src/client/audio/sfx/jsfxrCore.ts
git commit -m "feat(audio): add jsfxr-core to AudioBuffer decode helper"
```

---

## Task 2: Add the seven one-shot recipes

**Files:**
- Modify: `src/client/audio/sfx/catalog.ts`

- [ ] **Step 1: Add recipes**

Append seven `OneShotRender` exports to `src/client/audio/sfx/catalog.ts`, reusing the Plan 1 helpers (`createNoiseBuffer`, `createBandpass/Lowpass/Highpass`, `applyAr`) and the new `jsfxrCoreToBuffer` where a jsfxr core is chosen. Below are concrete first-pass recipes. Implement each so it renders non-silent for its full `durationSeconds`. Connect every source through a `GainNode` with an `applyAr` envelope into `destination`, and `start(t0)`/`stop` within the duration. For oscillators use `ctx.createOscillator()`; for frequency sweeps use `osc.frequency.setValueAtTime` + `exponentialRampToValueAtTime`.

```ts
// uiHover — softer, shorter sibling of uiClick (UI family)
export const uiHover: OneShotRender = {
  durationSeconds: 0.05,
  build(ctx, destination, t0) {
    const src = ctx.createBufferSource();
    src.buffer = createNoiseBuffer(ctx, 0.05, "white");
    const band = createBandpass(ctx, 3200, 4);
    const high = createHighpass(ctx, 1800);
    const gain = ctx.createGain();
    src.connect(band);
    band.connect(high);
    high.connect(gain);
    gain.connect(destination);
    applyAr(gain.gain, t0, 0.002, 0.003, 0.04, 0.35);
    src.start(t0);
    src.stop(t0 + 0.05);
  },
};

// targetLock — rising two-blip (UI family): two short sine blips, second higher
export const targetLock: OneShotRender = {
  durationSeconds: 0.22,
  build(ctx, destination, t0) {
    const blip = (start: number, freq: number): void => {
      const osc = ctx.createOscillator();
      osc.type = "square";
      osc.frequency.value = freq;
      const high = createHighpass(ctx, 600);
      const gain = ctx.createGain();
      osc.connect(high);
      high.connect(gain);
      gain.connect(destination);
      applyAr(gain.gain, start, 0.004, 0.02, 0.05, 0.4);
      osc.start(start);
      osc.stop(start + 0.09);
    };
    blip(t0, 880);
    blip(t0 + 0.11, 1320);
  },
};

// comms — soft single blip (UI family): sine + gentle env
export const comms: OneShotRender = {
  durationSeconds: 0.18,
  build(ctx, destination, t0) {
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(660, t0);
    osc.frequency.exponentialRampToValueAtTime(990, t0 + 0.12);
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(destination);
    applyAr(gain.gain, t0, 0.01, 0.04, 0.12, 0.3);
    osc.start(t0);
    osc.stop(t0 + 0.18);
  },
};

// chime — clean two-note tonal chime (UI family, docking/deploy)
export const chime: OneShotRender = {
  durationSeconds: 0.7,
  build(ctx, destination, t0) {
    const note = (start: number, freq: number, dur: number): void => {
      const osc = ctx.createOscillator();
      osc.type = "triangle";
      osc.frequency.value = freq;
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(destination);
      applyAr(gain.gain, start, 0.005, 0.05, dur, 0.4);
      osc.start(start);
      osc.stop(start + dur + 0.06);
    };
    note(t0, 587.33, 0.3); // D5
    note(t0 + 0.16, 880, 0.45); // A5
  },
};

// boost — upward noise-sweep whoosh + sub thump (ship mass, sfx bus)
export const boost: OneShotRender = {
  durationSeconds: 0.6,
  build(ctx, destination, t0) {
    // noise sweep
    const noise = ctx.createBufferSource();
    noise.buffer = createNoiseBuffer(ctx, 0.6, "white");
    const lp = createLowpass(ctx, 400, 1);
    lp.frequency.setValueAtTime(400, t0);
    lp.frequency.exponentialRampToValueAtTime(6000, t0 + 0.4);
    const nGain = ctx.createGain();
    noise.connect(lp);
    lp.connect(nGain);
    nGain.connect(destination);
    applyAr(nGain.gain, t0, 0.05, 0.15, 0.35, 0.5);
    noise.start(t0);
    noise.stop(t0 + 0.6);
    // sub thump
    const sub = ctx.createOscillator();
    sub.type = "sine";
    sub.frequency.setValueAtTime(70, t0);
    sub.frequency.exponentialRampToValueAtTime(45, t0 + 0.3);
    const sGain = ctx.createGain();
    sub.connect(sGain);
    sGain.connect(destination);
    applyAr(sGain.gain, t0, 0.01, 0.08, 0.25, 0.7);
    sub.start(t0);
    sub.stop(t0 + 0.5);
  },
};

// brake — short filtered-noise burst + descending tone (ship mass, sfx bus)
export const brake: OneShotRender = {
  durationSeconds: 0.35,
  build(ctx, destination, t0) {
    const noise = ctx.createBufferSource();
    noise.buffer = createNoiseBuffer(ctx, 0.35, "brown");
    const bp = createBandpass(ctx, 500, 1.2);
    const nGain = ctx.createGain();
    noise.connect(bp);
    bp.connect(nGain);
    nGain.connect(destination);
    applyAr(nGain.gain, t0, 0.005, 0.05, 0.25, 0.55);
    noise.start(t0);
    noise.stop(t0 + 0.35);
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(300, t0);
    osc.frequency.exponentialRampToValueAtTime(90, t0 + 0.25);
    const oGain = ctx.createGain();
    const lp = createLowpass(ctx, 1200, 0.7);
    osc.connect(lp);
    lp.connect(oGain);
    oGain.connect(destination);
    applyAr(oGain.gain, t0, 0.005, 0.04, 0.2, 0.4);
    osc.start(t0);
    osc.stop(t0 + 0.3);
  },
};

// scanHonk — big resonant low->high sweep (diegetic, sfx bus)
export const scanHonk: OneShotRender = {
  durationSeconds: 0.6,
  build(ctx, destination, t0) {
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(120, t0);
    osc.frequency.exponentialRampToValueAtTime(900, t0 + 0.45);
    const bp = createBandpass(ctx, 600, 8);
    bp.frequency.setValueAtTime(300, t0);
    bp.frequency.exponentialRampToValueAtTime(1800, t0 + 0.45);
    const gain = ctx.createGain();
    osc.connect(bp);
    bp.connect(gain);
    gain.connect(destination);
    applyAr(gain.gain, t0, 0.03, 0.3, 0.25, 0.5);
    osc.start(t0);
    osc.stop(t0 + 0.6);
  },
};
```

If the implementer chooses a jsfxr core for any of `targetLock`/`boost`/`brake` instead of the pure recipe above, replace that export's body with a `jsfxrCoreToBuffer(ctx, FIXED_DEF)` source through the same envelope/filter layering, keep the same `durationSeconds` (±0.05), and note the swap in the commit body.

- [ ] **Step 2: Typecheck + format + commit**

```bash
bun run typecheck && bunx oxfmt src/client/audio/sfx/catalog.ts
git add src/client/audio/sfx/catalog.ts
git commit -m "feat(audio): add seven one-shot SFX recipes (UI family + ship + scan)"
```

---

## Task 3: Register the sounds in the engine + render entry

**Files:**
- Modify: `src/client/audio/AudioEngine.ts`
- Modify: `src/client/audio/renderEntry.ts`

- [ ] **Step 1: Register in AudioEngine**

In `src/client/audio/AudioEngine.ts`, import the new recipes and extend the `ONE_SHOTS` map with the correct bus per sound:

```ts
import {
  boost,
  brake,
  chime,
  comms,
  scanHonk,
  targetLock,
  uiClick,
  uiHover,
  type OneShotRender,
} from "./sfx/catalog";
```

```ts
const ONE_SHOTS: Partial<Record<OneShotId, OneShotEntry>> = {
  uiClick: { spec: uiClick, bus: "ui" },
  uiHover: { spec: uiHover, bus: "ui" },
  targetLock: { spec: targetLock, bus: "ui" },
  comms: { spec: comms, bus: "ui" },
  chime: { spec: chime, bus: "ui" },
  boost: { spec: boost, bus: "sfx" },
  brake: { spec: brake, bus: "sfx" },
  scanHonk: { spec: scanHonk, bus: "sfx" },
};
```

- [ ] **Step 2: Render all sounds in renderEntry**

In `src/client/audio/renderEntry.ts`, import all recipes and render each to a named sample:

```ts
import { boost, brake, chime, comms, scanHonk, targetLock, uiClick, uiHover } from "./sfx/catalog";
import { renderOneShot } from "./sfx/renderOneShot";
```

Replace the body of `renderSamples` so it renders every sound:

```ts
const RECIPES = { uiClick, uiHover, targetLock, comms, chime, boost, brake, scanHonk };

export async function renderSamples(): Promise<RenderedSample[]> {
  const out: RenderedSample[] = [];
  for (const [name, spec] of Object.entries(RECIPES)) {
    const buffer = await renderOneShot(spec);
    out.push({ name, sampleRate: SAMPLE_RATE, pcm: Array.from(buffer.getChannelData(0)) });
  }
  return out;
}
```

- [ ] **Step 3: Typecheck + format + commit**

```bash
bun run typecheck && bunx oxfmt src/client/audio/AudioEngine.ts src/client/audio/renderEntry.ts
git add src/client/audio/AudioEngine.ts src/client/audio/renderEntry.ts
git commit -m "feat(audio): register all one-shots in engine and render entry"
```

---

## Task 4: Verification — durations + non-silence for all sounds

**Files:**
- Modify: `tests/e2e/audio.ts`

- [ ] **Step 1: Extend expected durations**

In `tests/e2e/audio.ts`, expand `EXPECTED_DURATION_SECONDS` to cover all eight sounds (values must match each recipe's `durationSeconds`):

```ts
const EXPECTED_DURATION_SECONDS: Record<string, number> = {
  uiClick: 0.08,
  uiHover: 0.05,
  targetLock: 0.22,
  comms: 0.18,
  chime: 0.7,
  boost: 0.6,
  brake: 0.35,
  scanHonk: 0.6,
};
```

Note: jsfxr-cored sounds (if the implementer swapped any in) produce a buffer whose length is set by jsfxr, which may not equal `durationSeconds`. If so, loosen the duration assertion for THOSE names to `< 0.1s` tolerance OR drive the expected value from the rendered length with a sanity floor — but keep the non-silence assertion strict. Document the choice in a comment.

- [ ] **Step 2: Run verification**

Run: `bun tests/e2e/audio.ts`
Expected: `audio verification passed: 8 sample(s)`, exit 0. If any sound is silent (peak ≤ 0.02) or wrong duration, fix the recipe in `catalog.ts` until it passes — do not weaken non-silence.

- [ ] **Step 3: Full verify**

Run: `bun run verify`
Expected: PASS (typecheck + format + integration + audio unit tests).

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/audio.ts
git commit -m "test(audio): verify all eight one-shots render non-silent at expected duration"
```

---

## Task 5: Trigger the sounds at EveApp event sites

**Files:**
- Modify: `src/client/eve/EveApp.tsx`

Wire `audio.engine.playOneShot(...)` into the existing handlers. Read each function first to confirm the anchor, then add the call as shown.

- [ ] **Step 1: targetLock on selection**

In `EveApp`, the selection setter is `setSelection` (a `useState` setter passed around). Add a wrapper `selectTarget` near the other handler functions and use it where a user actively selects a contact (the `onSelect` props on `WorldView`, `ScannerWindow`, and `ContextMenu`). Add:

```ts
  function selectTarget(next: Selection | null): void {
    if (next !== null) {
      audio.engine.playOneShot("targetLock");
    }
    setSelection(next);
  }
```

Then replace `onSelect={setSelection}` with `onSelect={selectTarget}` on `WorldView` (line ~501), `ScannerWindow` (line ~564), and `ContextMenu` `onSelect` (line ~660). Leave internal/auto `setSelection` calls (e.g. inside `runScan`) untouched — those are not user selections.

- [ ] **Step 2: scanHonk on scan**

In `runScan` (the `void withAction("scan", ...)` function), add as the first statement inside `runScan` (before `withAction`):

```ts
    audio.engine.playOneShot("scanHonk");
```

- [ ] **Step 3: boost on boost**

In `sendBoostInput`, add as the first statement:

```ts
    audio.engine.playOneShot("boost");
```

- [ ] **Step 4: chime on deploy/dock and sell**

In `deployHab`, add as the first statement:

```ts
    audio.engine.playOneShot("chime");
```

- [ ] **Step 5: comms on new chat received**

In the existing `useEffect` that tracks added chat messages (the one computing `added` from `previousChatIdsRef`), inside the `if (added.length === 0) { return; }` guard's fall-through (i.e., when `added.length > 0`), add — but only when the messages aren't from the local pilot to avoid self-blips:

```ts
    const fromOthers = added.some((message) => message.fromPilotId !== session?.pilot.id);
    if (fromOthers) {
      audio.engine.playOneShot("comms");
    }
```

Place this after `previousChatIdsRef.current = nextIds;` and the early return. Confirm `session` is in scope in that effect (it is — it's a component-level value).

- [ ] **Step 6: brake on stabilize**

Stabilize is the `KeyX` flag in `buildFlightInput` (continuous input), not a discrete handler — wiring it cleanly needs an edge-detect that belongs in Plan 3's continuous path. For Plan 2, instead trigger `brake` from the HUD/Flight "stabilize"/all-stop button if one calls `setFlightThrottle(0, true)`. Add `audio.engine.playOneShot("brake");` as the first statement of `setFlightThrottle` ONLY when `value === 0` and `sendNow === true`:

```ts
  function setFlightThrottle(value: number, sendNow = false): void {
    if (value === 0 && sendNow) {
      audio.engine.playOneShot("brake");
    }
    const next = clamp(value, -1, 1);
    // ...rest unchanged
  }
```

- [ ] **Step 7: uiHover on Neocom buttons (optional polish)**

If `Neocom` exposes per-button hover easily, add `onMouseEnter={() => audio.engine.playOneShot("uiHover")}`. If it requires prop-drilling through `Neocom`, SKIP for Plan 2 (note it) — `uiHover` still renders/verifies; it just isn't triggered yet.

- [ ] **Step 8: Typecheck + format + commit**

```bash
bun run typecheck && bunx oxfmt src/client/eve/EveApp.tsx
git add src/client/eve/EveApp.tsx
git commit -m "feat(audio): trigger one-shots at scan/boost/dock/select/comms/brake sites"
```

---

## Task 6: Render the batch for review

**Files:** none (artifact generation)

- [ ] **Step 1: Render all sounds to wav**

Run: `bun run render:sfx`
Expected: eight lines `wrote .../samples/<name>.wav (<frames> frames, peak <p>)`, every peak > 0.02. The eight `.wav`s exist under `samples/` (gitignored).

- [ ] **Step 2: Report**

Report the eight filenames, their frame counts and peaks, and confirm `bun run verify` + `bun tests/e2e/audio.ts` both pass. The controller will DM the batch for aesthetic review and tuning.

---

## Self-review notes (author)

- **Spec coverage:** spec §5 one-shots — uiClick (Plan 1) + uiHover, targetLock, comms, chime, boost, brake, scanHonk (this plan) ✓. Continuous sounds (engine drone, mining, ambience), the repeating alarm/scan-pulse scheduler, and 3D spatialization are Plan 3 — explicitly out of scope here.
- **UI family / low-end-weight / honk** design principles encoded in the recipes and the "Design notes" section.
- **Placeholder scan:** recipes are complete code; the only intentional latitude is the optional jsfxr-core swap and the optional `uiHover` trigger, both with explicit fallback instructions.
- **Type consistency:** reuses `OneShotRender`, `OneShotId`, `OneShotEntry`, `RenderedSample`, `renderSamples` from Plan 1 unchanged; new `jsfxrCoreToBuffer` is the only added symbol.
- **Known risk:** jsfxr fixed-def schema (Task 1 Step 2) — must be confirmed against the installed package before relying on a core; the pure raw-WA recipes have zero jsfxr dependency so the batch can ship even if jsfxr cores are deferred.
- **Aesthetic caveat:** these are first-pass voicings to be tuned by ear after the Discord review; "passing" = renders correctly, not final sound.
