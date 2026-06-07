# Audio Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up Haystack's procedural-audio foundation — AudioContext + per-category bus mix + gesture-unlock, a raw-Web-Audio synth toolkit, an offline render pipeline, a facade, a React bridge with mix UI, and a Playwright `.wav` render harness — proven end-to-end with one real one-shot sound (`uiClick`).

**Architecture:** A framework-agnostic `AudioEngine` facade under `src/client/audio/` owns an `AudioContext` whose graph is `master → {engine, sfx, ui, alarm} buses → destination`. One-shots are defined as code that builds a Web Audio graph; they are rendered to `AudioBuffer`s once via `OfflineAudioContext` (the cached/expensive step), then played through a bus with a short-lived `AudioBufferSourceNode`. Pure logic (the mix model) is unit-tested in Bun; actual rendered audio is verified in a browser via a Playwright harness that also emits `.wav` review files.

**Tech Stack:** TypeScript (strict), Web Audio API, React 19, `jsfxr` (new dep, used from Plan 2 on), Bun test runner, Playwright (existing), `Bun.build` for bundling the render entry.

**Spec:** `docs/superpowers/specs/2026-06-07-procedural-sfx-design.md`

> **Working directory:** the `procedural-sfx` worktree at `/Users/hv/repos/haystack-procedural-sfx`. All paths below are relative to it. After **every** task: `bun run typecheck` and `bunx oxfmt .` must pass before commit.

---

## File structure (created by this plan)

```
src/client/audio/
  types.ts          — shared audio types (BusName, OneShotId, EngineState, AudioAction)
  mix.ts            — PURE per-category mix model (volume/mute/clamp/serialize)
  context.ts        — AudioContext creation + gesture-unlock
  buses.ts          — master + 4 bus GainNodes; applyMix
  synth/
    render.ts       — OfflineAudioContext "build graph -> AudioBuffer" util
    noise.ts        — white/pink/brown noise AudioBuffer generators
    env.ts          — AR gain envelope helper
    filters.ts      — biquad filter helpers (bandpass/lowpass/highpass)
  sfx/
    catalog.ts      — OneShotRender interface + uiClick recipe
    renderOneShot.ts— render a OneShotRender to an AudioBuffer
  AudioEngine.ts    — facade: init/unlock/playOneShot/setMix/getMix/dispose
  useAudio.ts       — React hook bridging EveApp <-> AudioEngine (+ unlock + persistence)
  AudioControls.tsx — per-category mix UI (master + 4 sliders + mute)
  renderEntry.ts    — browser entry exposing renderSamples() for the harness
  wav.ts            — Float32 PCM -> 16-bit WAV encoder
src/cli/render-sfx.ts — Bun+Playwright harness: render all sounds, write samples/*.wav
tests/audio/
  mix.test.ts       — unit tests for the mix model
  jsfxr.test.ts     — smoke test: jsfxr renders a non-silent buffer (for Plan 2)
tests/e2e/audio.ts  — Playwright: assert rendered sounds are non-silent + correct duration
```

Modified: `package.json` (deps + scripts), `.gitignore` (`samples/`), `src/client/eve/EveApp.tsx` (mount `useAudio` + `AudioControls`, fire `uiClick`).

---

## Task 1: Add jsfxr dependency + smoke test

**Files:**

- Modify: `package.json` (dependencies, scripts)
- Create: `tests/audio/jsfxr.test.ts`

- [ ] **Step 1: Install jsfxr**

Run: `cd /Users/hv/repos/haystack-procedural-sfx && bun add jsfxr`
Expected: `jsfxr` appears under `dependencies` in `package.json`.

- [ ] **Step 2: Wire the audio test dir into the test script**

In `package.json`, change the `test` script so Bun also runs `tests/audio`:

```json
"test": "bun test tests/integration tests/audio",
```

- [ ] **Step 3: Write the failing smoke test**

Create `tests/audio/jsfxr.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { sfxr } from "jsfxr";

describe("jsfxr", () => {
  test("generates a non-silent sample buffer in pure JS", () => {
    const sound = sfxr.generate("blipSelect");
    const buffer = sfxr.toBuffer(sound);
    expect(buffer.length).toBeGreaterThan(0);
    const peak = buffer.reduce((max, sample) => Math.max(max, Math.abs(sample)), 0);
    expect(peak).toBeGreaterThan(0.01);
  });

  test("toWave returns a WAV data URI", () => {
    const sound = sfxr.generate("blipSelect");
    const wave = sfxr.toWave(sound);
    expect(typeof wave.dataURI).toBe("string");
    expect(wave.dataURI.startsWith("data:audio/wav")).toBe(true);
  });
});
```

- [ ] **Step 4: Run the smoke test**

