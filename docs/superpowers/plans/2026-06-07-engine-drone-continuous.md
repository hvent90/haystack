# Real-Time Engine Drone & Continuous SFX Plan (Plan 3 of 4)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add the continuous, state-driven sounds: a real-time engine/thruster drone parameterized by throttle/heat/cruise, a continuous mining-laser loop, a low ambient bed, and a repeating heat-overheat alarm — fed live from the ship snapshot, with click-free parameter smoothing.

**Architecture:** Unlike one-shots (offline-rendered AudioBuffers), these are **persistent live graphs** built once on a running `AudioContext` and modulated via `AudioParam` smoothing (`setTargetAtTime`). The drone = sub sine + low saw + looped filtered brown-noise body + a heat "whine" layer, summed into the `engine` bus; mapped from `EngineState`. Mining = gritty bandpassed saw + sub on the `sfx` bus, toggled on/off. Ambience = very-low looped noise bed. The alarm = a two-tone beep scheduled with the "A Tale of Two Clocks" lookahead scheduler on the `alarm` bus, toggled by a pure heat edge-detector. EveApp feeds `setEngineState` each flight tick and toggles mining/alarm from snapshot diffs.

**Tech Stack:** Same as Plans 1-2. All graphs use only nodes available on BOTH `AudioContext` and `OfflineAudioContext` (oscillators, gains, biquads, looping buffer sources) so the drone can also be captured offline to `.wav` for review.

**Spec:** `docs/superpowers/specs/2026-06-07-procedural-sfx-design.md` §5 (continuous rows), §4 (data flow), §7 (smoothing/scheduling).

> **Working dir:** worktree `/Users/hv/repos/haystack-procedural-sfx`, branch `procedural-sfx`. After every task: `bun run typecheck` + `bunx oxfmt .` pass before commit. `EngineState` type already exists in `src/client/audio/types.ts` (`{ throttle, boost, heat, cruiseLock, speed }`).

---

## Task 1: Lookahead scheduler (TDD on the pure timing math)

**Files:**

- Create: `src/client/audio/scheduler.ts`
- Test: `tests/audio/scheduler.test.ts`

The scheduler's TIMING MATH is pure and testable; the `setTimeout`/AudioContext wiring is thin. Split them: a pure `nextBeatTimes(fromTime, untilTime, interval, phase)` function (tested) + a thin `LookaheadScheduler` class using it.

- [ ] **Step 1: Failing test for the pure beat math**

Create `tests/audio/scheduler.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { nextBeatTimes } from "../../src/client/audio/scheduler";

describe("nextBeatTimes", () => {
  test("returns beats within the window aligned to interval", () => {
    expect(nextBeatTimes(0, 0.25, 0.1, 0)).toEqual([0, 0.1, 0.2]);
  });
  test("starts at the first beat at or after fromTime", () => {
    expect(nextBeatTimes(0.15, 0.45, 0.1, 0)).toEqual([0.2, 0.3, 0.4]);
  });
  test("empty when window has no beat", () => {
    expect(nextBeatTimes(0.21, 0.29, 0.1, 0)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it — fails (no module)**

Run: `bun test tests/audio/scheduler.test.ts` — FAIL.

- [ ] **Step 3: Implement scheduler**

Create `src/client/audio/scheduler.ts`:

```ts
/** Beat times in [fromTime, untilTime) aligned to `interval` (epsilon-guarded). */
export function nextBeatTimes(
  fromTime: number,
  untilTime: number,
  interval: number,
  phase = 0,
): number[] {
  if (interval <= 0) {
    return [];
  }
  const eps = interval * 1e-6;
  const k = Math.ceil((fromTime - phase) / interval - eps);
  const beats: number[] = [];
  for (let n = k; ; n += 1) {
    const t = phase + n * interval;
    if (t >= untilTime - eps) {
      break;
    }
    if (t >= fromTime - eps) {
      beats.push(Number(t.toFixed(10)));
    }
  }
  return beats;
}