Run: `bun test tests/audio/jsfxr.test.ts`
Expected: PASS (2 tests). If the jsfxr API surface differs (`generate`/`toBuffer`/`toWave`), record the actual API in a comment at the top of the file and adjust — this is the canonical reference Plan 2 builds on.

- [ ] **Step 5: Commit**

```bash
git add package.json bun.lock tests/audio/jsfxr.test.ts
git commit -m "feat(audio): add jsfxr dependency with render smoke test"
```

---

## Task 2: Shared audio types

**Files:**

- Create: `src/client/audio/types.ts`

- [ ] **Step 1: Write the types**

Create `src/client/audio/types.ts`:

```ts
export type BusName = "engine" | "sfx" | "ui" | "alarm";

export const BUS_NAMES: readonly BusName[] = ["engine", "sfx", "ui", "alarm"];

/** One-shot SFX identifiers. Plan 1 implements `uiClick`; the rest land in Plan 2. */
export type OneShotId =
  | "uiClick"
  | "uiHover"
  | "targetLock"
  | "comms"
  | "boost"
  | "brake"
  | "scanHonk"
  | "chime";

/** Continuous engine state fed from the ship snapshot each flight tick (Plan 3). */
export interface EngineState {
  throttle: number; // -1..1
  boost: boolean;
  heat: number; // 0..100
  cruiseLock: boolean;
  speed: number; // m/s magnitude
}
```

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: PASS (no errors).

- [ ] **Step 3: Commit**

```bash
git add src/client/audio/types.ts
git commit -m "feat(audio): add shared audio types"
```

---

## Task 3: Pure per-category mix model (TDD)

**Files:**

- Create: `src/client/audio/mix.ts`
- Test: `tests/audio/mix.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/audio/mix.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  defaultMix,
  deserializeMix,
  serializeMix,
  setBus,
  setMaster,
  setMuted,
} from "../../src/client/audio/mix";

describe("mix model", () => {
  test("defaultMix has master, mute, and all four buses", () => {
    const mix = defaultMix();
    expect(mix.master).toBeGreaterThan(0);
    expect(mix.muted).toBe(false);
    expect(Object.keys(mix.buses).sort()).toEqual(["alarm", "engine", "sfx", "ui"]);
  });

  test("setMaster clamps to 0..1", () => {
    expect(setMaster(defaultMix(), 5).master).toBe(1);
    expect(setMaster(defaultMix(), -5).master).toBe(0);
  });

  test("setBus clamps and only changes the named bus", () => {
    const mix = setBus(defaultMix(), "engine", 2);
    expect(mix.buses.engine).toBe(1);
    expect(mix.buses.ui).toBe(defaultMix().buses.ui);
  });

  test("setMuted toggles without changing volumes", () => {
    const mix = setMuted(defaultMix(), true);
    expect(mix.muted).toBe(true);
    expect(mix.master).toBe(defaultMix().master);
  });

  test("serialize/deserialize round-trips", () => {
    const mix = setMuted(setBus(defaultMix(), "alarm", 0.3), true);
    expect(deserializeMix(serializeMix(mix))).toEqual(mix);
  });

  test("deserializeMix falls back to defaults on garbage or null", () => {
    expect(deserializeMix(null)).toEqual(defaultMix());
    expect(deserializeMix("not json")).toEqual(defaultMix());
    expect(deserializeMix("{}").buses.engine).toBe(defaultMix().buses.engine);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `bun test tests/audio/mix.test.ts`
Expected: FAIL ("Cannot find module '.../mix'").

- [ ] **Step 3: Implement the mix model**

Create `src/client/audio/mix.ts`:

```ts
import { BUS_NAMES, type BusName } from "./types";

export interface MixState {
  master: number;
  muted: boolean;
  buses: Record<BusName, number>;
}

const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);

export function defaultMix(): MixState {
  return {
    master: 0.8,
    muted: false,
    buses: { engine: 0.8, sfx: 0.9, ui: 0.6, alarm: 0.9 },
  };
}

export function setMaster(mix: MixState, value: number): MixState {
  return { ...mix, master: clamp01(value) };
}

export function setBus(mix: MixState, bus: BusName, value: number): MixState {
  return { ...mix, buses: { ...mix.buses, [bus]: clamp01(value) } };
}

export function setMuted(mix: MixState, muted: boolean): MixState {
  return { ...mix, muted };
}

export function serializeMix(mix: MixState): string {
  return JSON.stringify(mix);
}