/**
 * Lookahead scheduler ("A Tale of Two Clocks"): a setTimeout loop (lookahead ~25ms)
 * that schedules beat callbacks ~100ms ahead against AudioContext.currentTime.
 */
export class LookaheadScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private nextFrom = 0;

  constructor(
    private readonly ctx: AudioContext,
    private readonly interval: number,
    private readonly onBeat: (time: number) => void,
    private readonly lookahead = 0.1,
    private readonly tickMs = 25,
  ) {}

  start(): void {
    if (this.timer !== null) {
      return;
    }
    this.nextFrom = this.ctx.currentTime;
    this.timer = setInterval(() => {
      const until = this.ctx.currentTime + this.lookahead;
      for (const time of nextBeatTimes(this.nextFrom, until, this.interval)) {
        this.onBeat(time);
      }
      this.nextFrom = until;
    }, this.tickMs);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
```

- [ ] **Step 4: Run it — passes**

Run: `bun test tests/audio/scheduler.test.ts` — PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
bun run typecheck && bunx oxfmt src/client/audio/scheduler.ts tests/audio/scheduler.test.ts
git add src/client/audio/scheduler.ts tests/audio/scheduler.test.ts
git commit -m "feat(audio): add lookahead scheduler with tested beat math"
```

---

## Task 2: Heat-alarm edge detector (pure, TDD)

**Files:**

- Create: `src/client/audio/events.ts`
- Test: `tests/audio/events.test.ts`

- [ ] **Step 1: Failing test**

Create `tests/audio/events.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { alarmTransition } from "../../src/client/audio/events";

describe("alarmTransition", () => {
  test("turns on when crossing up through the threshold", () => {
    expect(alarmTransition(90, 94)).toBe("on");
  });
  test("turns off when dropping back below (hysteresis)", () => {
    expect(alarmTransition(94, 80)).toBe("off");
  });
  test("no change while staying above", () => {
    expect(alarmTransition(94, 96)).toBe("none");
  });
  test("no change while staying below", () => {
    expect(alarmTransition(50, 70)).toBe("none");
  });
});
```

- [ ] **Step 2: Run — fails.** `bun test tests/audio/events.test.ts` — FAIL.

- [ ] **Step 3: Implement**

Create `src/client/audio/events.ts`:

```ts
const ALARM_ON = 92;
const ALARM_OFF = 85; // hysteresis so it doesn't chatter at the boundary

export type AlarmTransition = "on" | "off" | "none";

/** Edge-detect the overheat alarm from previous->next heat with hysteresis. */
export function alarmTransition(prevHeat: number, nextHeat: number): AlarmTransition {
  const wasOn = prevHeat >= ALARM_ON;
  if (!wasOn && nextHeat >= ALARM_ON) {
    return "on";
  }
  if (wasOn && nextHeat < ALARM_OFF) {
    return "off";
  }
  return "none";
}
```

- [ ] **Step 4: Run — passes.** `bun test tests/audio/events.test.ts` — PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
bun run typecheck && bunx oxfmt src/client/audio/events.ts tests/audio/events.test.ts
git add src/client/audio/events.ts tests/audio/events.test.ts
git commit -m "feat(audio): add pure heat-alarm edge detector with hysteresis"
```

---

## Task 3: Engine drone module

**Files:**

- Create: `src/client/audio/drone.ts`

The drone builds a persistent graph and exposes `setState(EngineState)` (smoothed) + `start()`/`stop()`. It must accept a `BaseAudioContext` and an output `AudioNode` (the engine bus live, or `ctx.destination` for offline capture). Use `setTargetAtTime(target, now, tau)` for all continuous params.

- [ ] **Step 1: Implement**

Create `src/client/audio/drone.ts`:

```ts
import { createLowpass } from "./synth/filters";
import { createNoiseBuffer } from "./synth/noise";
import type { EngineState } from "./types";

const TAU = 0.08; // smoothing time-constant (s) — kills zipper noise

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Persistent engine-drone voice: sub + saw + filtered-noise body + heat whine. */
export class EngineDrone {
  private readonly subOsc: OscillatorNode;
  private readonly sawOsc: OscillatorNode;
  private readonly whineOsc: OscillatorNode;
  private readonly noise: AudioBufferSourceNode;
  private readonly noiseLp: BiquadFilterNode;
  private readonly subGain: GainNode;
  private readonly sawGain: GainNode;
  private readonly whineGain: GainNode;
  private readonly bodyGain: GainNode;
  private readonly master: GainNode;
  private started = false;

  constructor(
    private readonly ctx: BaseAudioContext,
    output: AudioNode,
  ) {
    this.master = ctx.createGain();
    this.master.gain.value = 0.0001;
    this.master.connect(output);

    this.subOsc = ctx.createOscillator();
    this.subOsc.type = "sine";
    this.subOsc.frequency.value = 32;
    this.subGain = ctx.createGain();
    this.subGain.gain.value = 0.2;
    this.subOsc.connect(this.subGain);
    this.subGain.connect(this.master);

    this.sawOsc = ctx.createOscillator();
    this.sawOsc.type = "sawtooth";
    this.sawOsc.frequency.value = 44;
    this.sawGain = ctx.createGain();
    this.sawGain.gain.value = 0.0001;
    this.sawOsc.connect(this.sawGain);
    this.sawGain.connect(this.master);

    this.noise = ctx.createBufferSource();
    this.noise.buffer = createNoiseBuffer(ctx, 2, "brown");
    this.noise.loop = true;
    this.noiseLp = createLowpass(ctx, 240, 0.8);
    this.bodyGain = ctx.createGain();
    this.bodyGain.gain.value = 0.05;
    this.noise.connect(this.noiseLp);
    this.noiseLp.connect(this.bodyGain);
    this.bodyGain.connect(this.master);

    this.whineOsc = ctx.createOscillator();
    this.whineOsc.type = "triangle";
    this.whineOsc.frequency.value = 2200;
    this.whineGain = ctx.createGain();
    this.whineGain.gain.value = 0.0001;
    this.whineOsc.connect(this.whineGain);
    this.whineGain.connect(this.master);
  }

  /** Start oscillators/noise and fade the master in. `at` defaults to now. */
  start(at?: number): void {
    if (this.started) {
      return;
    }
    const t = at ?? this.ctx.currentTime;
    this.subOsc.start(t);
    this.sawOsc.start(t);
    this.whineOsc.start(t);
    this.noise.start(t);
    this.master.gain.setTargetAtTime(0.5, t, TAU);
    this.started = true;
  }

  stop(at?: number): void {
    if (!this.started) {
      return;
    }
    const t = at ?? this.ctx.currentTime;
    this.master.gain.setTargetAtTime(0.0001, t, TAU);
    const end = t + 0.4;
    this.subOsc.stop(end);
    this.sawOsc.stop(end);
    this.whineOsc.stop(end);
    this.noise.stop(end);
    this.started = false;
  }

  /** Map game state onto the voice with smoothing. */
  setState(state: EngineState, at?: number): void {
    const t = at ?? this.ctx.currentTime;
    const drive = clamp01(Math.abs(state.throttle));
    const heat = clamp01(state.heat / 100);
    const cruise = state.cruiseLock ? 1 : 0;

    this.subOsc.frequency.setTargetAtTime(30 + drive * 26, t, TAU);
    this.sawOsc.frequency.setTargetAtTime(42 + drive * 120 + cruise * 18, t, TAU);
    this.noiseLp.frequency.setTargetAtTime(220 + drive * 3000, t, TAU);

    this.subGain.gain.setTargetAtTime(0.18 + drive * 0.28, t, TAU);
    this.sawGain.gain.setTargetAtTime(0.0001 + drive * 0.42, t, TAU);
    this.bodyGain.gain.setTargetAtTime(0.05 + drive * 0.45 * (1 - cruise * 0.4), t, TAU);

    const whine = clamp01((heat - 0.5) * 2);
    this.whineOsc.frequency.setTargetAtTime(1800 + heat * 1600, t, TAU);
    this.whineGain.gain.setTargetAtTime(0.0001 + whine * 0.12, t, TAU);
  }

  /** Momentary boost swell. */
  boost(at?: number): void {
    const t = at ?? this.ctx.currentTime;
    this.master.gain.setTargetAtTime(0.85, t, 0.02);
    this.master.gain.setTargetAtTime(0.5, t + 0.18, 0.12);
  }
}
```

- [ ] **Step 2: Typecheck + format + commit**

```bash
bun run typecheck && bunx oxfmt src/client/audio/drone.ts
git add src/client/audio/drone.ts
git commit -m "feat(audio): add real-time engine drone voice (sub+saw+noise+whine)"
```

---

## Task 4: Mining loop + ambient bed

**Files:**

- Create: `src/client/audio/continuous.ts`

- [ ] **Step 1: Implement**

Create `src/client/audio/continuous.ts`. Two small persistent voices with `start`/`stop`.

```ts
import { createBandpass, createLowpass } from "./synth/filters";
import { createNoiseBuffer } from "./synth/noise";

const TAU = 0.06;

/** Continuous mining laser: gritty bandpassed saw + sub, gated on/off. */
export class MiningVoice {
  private readonly saw: OscillatorNode;
  private readonly sub: OscillatorNode;
  private readonly bp: BiquadFilterNode;
  private readonly gain: GainNode;
  private started = false;

  constructor(ctx: BaseAudioContext, output: AudioNode) {
    this.gain = ctx.createGain();
    this.gain.gain.value = 0.0001;
    this.gain.connect(output);

    this.saw = ctx.createOscillator();
    this.saw.type = "sawtooth";
    this.saw.frequency.value = 116;
    this.bp = createBandpass(ctx, 900, 3);
    this.saw.connect(this.bp);
    this.bp.connect(this.gain);

    this.sub = ctx.createOscillator();
    this.sub.type = "sine";
    this.sub.frequency.value = 58;
    const subGain = ctx.createGain();
    subGain.gain.value = 0.5;
    this.sub.connect(subGain);
    subGain.connect(this.gain);

    this.saw.start();
    this.sub.start();
  }

  setActive(active: boolean, at?: number): void {
    const t = at ?? (this.gain.context.currentTime as number);
    this.gain.gain.setTargetAtTime(active ? 0.4 : 0.0001, t, TAU);
    this.started = active;
  }

  get active(): boolean {
    return this.started;
  }
}

/** Low ambient bed: very-low looped brown noise, always on at low level. */
export class AmbienceVoice {
  private readonly noise: AudioBufferSourceNode;
  private readonly gain: GainNode;

  constructor(ctx: BaseAudioContext, output: AudioNode) {
    this.noise = ctx.createBufferSource();
    this.noise.buffer = createNoiseBuffer(ctx, 3, "brown");
    this.noise.loop = true;
    const lp = createLowpass(ctx, 120, 0.7);
    this.gain = ctx.createGain();
    this.gain.gain.value = 0.0001;
    this.noise.connect(lp);
    lp.connect(this.gain);
    this.gain.connect(output);
  }

  start(at?: number): void {
    const t = at ?? (this.gain.context.currentTime as number);
    this.noise.start(t);
    this.gain.gain.setTargetAtTime(0.12, t, 0.5);
  }
}
```

- [ ] **Step 2: Typecheck + format + commit**

```bash
bun run typecheck && bunx oxfmt src/client/audio/continuous.ts
git add src/client/audio/continuous.ts
git commit -m "feat(audio): add continuous mining loop and ambient bed voices"
```

---

## Task 5: Alarm voice (scheduled two-tone)

**Files:**

- Create: `src/client/audio/alarm.ts`

- [ ] **Step 1: Implement**

Create `src/client/audio/alarm.ts`. Uses the `LookaheadScheduler` to beep a two-tone pattern while active.

```ts
import { applyAr } from "./synth/env";
import { LookaheadScheduler } from "./scheduler";

/** Repeating overheat alarm: scheduled two-tone beeps while active. */
export class AlarmVoice {
  private readonly scheduler: LookaheadScheduler;
  private beat = 0;
  private active = false;

  constructor(
    private readonly ctx: AudioContext,
    private readonly output: AudioNode,
  ) {
    this.scheduler = new LookaheadScheduler(ctx, 0.4, (time) => this.beep(time));
  }

  setActive(active: boolean): void {
    if (active === this.active) {
      return;
    }
    this.active = active;
    if (active) {
      this.scheduler.start();
    } else {
      this.scheduler.stop();
    }
  }

  private beep(time: number): void {
    const osc = this.ctx.createOscillator();
    osc.type = "square";
    osc.frequency.value = this.beat % 2 === 0 ? 740 : 560;
    this.beat += 1;
    const gain = this.ctx.createGain();
    osc.connect(gain);
    gain.connect(this.output);
    applyAr(gain.gain, time, 0.005, 0.08, 0.1, 0.3);
    osc.start(time);
    osc.stop(time + 0.22);
  }
}
```

- [ ] **Step 2: Typecheck + format + commit**

```bash
bun run typecheck && bunx oxfmt src/client/audio/alarm.ts
git add src/client/audio/alarm.ts
git commit -m "feat(audio): add scheduled two-tone overheat alarm voice"
```

---

## Task 6: Wire continuous voices into AudioEngine

**Files:**

- Modify: `src/client/audio/AudioEngine.ts`

- [ ] **Step 1: Add fields + lifecycle**

Import the new voices and `EngineState`/`alarmTransition`:

```ts
import { AlarmVoice } from "./alarm";
import { AmbienceVoice, MiningVoice } from "./continuous";
import { EngineDrone } from "./drone";
import { alarmTransition } from "./events";
import type { BusName, EngineState, OneShotId } from "./types";
```

Add private fields and build them at the end of `init()` (after the bank renders), wiring each to its bus:

```ts
  private drone: EngineDrone | null = null;
  private mining: MiningVoice | null = null;
  private ambience: AmbienceVoice | null = null;
  private alarm: AlarmVoice | null = null;
  private lastHeat = 0;
```

At the end of `init()` (ctx/graph are non-null there):

```ts
this.drone = new EngineDrone(ctx, graph.buses.engine);
this.mining = new MiningVoice(ctx, graph.buses.sfx);
this.ambience = new AmbienceVoice(ctx, graph.buses.sfx);
this.alarm = new AlarmVoice(ctx, graph.buses.alarm);
```

- [ ] **Step 2: Start continuous voices on unlock**

In `unlock()`, after resuming, start the always-on voices once:

```ts
  async unlock(): Promise<void> {
    if (this.ctx !== null) {
      await unlock(this.ctx);
      this.drone?.start();
      this.ambience?.start();
    }
  }
```

- [ ] **Step 3: Public setters**

Add methods:

```ts
  setEngineState(state: EngineState): void {
    this.drone?.setState(state);
    const transition = alarmTransition(this.lastHeat, state.heat);
    if (transition === "on") {
      this.alarm?.setActive(true);
    } else if (transition === "off") {
      this.alarm?.setActive(false);
    }
    this.lastHeat = state.heat;
  }

  setMining(active: boolean): void {
    this.mining?.setActive(active);
  }
```

- [ ] **Step 4: Drone boost on the boost one-shot**

In `playOneShot`, after firing a one-shot, if `id === "boost"` also swell the drone:

```ts
if (id === "boost") {
  this.drone?.boost();
}
```

(Place it right before `source.start();` or right after — order is not critical.)

- [ ] **Step 5: Dispose**

In `dispose()`, stop the alarm scheduler to avoid a leaked interval:

```ts
this.alarm?.setActive(false);
```

- [ ] **Step 6: Typecheck + format + commit**

```bash
bun run typecheck && bunx oxfmt src/client/audio/AudioEngine.ts
git add src/client/audio/AudioEngine.ts
git commit -m "feat(audio): wire drone, mining, ambience, and alarm into the facade"
```

---

## Task 7: Feed engine state + mining from EveApp

**Files:**

- Modify: `src/client/eve/EveApp.tsx`

- [ ] **Step 1: Feed EngineState each flight tick**

The flight-input `setInterval` (the one calling `sendFlightInput(buildFlightInput(active))` every `flightInputIntervalMs`) is the right cadence. Inside that interval callback, after the existing body, add a state push. `myShip` carries `heat`, `throttle`, `cruiseLock`, and a velocity vector; `effectiveThrottle` is already computed in render scope but not in the interval — read from `flightStateRef`/`myShip` instead. Add inside the interval callback:

```ts
const ship = sessionRef.current === null ? null : myShipRef.current;
if (ship !== null) {
  audio.engine.setEngineState({
    throttle: ship.throttle,
    boost: false,
    heat: ship.heat,
    cruiseLock: ship.cruiseLock,
    speed: Math.hypot(ship.velocity.x, ship.velocity.y, ship.velocity.z),
  });
}
```

To make `myShip` available inside the interval without re-subscribing the effect, add a ref that always mirrors it. Near the other refs (e.g. after `const syncedFlightPilotRef = ...`), add:

```ts
const myShipRef = useRef<Ship | null>(null);
```

and a sync effect after the `myShip` useMemo:

```ts
useEffect(() => {
  myShipRef.current = myShip;
}, [myShip]);
```

Confirm the `Ship` type is imported (it is, in the type import block) and that `myShip.velocity` exists on the `Ship` type — if the field is named differently (e.g. `vel`), use the actual field. If `Ship` has no velocity vector, set `speed: 0` and note it.

- [ ] **Step 2: Toggle mining on mine begin/end**

`mineDeposit` runs via `withAction(\`mine-${deposit.id}\`, ...)`. Wrap the active window: set mining on before the await and off after. Change `mineDeposit`'s body to:

```ts
function mineDeposit(deposit: Deposit): void {
  if (session === null) {
    return;
  }
  void withAction(`mine-${deposit.id}`, async () => {
    audio.engine.setMining(true);
    try {
      await mine(session.pilot.id, {
        asteroidId: deposit.asteroidId,
        depositId: deposit.id,
      });
    } finally {
      audio.engine.setMining(false);
    }
  });
}
```

- [ ] **Step 3: Typecheck + format**

Run: `bun run typecheck && bunx oxfmt src/client/eve/EveApp.tsx`
Expected: PASS. (If `Ship.velocity` typing fails, adjust per Step 1's note.)

- [ ] **Step 4: Commit**

```bash
git add src/client/eve/EveApp.tsx
git commit -m "feat(audio): feed live engine state and mining toggle from EveApp"
```

---

## Task 8: Offline drone capture for review + verification

**Files:**

- Modify: `src/client/audio/renderEntry.ts`
- Modify: `tests/e2e/audio.ts`

- [ ] **Step 1: Add a scripted drone capture**

In `renderEntry.ts`, add a capture that builds the drone in an OfflineAudioContext and automates `setState` over ~6 s (idle → full throttle → overheat whine → back), so reviewers hear the dynamic range. Import:

```ts
import { EngineDrone } from "./drone";
```

Add a helper and include it in `renderSamples` output:

```ts
async function renderDroneCapture(): Promise<RenderedSample> {
  const seconds = 6;
  const ctx = new OfflineAudioContext(1, Math.ceil(seconds * SAMPLE_RATE), SAMPLE_RATE);
  const drone = new EngineDrone(ctx, ctx.destination);
  drone.start(0);
  drone.setState({ throttle: 0, boost: false, heat: 10, cruiseLock: false, speed: 0 }, 0);
  drone.setState({ throttle: 1, boost: false, heat: 20, cruiseLock: false, speed: 80 }, 1.5);
  drone.boost(2.5);
  drone.setState({ throttle: 1, boost: false, heat: 95, cruiseLock: false, speed: 90 }, 3);
  drone.setState({ throttle: 0.3, boost: false, heat: 60, cruiseLock: true, speed: 30 }, 4.5);
  const buffer = await ctx.startRendering();
  return {
    name: "engineDrone",
    sampleRate: SAMPLE_RATE,
    pcm: Array.from(buffer.getChannelData(0)),
  };
}
```

Then in `renderSamples`, after the one-shot loop, push the capture:

```ts
out.push(await renderDroneCapture());
```

- [ ] **Step 2: Verify drone capture non-silent**

In `tests/e2e/audio.ts`, add `engineDrone` to expected durations and (since it's a 6 s capture, not a one-shot) allow a wider tolerance for it specifically:

```ts
  engineDrone: 6,
```

If the existing duration assertion is too tight for the 6 s capture, special-case `engineDrone` to tolerance `< 0.2s`. Keep the non-silence assertion strict (peak > 0.02).

- [ ] **Step 3: Run verification + render**

Run: `bun tests/e2e/audio.ts`
Expected: `audio verification passed: 9 sample(s)`, exit 0.

Run: `bun run render:sfx`
Expected: nine `wrote .../samples/*.wav` lines including `engineDrone.wav`, all peaks > 0.02.

Run: `bun run verify`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/client/audio/renderEntry.ts tests/e2e/audio.ts
git commit -m "feat(audio): add scripted engine-drone offline capture for review"
```

- [ ] **Step 5: Report**

Report all commits (SHAs), the full `bun run render:sfx` stdout (nine lines), `bun tests/e2e/audio.ts` output, `bun run verify` result, and whether `Ship.velocity` existed (or how speed was sourced). The controller will DM `engineDrone.wav` + any retuned one-shots.

---

## Self-review notes (author)

- **Spec coverage:** §5 continuous rows — engine drone ✓ (Task 3), mining ✓ (Task 4), ambience ✓ (Task 4), overheat alarm ✓ (Tasks 1,2,5); §7 smoothing (`setTargetAtTime`, Task 3) ✓ and lookahead scheduling (Task 1) ✓; §4 live state feed ✓ (Task 7). **Deferred to Plan 4:** 3D PositionalAudio spatialization for remote ships, and the repeating _scan-pulse_ loop (the discrete `scanHonk` already covers scan feedback in Plan 2).
- **Placeholder scan:** complete code throughout; the only conditional is the `Ship.velocity` field name, with an explicit fallback.
- **Type consistency:** reuses `EngineState`, `BusName`, `OneShotId`, `RenderedSample`, `renderSamples`, `LookaheadScheduler`, `alarmTransition`, `EngineDrone` consistently.
- **Leak guard:** the alarm scheduler interval is stopped in `dispose()` (Task 6 Step 5) and on `setActive(false)`.
- **Offline-safe:** drone/mining/ambience use only nodes valid on `OfflineAudioContext`, enabling the Task 8 capture; the alarm uses `setInterval` so it is live-only (not part of the offline capture) — intentional.
- **Aesthetic caveat:** drone mapping constants are first-pass; tune by ear after the Discord capture.