export function deserializeMix(raw: string | null): MixState {
  const fallback = defaultMix();
  if (raw === null) {
    return fallback;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<MixState>;
    const parsedBuses = parsed.buses;
    const buses = BUS_NAMES.reduce<Record<BusName, number>>(
      (acc, bus) => {
        const candidate = parsedBuses?.[bus];
        acc[bus] = typeof candidate === "number" ? clamp01(candidate) : fallback.buses[bus];
        return acc;
      },
      { engine: 0, sfx: 0, ui: 0, alarm: 0 },
    );
    return {
      master: typeof parsed.master === "number" ? clamp01(parsed.master) : fallback.master,
      muted: typeof parsed.muted === "boolean" ? parsed.muted : fallback.muted,
      buses,
    };
  } catch {
    return fallback;
  }
}
```

- [ ] **Step 4: Run it to confirm it passes**

Run: `bun test tests/audio/mix.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Typecheck + format + commit**

```bash
bun run typecheck && bunx oxfmt src/client/audio/mix.ts tests/audio/mix.test.ts
git add src/client/audio/mix.ts tests/audio/mix.test.ts
git commit -m "feat(audio): add pure per-category mix model"
```

---

## Task 4: Synth toolkit (noise, env, filters, offline render)

These build Web Audio graphs, so they cannot run under Bun; the gate is typecheck now and the render harness (Task 11/12) later.

**Files:**

- Create: `src/client/audio/synth/noise.ts`
- Create: `src/client/audio/synth/env.ts`
- Create: `src/client/audio/synth/filters.ts`
- Create: `src/client/audio/synth/render.ts`

- [ ] **Step 1: Noise generators**

Create `src/client/audio/synth/noise.ts`:

```ts
export type NoiseColor = "white" | "pink" | "brown";

/** Build a mono noise AudioBuffer of `seconds` length on the given context. */
export function createNoiseBuffer(
  ctx: BaseAudioContext,
  seconds: number,
  color: NoiseColor = "white",
): AudioBuffer {
  const length = Math.max(1, Math.floor(seconds * ctx.sampleRate));
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);

  if (color === "white") {
    for (let i = 0; i < length; i += 1) {
      data[i] = Math.random() * 2 - 1;
    }
    return buffer;
  }

  if (color === "pink") {
    // Paul Kellet's economy pink-noise filter.
    let b0 = 0;
    let b1 = 0;
    let b2 = 0;
    let b3 = 0;
    let b4 = 0;
    let b5 = 0;
    let b6 = 0;
    for (let i = 0; i < length; i += 1) {
      const white = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + white * 0.0555179;
      b1 = 0.99332 * b1 + white * 0.0750759;
      b2 = 0.969 * b2 + white * 0.153852;
      b3 = 0.8665 * b3 + white * 0.3104856;
      b4 = 0.55 * b4 + white * 0.5329522;
      b5 = -0.7616 * b5 - white * 0.016898;
      data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
      b6 = white * 0.115926;
    }
    return buffer;
  }

  // brown
  let last = 0;
  for (let i = 0; i < length; i += 1) {
    const white = Math.random() * 2 - 1;
    last = (last + 0.02 * white) / 1.02;
    data[i] = last * 3.5;
  }
  return buffer;
}
```

- [ ] **Step 2: Envelope helper**

Create `src/client/audio/synth/env.ts`:

```ts
/**
 * Schedule an attack/hold/release envelope on a gain AudioParam.
 * Uses exponential ramps (cannot reach 0, so we floor at 0.0001) for click-free edges.
 */
export function applyAr(
  gain: AudioParam,
  startTime: number,
  attack: number,
  hold: number,
  release: number,
  peak = 1,
): void {
  const floor = 0.0001;
  gain.setValueAtTime(floor, startTime);
  gain.exponentialRampToValueAtTime(Math.max(peak, floor), startTime + attack);
  gain.setValueAtTime(Math.max(peak, floor), startTime + attack + hold);
  gain.exponentialRampToValueAtTime(floor, startTime + attack + hold + release);
}
```

- [ ] **Step 3: Filter helpers**

Create `src/client/audio/synth/filters.ts`:

```ts
export function createBandpass(ctx: BaseAudioContext, frequency: number, q = 1): BiquadFilterNode {
  const filter = ctx.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.value = frequency;
  filter.Q.value = q;
  return filter;
}

export function createLowpass(ctx: BaseAudioContext, frequency: number, q = 0.7): BiquadFilterNode {
  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = frequency;
  filter.Q.value = q;
  return filter;
}

export function createHighpass(
  ctx: BaseAudioContext,
  frequency: number,
  q = 0.7,
): BiquadFilterNode {
  const filter = ctx.createBiquadFilter();
  filter.type = "highpass";
  filter.frequency.value = frequency;
  filter.Q.value = q;
  return filter;
}
```

- [ ] **Step 4: Offline render util**

Create `src/client/audio/synth/render.ts`:

```ts
/**
 * Render a built graph to an AudioBuffer via OfflineAudioContext.
 * `build` wires sources into `ctx.destination`; rendering runs faster than realtime.
 * Browser-only (OfflineAudioContext is not available under Bun/Node).
 */
export function renderToBuffer(
  durationSeconds: number,
  build: (ctx: OfflineAudioContext) => void,
  sampleRate = 44100,
): Promise<AudioBuffer> {
  const frames = Math.max(1, Math.ceil(durationSeconds * sampleRate));
  const ctx = new OfflineAudioContext(1, frames, sampleRate);
  build(ctx);
  return ctx.startRendering();
}
```

- [ ] **Step 5: Typecheck + format + commit**

```bash
bun run typecheck && bunx oxfmt src/client/audio/synth
git add src/client/audio/synth
git commit -m "feat(audio): add raw Web Audio synth toolkit (noise/env/filters/render)"
```

---

## Task 5: One-shot catalog + renderOneShot (the uiClick recipe)

**Files:**

- Create: `src/client/audio/sfx/catalog.ts`
- Create: `src/client/audio/sfx/renderOneShot.ts`

- [ ] **Step 1: Define OneShotRender + the uiClick recipe**

`uiClick` is "a tiny filtered transient" — pure raw-Web-Audio (no jsfxr), a good representative of the render pipeline. jsfxr-cored recipes arrive in Plan 2.

Create `src/client/audio/sfx/catalog.ts`:

```ts
import { applyAr } from "../synth/env";
import { createBandpass, createHighpass } from "../synth/filters";
import { createNoiseBuffer } from "../synth/noise";

/** A code-defined one-shot: how long it is and how to build its graph into `destination`. */
export interface OneShotRender {
  durationSeconds: number;
  build(ctx: BaseAudioContext, destination: AudioNode, startTime: number): void;
}

/** UI click: short band-passed white-noise transient with a fast attack/release. */
export const uiClick: OneShotRender = {
  durationSeconds: 0.08,
  build(ctx, destination, t0) {
    const source = ctx.createBufferSource();
    source.buffer = createNoiseBuffer(ctx, 0.08, "white");
    const band = createBandpass(ctx, 2200, 6);
    const high = createHighpass(ctx, 1200);
    const gain = ctx.createGain();
    source.connect(band);
    band.connect(high);
    high.connect(gain);
    gain.connect(destination);
    applyAr(gain.gain, t0, 0.002, 0.004, 0.05, 0.7);
    source.start(t0);
    source.stop(t0 + 0.08);
  },
};
```

- [ ] **Step 2: renderOneShot**

Create `src/client/audio/sfx/renderOneShot.ts`:

```ts
import { renderToBuffer } from "../synth/render";
import type { OneShotRender } from "./catalog";

/** Render a one-shot recipe to a cached AudioBuffer (offline, faster than realtime). */
export function renderOneShot(spec: OneShotRender): Promise<AudioBuffer> {
  return renderToBuffer(spec.durationSeconds, (ctx) => {
    spec.build(ctx, ctx.destination, 0);
  });
}
```

- [ ] **Step 3: Typecheck + format + commit**

```bash
bun run typecheck && bunx oxfmt src/client/audio/sfx
git add src/client/audio/sfx
git commit -m "feat(audio): add one-shot catalog with uiClick recipe + offline render"
```

---

## Task 6: AudioContext + bus graph

**Files:**

- Create: `src/client/audio/context.ts`
- Create: `src/client/audio/buses.ts`

- [ ] **Step 1: Context + unlock**

Create `src/client/audio/context.ts`:

```ts
export function createAudioContext(): AudioContext {
  return new AudioContext();
}

/** Resume a suspended context. Must be called from within a user gesture. */
export async function unlock(ctx: AudioContext): Promise<void> {
  if (ctx.state === "suspended") {
    await ctx.resume();
  }
}
```

- [ ] **Step 2: Bus graph**

Create `src/client/audio/buses.ts`:

```ts
import type { MixState } from "./mix";
import { BUS_NAMES, type BusName } from "./types";

export interface BusGraph {
  master: GainNode;
  buses: Record<BusName, GainNode>;
}

export function createBusGraph(ctx: AudioContext): BusGraph {
  const master = ctx.createGain();
  master.connect(ctx.destination);
  const make = (): GainNode => {
    const node = ctx.createGain();
    node.connect(master);
    return node;
  };
  return {
    master,
    buses: { engine: make(), sfx: make(), ui: make(), alarm: make() },
  };
}

export function applyMix(graph: BusGraph, mix: MixState): void {
  graph.master.gain.value = mix.muted ? 0 : mix.master;
  for (const bus of BUS_NAMES) {
    graph.buses[bus].gain.value = mix.buses[bus];
  }
}
```

- [ ] **Step 3: Typecheck + format + commit**

```bash
bun run typecheck && bunx oxfmt src/client/audio/context.ts src/client/audio/buses.ts
git add src/client/audio/context.ts src/client/audio/buses.ts
git commit -m "feat(audio): add AudioContext lifecycle and bus graph"
```

---

## Task 7: AudioEngine facade

**Files:**

- Create: `src/client/audio/AudioEngine.ts`

- [ ] **Step 1: Implement the facade**

Create `src/client/audio/AudioEngine.ts`:

```ts
import { applyMix, createBusGraph, type BusGraph } from "./buses";
import { createAudioContext, unlock } from "./context";
import { defaultMix, type MixState } from "./mix";
import { uiClick, type OneShotRender } from "./sfx/catalog";
import { renderOneShot } from "./sfx/renderOneShot";
import type { BusName, OneShotId } from "./types";

interface OneShotEntry {
  spec: OneShotRender;
  bus: BusName;
}

/** Registry of implemented one-shots. Plan 2 extends this map. */
const ONE_SHOTS: Partial<Record<OneShotId, OneShotEntry>> = {
  uiClick: { spec: uiClick, bus: "ui" },
};

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private graph: BusGraph | null = null;
  private mix: MixState;
  private readonly bank = new Map<OneShotId, AudioBuffer>();
  private ready = false;

  constructor(mix: MixState = defaultMix()) {
    this.mix = mix;
  }

  /** Create the context/graph and render the one-shot bank. Idempotent. */
  async init(): Promise<void> {
    if (this.ctx !== null) {
      return;
    }
    const ctx = createAudioContext();
    const graph = createBusGraph(ctx);
    applyMix(graph, this.mix);
    this.ctx = ctx;
    this.graph = graph;
    for (const [id, entry] of Object.entries(ONE_SHOTS) as [OneShotId, OneShotEntry][]) {
      this.bank.set(id, await renderOneShot(entry.spec));
    }
    this.ready = true;
  }

  /** Resume the context from a user gesture. */
  async unlock(): Promise<void> {
    if (this.ctx !== null) {
      await unlock(this.ctx);
    }
  }

  setMix(mix: MixState): void {
    this.mix = mix;
    if (this.graph !== null) {
      applyMix(this.graph, mix);
    }
  }

  getMix(): MixState {
    return this.mix;
  }

  /** Fire a one-shot through its bus with a short-lived buffer source. */
  playOneShot(id: OneShotId): void {
    if (!this.ready || this.ctx === null || this.graph === null) {
      return;
    }
    const entry = ONE_SHOTS[id];
    const buffer = this.bank.get(id);
    if (entry === undefined || buffer === undefined) {
      return;
    }
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.graph.buses[entry.bus]);
    source.start();
    source.onended = () => source.disconnect();
  }

  dispose(): void {
    void this.ctx?.close();
    this.ctx = null;
    this.graph = null;
    this.ready = false;
    this.bank.clear();
  }
}
```

- [ ] **Step 2: Typecheck + format + commit**

```bash
bun run typecheck && bunx oxfmt src/client/audio/AudioEngine.ts
git add src/client/audio/AudioEngine.ts
git commit -m "feat(audio): add AudioEngine facade (init/unlock/playOneShot/mix)"
```

---

## Task 8: React bridge hook + mix UI

**Files:**

- Create: `src/client/audio/useAudio.ts`
- Create: `src/client/audio/AudioControls.tsx`

- [ ] **Step 1: useAudio hook**

Create `src/client/audio/useAudio.ts`:

```ts
import { useEffect, useMemo, useState } from "react";

import { AudioEngine } from "./AudioEngine";
import { deserializeMix, serializeMix, type MixState } from "./mix";

const MIX_KEY = "haystack:audio:mix";

export interface AudioApi {
  engine: AudioEngine;
  mix: MixState;
  setMix: (next: MixState) => void;
  unlocked: boolean;
}

function loadMix(): MixState {
  if (typeof window === "undefined") {
    return deserializeMix(null);
  }
  return deserializeMix(window.localStorage.getItem(MIX_KEY));
}

export function useAudio(): AudioApi {
  const engine = useMemo(() => new AudioEngine(loadMix()), []);
  const [mix, setMixState] = useState<MixState>(() => engine.getMix());
  const [unlocked, setUnlocked] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void engine.init();

    const onGesture = (): void => {
      void engine.unlock().then(() => {
        if (!cancelled) {
          setUnlocked(true);
        }
      });
    };
    window.addEventListener("pointerdown", onGesture);
    window.addEventListener("keydown", onGesture);
    return () => {
      cancelled = true;
      window.removeEventListener("pointerdown", onGesture);
      window.removeEventListener("keydown", onGesture);
      engine.dispose();
    };
  }, [engine]);

  const setMix = (next: MixState): void => {
    engine.setMix(next);
    setMixState(next);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(MIX_KEY, serializeMix(next));
    }
  };

  return { engine, mix, setMix, unlocked };
}
```

- [ ] **Step 2: AudioControls component**

Create `src/client/audio/AudioControls.tsx`:

```tsx
import type { ReactNode } from "react";

import { setBus, setMaster, setMuted, type MixState } from "./mix";
import { BUS_NAMES, type BusName } from "./types";

interface AudioControlsProps {
  mix: MixState;
  unlocked: boolean;
  onChange: (next: MixState) => void;
}

const BUS_LABEL: Record<BusName, string> = {
  engine: "Engine",
  sfx: "SFX",
  ui: "UI",
  alarm: "Alarm",
};

export function AudioControls({ mix, unlocked, onChange }: AudioControlsProps): ReactNode {
  return (
    <section className="audio-controls" data-testid="audio-controls">
      <header className="audio-controls__head">
        <span>Audio</span>
        <button
          type="button"
          data-testid="audio-mute"
          aria-pressed={mix.muted}
          onClick={() => onChange(setMuted(mix, !mix.muted))}
        >
          {mix.muted ? "Unmute" : "Mute"}
        </button>
      </header>
      {!unlocked ? <p className="audio-controls__hint">Audio off — click to enable</p> : null}
      <label className="audio-controls__row">
        <span>Master</span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={mix.master}
          data-testid="audio-master"
          onChange={(event) => onChange(setMaster(mix, Number(event.target.value)))}
        />
      </label>
      {BUS_NAMES.map((bus) => (
        <label className="audio-controls__row" key={bus}>
          <span>{BUS_LABEL[bus]}</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={mix.buses[bus]}
            data-testid={`audio-bus-${bus}`}
            onChange={(event) => onChange(setBus(mix, bus, Number(event.target.value)))}
          />
        </label>
      ))}
    </section>
  );
}
```

- [ ] **Step 3: Typecheck + format + commit**

```bash
bun run typecheck && bunx oxfmt src/client/audio/useAudio.ts src/client/audio/AudioControls.tsx
git add src/client/audio/useAudio.ts src/client/audio/AudioControls.tsx
git commit -m "feat(audio): add useAudio bridge hook and per-category mix UI"
```

---

## Task 9: Wire audio into EveApp (gesture-unlock + uiClick on window toggles)

**Files:**

- Modify: `src/client/eve/EveApp.tsx`

- [ ] **Step 1: Import the bridge**

In `src/client/eve/EveApp.tsx`, add to the import block (near the other `./` imports, e.g. after the `./vector` import on line 78):

```ts
import { AudioControls } from "../audio/AudioControls";
import { useAudio } from "../audio/useAudio";
```

- [ ] **Step 2: Call the hook**

Inside `EveApp`, immediately after the existing `const [session, setSession] = useState<Session | null>(null);` (line 81), add:

```ts
const audio = useAudio();
```

- [ ] **Step 3: Fire uiClick on window toggles**

In `EveApp`'s `toggleWindow` function (currently lines 736-742), add a click sound as the first statement:

```ts
function toggleWindow(key: WindowKey): void {
  audio.engine.playOneShot("uiClick");
  const nextOpen = !layout[key].open;
  patchWindow(key, { open: nextOpen, minimized: false });
  if (nextOpen) {
    focusWindow(key);
  }
}
```

- [ ] **Step 4: Mount the mix UI**

In the returned JSX, add `<AudioControls>` just before the closing `</main>` (after the `contextMenu` block that ends around line 673):

```tsx
      <AudioControls mix={audio.mix} unlocked={audio.unlocked} onChange={audio.setMix} />
    </main>
```

- [ ] **Step 5: Minimal styles**

Append to `src/client/styles.css`:

```css
.audio-controls {
  position: fixed;
  right: 12px;
  bottom: 12px;
  z-index: 50;
  display: grid;
  gap: 4px;
  padding: 8px 10px;
  background: rgba(8, 14, 20, 0.85);
  border: 1px solid rgba(120, 160, 200, 0.3);
  border-radius: 6px;
  font-size: 11px;
  color: #cde3f5;
}
.audio-controls__head {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: center;
}
.audio-controls__row {
  display: grid;
  grid-template-columns: 56px 1fr;
  gap: 8px;
  align-items: center;
}
.audio-controls__hint {
  margin: 0;
  color: #f5c87a;
}
```

- [ ] **Step 6: Typecheck + format**

Run: `bun run typecheck && bunx oxfmt src/client/eve/EveApp.tsx src/client/styles.css`
Expected: PASS.

- [ ] **Step 7: Verify in the browser manually**

Run the app (`bun run dev` in one shell, `bun run dev:client` in another) and confirm: the audio panel renders bottom-right; clicking a Neocom window button produces a short click; the "click to enable" hint disappears after first interaction. (Automated audio verification is Task 12.)

- [ ] **Step 8: Commit**

```bash
git add src/client/eve/EveApp.tsx src/client/styles.css
git commit -m "feat(audio): wire audio engine + mix UI into EveApp"
```

---

## Task 10: WAV encoder + browser render entry

**Files:**

- Create: `src/client/audio/wav.ts`
- Create: `src/client/audio/renderEntry.ts`

- [ ] **Step 1: WAV encoder**

Create `src/client/audio/wav.ts`:

```ts
/** Encode mono Float32 PCM into a 16-bit PCM WAV byte array. */
export function encodeWav(
  pcm: ReadonlyArray<number> | Float32Array,
  sampleRate: number,
): Uint8Array {
  const frames = pcm.length;
  const bytes = new Uint8Array(44 + frames * 2);
  const view = new DataView(bytes.buffer);
  const writeString = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) {
      view.setUint8(offset + i, text.charCodeAt(i));
    }
  };
  writeString(0, "RIFF");
  view.setUint32(4, 36 + frames * 2, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, frames * 2, true);
  let offset = 44;
  for (let i = 0; i < frames; i += 1) {
    const sample = pcm[i] ?? 0;
    const clamped = sample < -1 ? -1 : sample > 1 ? 1 : sample;
    view.setInt16(offset, Math.round(clamped * 32767), true);
    offset += 2;
  }
  return bytes;
}
```

- [ ] **Step 2: Browser render entry**

Create `src/client/audio/renderEntry.ts`. This is bundled and loaded into a page by the harness; it renders every implemented sound to PCM and hangs it off `window`.

```ts
import { uiClick } from "./sfx/catalog";
import { renderOneShot } from "./sfx/renderOneShot";

export interface RenderedSample {
  name: string;
  sampleRate: number;
  pcm: number[];
}

const SAMPLE_RATE = 44100;

/** Render every implemented sound to PCM. Plan 2/3 add entries here. */
export async function renderSamples(): Promise<RenderedSample[]> {
  const buffer = await renderOneShot(uiClick);
  return [{ name: "uiClick", sampleRate: SAMPLE_RATE, pcm: Array.from(buffer.getChannelData(0)) }];
}

declare global {
  interface Window {
    renderSamples?: () => Promise<RenderedSample[]>;
  }
}

if (typeof window !== "undefined") {
  window.renderSamples = renderSamples;
}
```

- [ ] **Step 3: Typecheck + format + commit**

```bash
bun run typecheck && bunx oxfmt src/client/audio/wav.ts src/client/audio/renderEntry.ts
git add src/client/audio/wav.ts src/client/audio/renderEntry.ts
git commit -m "feat(audio): add WAV encoder and browser render entry"
```

---

## Task 11: Playwright render harness CLI (samples/\*.wav)

**Files:**

- Create: `src/cli/render-sfx.ts`
- Modify: `package.json` (scripts)
- Modify: `.gitignore`

- [ ] **Step 1: Ignore the samples dir**

Append `samples/` to `.gitignore`.

- [ ] **Step 2: Add scripts**

In `package.json` scripts add:

```json
"render:sfx": "bun src/cli/render-sfx.ts",
"verify:audio": "bun tests/e2e/audio.ts",
```

- [ ] **Step 3: Implement the harness**

Create `src/cli/render-sfx.ts`. It bundles `renderEntry.ts` with `Bun.build`, loads it into a headless chromium page (needed for `OfflineAudioContext`), renders all samples, and exposes `renderSamples()` for reuse by the e2e test. Running it directly writes `.wav` files.

```ts
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { chromium } from "playwright";

import { encodeWav } from "../client/audio/wav";
import type { RenderedSample } from "../client/audio/renderEntry";

const ENTRY = resolve(import.meta.dir, "../client/audio/renderEntry.ts");

/** Bundle the render entry, run it in a real browser, return rendered PCM. */
export async function renderSamples(): Promise<RenderedSample[]> {
  const built = await Bun.build({ entrypoints: [ENTRY], target: "browser", minify: false });
  if (!built.success) {
    throw new Error(`render entry build failed: ${built.logs.map(String).join("\n")}`);
  }
  const bundle = await built.outputs[0]!.text();

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto("about:blank");
    await page.addScriptTag({ content: bundle });
    await page.waitForFunction(() => typeof window.renderSamples === "function");
    return (await page.evaluate(() => window.renderSamples!())) as RenderedSample[];
  } finally {
    await browser.close();
  }
}

async function main(): Promise<void> {
  const outDir = resolve("samples");
  mkdirSync(outDir, { recursive: true });
  const samples = await renderSamples();
  for (const sample of samples) {
    const wav = encodeWav(sample.pcm, sample.sampleRate);
    const path = resolve(outDir, `${sample.name}.wav`);
    writeFileSync(path, wav);
    const peak = sample.pcm.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
    console.log(`wrote ${path} (${sample.pcm.length} frames, peak ${peak.toFixed(3)})`);
  }
}

if (import.meta.main) {
  await main();
}
```

- [ ] **Step 4: Run the harness**

Run: `bun run render:sfx`
Expected: console logs `wrote .../samples/uiClick.wav (3528 frames, peak ...)` with peak > 0.05, and the file exists. Listen to `samples/uiClick.wav` to confirm it's an audible click.

- [ ] **Step 5: Commit**

```bash
git add src/cli/render-sfx.ts package.json .gitignore
git commit -m "feat(audio): add Playwright .wav render harness CLI"
```

---

## Task 12: Playwright audio verification test

**Files:**

- Create: `tests/e2e/audio.ts`
- Modify: `package.json` (fold into verify:e2e)

- [ ] **Step 1: Write the test**

Create `tests/e2e/audio.ts`. It reuses `renderSamples()` and asserts each rendered sound is non-silent and has roughly the expected duration.

```ts
import { assert } from "./helpers";
import { renderSamples } from "../../src/cli/render-sfx";

const EXPECTED_DURATION_SECONDS: Record<string, number> = {
  uiClick: 0.08,
};

const samples = await renderSamples();
assert(samples.length > 0, "render harness returned no samples");

for (const sample of samples) {
  const peak = sample.pcm.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
  assert(peak > 0.02, `${sample.name} is silent (peak ${peak})`);

  const expected = EXPECTED_DURATION_SECONDS[sample.name];
  assert(expected !== undefined, `${sample.name} has no expected duration registered`);
  const actual = sample.pcm.length / sample.sampleRate;
  assert(
    Math.abs(actual - expected) < 0.02,
    `${sample.name} duration ${actual.toFixed(3)}s != expected ${expected}s`,
  );
}

console.log(`audio verification passed: ${samples.length} sample(s)`);
```

- [ ] **Step 2: Run it**

Run: `bun tests/e2e/audio.ts`
Expected: prints `audio verification passed: 1 sample(s)` and exits 0.

- [ ] **Step 3: Fold into the e2e verify chain**

In `package.json`, update `verify:e2e` to include audio:

```json
"verify:e2e": "bun run verify:screenshot && bun run verify:multiplayer && bun run verify:ui && bun run verify:audio",
```

- [ ] **Step 4: Full verify**

Run: `bun run verify`
Expected: typecheck + format + integration + audio unit tests all PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/e2e/audio.ts package.json
git commit -m "test(audio): add Playwright render verification for SFX"
```

---

## Self-review notes (author)

- **Spec coverage (Plan 1 slice):** AudioContext lifecycle + gesture-unlock (Tasks 6, 8, 9) ✓; per-category bus mix + persistence + UI (Tasks 3, 6, 7, 8) ✓; raw-WA synth toolkit (Task 4) ✓; code-defined one-shot rendered offline, no asset file (Tasks 5, 7) ✓; no-hand-authored-assets + Discord review `.wav` harness (Tasks 10, 11) ✓; testing split — pure logic in Bun, audio output via Playwright (Tasks 3, 11, 12) ✓; jsfxr dependency confirmed for Plan 2 (Task 1) ✓. **Deferred by design:** the full 12-sound catalog (Plan 2), the real-time engine drone + ambience + mining + the `EngineState`/`events.ts` continuous path + 3D spatialization (Plan 3). `EngineState`/`OneShotId` extras are declared in `types.ts` now so later plans extend rather than redefine.
- **Placeholder scan:** none — every step has concrete code or an exact command.
- **Type consistency:** `MixState`, `BusName`/`BUS_NAMES`, `OneShotId`, `OneShotRender`, `RenderedSample`, `renderSamples()` are defined once and referenced consistently across tasks.
- **Known execution risk:** Task 1 Step 4 — jsfxr's exact export/method names. If they differ from `sfxr.generate/toBuffer/toWave`, fix in place and the catalog work in Plan 2 inherits the correction. The uiClick critical path deliberately avoids jsfxr to de-risk Plan 1.
- **Known execution risk:** `Bun.build` output API (`built.outputs[0].text()`) — if the Bun version differs, read the artifact via the documented `BuildArtifact` interface; the harness shape is otherwise stable.
