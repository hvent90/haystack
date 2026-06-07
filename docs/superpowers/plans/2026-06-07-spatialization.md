# 3D Spatialization Plan (Plan 4 of 4)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Spatialize remote ships' engine audio in 3D using Three.js `AudioListener` + `PositionalAudio` over the SHARED Web Audio context, so other pilots' ships sound positioned/attenuated in space, controllable via the engine mix.

**Architecture:** `THREE.AudioContext.setContext(sharedCtx)` makes Three reuse our `AudioEngine`'s `AudioContext`. An `AudioListener` mounts on the cockpit camera (listener = me). Each `OtherShipMesh` mounts a `PositionalAudio` whose source is a lightweight always-on spatial drone (`setNodeSource`) — the Three panner attenuates/pans it by the ship's rebased scene position automatically each frame. The listener master volume is driven from the engine bus mix. React component lifecycle (ships are keyed by `pilotId`) handles per-voice create/dispose — no manual diffing.

**Tech Stack:** Three.js r177 (`AudioListener`, `PositionalAudio`, `AudioContext.setContext`), React Three Fiber, the existing `AudioEngine`. No new deps.

**Spec:** `docs/superpowers/specs/2026-06-07-procedural-sfx-design.md` §6.

> **Working dir:** worktree `/Users/hv/repos/haystack-procedural-sfx`, branch `procedural-sfx`. After every task: `bun run typecheck` + `bunx oxfmt .` pass before commit.
> **Scope cut (YAGNI):** the repeating "scan-pulse" loop from the spec is intentionally dropped — the discrete `scanHonk` (Plan 2) already gives scan feedback. Note it; do not build it.
> **Verification reality:** 3D panning cannot be asserted from a rendered `.wav` (it's live/positional). Verification here = pure-logic unit test for the volume mapping + `bun run verify` green + the existing screenshot e2e confirming `WorldView` still mounts with the audio layer (no crash, gesture-gated).

---

## Task 1: Spatial master-volume mapping (pure, TDD) + expose the context

**Files:**

- Create: `src/client/audio/spatial.ts`
- Test: `tests/audio/spatial.test.ts`
- Modify: `src/client/audio/AudioEngine.ts`

- [ ] **Step 1: Failing test**

Create `tests/audio/spatial.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { defaultMix, setBus, setMaster, setMuted } from "../../src/client/audio/mix";
import { spatialMasterVolume } from "../../src/client/audio/spatial";

describe("spatialMasterVolume", () => {
  test("is master * engine bus when unmuted", () => {
    const mix = setBus(setMaster(defaultMix(), 0.5), "engine", 0.6);
    expect(spatialMasterVolume(mix)).toBeCloseTo(0.3, 5);
  });
  test("is zero when muted", () => {
    expect(spatialMasterVolume(setMuted(defaultMix(), true))).toBe(0);
  });
});
```

- [ ] **Step 2: Run — fails.** `bun test tests/audio/spatial.test.ts` — FAIL (no module).

- [ ] **Step 3: Implement spatial.ts**

Create `src/client/audio/spatial.ts`:

```ts
import { createLowpass } from "./synth/filters";
import { createNoiseBuffer } from "./synth/noise";
import type { MixState } from "./mix";

/** Listener master volume for spatialized sources, derived from the engine bus mix. */
export function spatialMasterVolume(mix: MixState): number {
  return mix.muted ? 0 : mix.master * mix.buses.engine;
}

export interface SpatialDrone {
  output: AudioNode;
  dispose(): void;
}

/**
 * Lightweight always-on engine voice for a remote ship: low saw + filtered brown
 * noise summed into a gain. Fed to a THREE.PositionalAudio via setNodeSource; the
 * panner handles distance/direction. Simpler than the local EngineDrone on purpose.
 */
export function createSpatialDrone(ctx: BaseAudioContext): SpatialDrone {
  const output = ctx.createGain();
  output.gain.value = 0.6;

  const saw = ctx.createOscillator();
  saw.type = "sawtooth";
  saw.frequency.value = 68;
  const sawGain = ctx.createGain();
  sawGain.gain.value = 0.25;
  saw.connect(sawGain);
  sawGain.connect(output);

  const noise = ctx.createBufferSource();
  noise.buffer = createNoiseBuffer(ctx, 2, "brown");
  noise.loop = true;
  const lp = createLowpass(ctx, 480, 0.8);
  const noiseGain = ctx.createGain();
  noiseGain.gain.value = 0.5;
  noise.connect(lp);
  lp.connect(noiseGain);
  noiseGain.connect(output);

  saw.start();
  noise.start();

  return {
    output,
    dispose(): void {
      try {
        saw.stop();
      } catch {
        // already stopped
      }
      try {
        noise.stop();
      } catch {
        // already stopped
      }
      output.disconnect();
    },
  };
}
```

- [ ] **Step 4: Run — passes.** `bun test tests/audio/spatial.test.ts` — PASS (2 tests).

- [ ] **Step 5: Expose the context on the facade**

In `src/client/audio/AudioEngine.ts`, add a getter (the `ctx` is set synchronously at the start of `init()`):

```ts
  getContext(): AudioContext | null {
    return this.ctx;
  }
```

- [ ] **Step 6: Typecheck + format + commit**

```bash
bun run typecheck && bunx oxfmt src/client/audio/spatial.ts tests/audio/spatial.test.ts src/client/audio/AudioEngine.ts
git add src/client/audio/spatial.ts tests/audio/spatial.test.ts src/client/audio/AudioEngine.ts
git commit -m "feat(audio): add spatial drone factory + volume mapping + context getter"
```

---

## Task 2: R3F audio components (listener rig + per-ship positional voice)

**Files:**

- Create: `src/client/eve/components/SpatialAudio.tsx`

- [ ] **Step 1: Implement the components**

Create `src/client/eve/components/SpatialAudio.tsx`. The rig attaches an `AudioListener` to the camera over the shared context and provides it via React context; `RemoteShipAudio` mounts a `PositionalAudio` (as an R3F `<positionalAudio>` so it lives in the scene graph and tracks its parent's transform).

```tsx
import { useThree } from "@react-three/fiber";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { AudioContext as ThreeAudioContext, AudioListener, PositionalAudio } from "three";

import { createSpatialDrone } from "../../audio/spatial";

const ListenerContext = createContext<AudioListener | null>(null);

/** Mounts an AudioListener on the camera over the shared context; provides it downward. */
export function AudioListenerRig({
  ctx,
  volume,
  children,
}: {
  ctx: AudioContext;
  volume: number;
  children: ReactNode;
}): ReactNode {
  const camera = useThree((state) => state.camera);
  const [listener, setListener] = useState<AudioListener | null>(null);

  useEffect(() => {
    ThreeAudioContext.setContext(ctx);
    const created = new AudioListener();
    camera.add(created);
    setListener(created);
    return () => {
      camera.remove(created);
      setListener(null);
    };
  }, [camera, ctx]);

  useEffect(() => {
    listener?.setMasterVolume(volume);
  }, [listener, volume]);

  return <ListenerContext.Provider value={listener}>{children}</ListenerContext.Provider>;
}

/** A positional engine voice for one remote ship; lives inside the ship's group. */
export function RemoteShipAudio({ ctx }: { ctx: AudioContext }): ReactNode {
  const listener = useContext(ListenerContext);
  const ref = useRef<PositionalAudio | null>(null);

  useEffect(() => {
    const positional = ref.current;
    if (positional === null) {
      return;
    }
    const drone = createSpatialDrone(ctx);
    positional.setNodeSource(drone.output);
    positional.setRefDistance(0.6);
    positional.setRolloffFactor(1.6);
    positional.setMaxDistance(40);
    return () => {
      drone.dispose();
      try {
        positional.disconnect();
      } catch {
        // already disconnected
      }
    };
  }, [ctx, listener]);

  if (listener === null) {
    return null;
  }
  return <positionalAudio ref={ref} args={[listener]} />;
}
```

- [ ] **Step 2: Typecheck + format + commit**

```bash
bun run typecheck && bunx oxfmt src/client/eve/components/SpatialAudio.tsx
git add src/client/eve/components/SpatialAudio.tsx
git commit -m "feat(audio): add R3F listener rig and per-ship positional voice"
```

---

## Task 3: Wire spatial audio into WorldView + thread context from EveApp

**Files:**

- Modify: `src/client/eve/components/WorldView.tsx`
- Modify: `src/client/eve/EveApp.tsx`

- [ ] **Step 1: Accept audio props on WorldView**

In `WorldView.tsx`, add two props to the `WorldView` function's destructured params and its type:

```ts
  audioContext,
  audioVolume,
```

and in the type block (alongside `onRequestFlightLock`):

```ts
audioContext: AudioContext | null;
audioVolume: number;
```

- [ ] **Step 2: Import the components**

Add to `WorldView.tsx` imports:

```ts
import { AudioListenerRig, RemoteShipAudio } from "./SpatialAudio";
```

- [ ] **Step 3: Wrap the scene in the rig and add per-ship audio**

In the JSX, wrap the existing `<group>` (the one containing `GridStars`, asteroids, structures, ships) with the rig WHEN a context exists. Replace the `<group>...</group>` block with:

```tsx
<ConditionalListenerRig ctx={audioContext} volume={audioVolume}>
  <group>
    <GridStars />
    <InstancedAsteroids asteroids={asteroids} origin={myShip.position} />
    {structures.map((structure) => (
      <StructureMesh key={structure.id} structure={structure} origin={myShip.position} />
    ))}
    {ships
      .filter((ship) => ship.pilotId !== myShip.pilotId)
      .map((ship) => (
        <OtherShipMesh
          key={ship.pilotId}
          ship={ship}
          origin={myShip.position}
          audioContext={audioContext}
        />
      ))}
  </group>
</ConditionalListenerRig>
```

- [ ] **Step 4: Add the conditional rig wrapper + extend OtherShipMesh**

Add this helper near the other component functions in `WorldView.tsx` (it renders the rig only when a context exists, otherwise passes children through):

```tsx
function ConditionalListenerRig({
  ctx,
  volume,
  children,
}: {
  ctx: AudioContext | null;
  volume: number;
  children: ReactNode;
}): ReactNode {
  if (ctx === null) {
    return <>{children}</>;
  }
  return (
    <AudioListenerRig ctx={ctx} volume={volume}>
      {children}
    </AudioListenerRig>
  );
}
```

Then change `OtherShipMesh` to accept `audioContext` and render the positional voice inside a group with the mesh:

```tsx
function OtherShipMesh({
  ship,
  origin,
  audioContext,
}: {
  ship: Ship;
  origin: { x: number; y: number; z: number };
  audioContext: AudioContext | null;
}): ReactNode {
  const position = toScene(ship.position, origin);
  return (
    <group position={[position.x, position.y, position.z]}>
      <mesh scale={[0.08, 0.08, 0.08]}>
        <coneGeometry args={[0.6, 1.4, 4]} />
        <meshStandardMaterial color="#b54f57" roughness={0.7} />
      </mesh>
      {audioContext !== null ? <RemoteShipAudio ctx={audioContext} /> : null}
    </group>
  );
}
```

Ensure `ReactNode` is imported in `WorldView.tsx` (it already imports types from react — confirm `ReactNode` is among them; the file imports `type { ... ReactNode ... }` already on line 2).

- [ ] **Step 5: Pass the props from EveApp**

In `src/client/eve/EveApp.tsx`, import the volume helper:

```ts
import { spatialMasterVolume } from "../audio/spatial";
```

On the `<WorldView ... />` element, add (gate the context on `unlocked` so it only spatializes after the audio is live):

```tsx
        audioContext={audio.unlocked ? audio.engine.getContext() : null}
        audioVolume={spatialMasterVolume(audio.mix)}
```

- [ ] **Step 6: Typecheck + format + commit**

```bash
bun run typecheck && bunx oxfmt src/client/eve/components/WorldView.tsx src/client/eve/EveApp.tsx
git add src/client/eve/components/WorldView.tsx src/client/eve/EveApp.tsx
git commit -m "feat(audio): spatialize remote-ship engines via PositionalAudio in WorldView"
```

---

## Task 4: Verify the whole system still holds

**Files:** none (verification)

- [ ] **Step 1: Full verify**

Run: `bun run verify`
Expected: PASS — typecheck clean, format clean, integration tests pass, all audio unit tests (mix, scheduler, events, spatial, jsfxr) pass.

- [ ] **Step 2: Audio render still green**

Run: `bun tests/e2e/audio.ts`
Expected: `audio verification passed: 9 sample(s)`, exit 0 (spatialization adds no offline samples; this confirms nothing regressed).

- [ ] **Step 3: Confirm WorldView still mounts with the audio layer**

Run: `bun run verify:screenshot`
Expected: completes and writes the screenshots without error (this exercises the real client in chromium — confirms the `AudioListenerRig`/`PositionalAudio` additions don't crash the R3F tree; spatial audio is gesture-gated so it may stay dormant, which is fine — we're asserting no crash + the canvas renders).

- [ ] **Step 4: Report**

Report: all commits (SHAs), `bun run verify` result, `bun tests/e2e/audio.ts` output, whether `bun run verify:screenshot` succeeded (and any console errors observed), and status. The controller will then merge `procedural-sfx` to `main`.

---

## Self-review notes (author)

- **Spec coverage:** §6 spatialization — `AudioListener` on camera ✓, `PositionalAudio` per remote ship over the shared context ✓, mix-controlled via engine bus volume ✓. Own-ship audio stays non-positional (Plans 1-3). Scan-pulse loop explicitly cut (YAGNI).
- **Placeholder scan:** complete code; the only conditional is context presence, handled by `ConditionalListenerRig` + the `unlocked` gate.
- **Type consistency:** reuses `MixState`, `spatialMasterVolume`, `createSpatialDrone`, `AudioListener`/`PositionalAudio`; `getContext()` added once.
- **Lifecycle:** per-ship voices create/dispose with the keyed `OtherShipMesh` (un)mount; the listener is removed from the camera on rig unmount; spatial drones `dispose()` (stop oscillators + disconnect) on ship unmount.
- **Safety:** gesture-gated via `unlocked`, so the e2e/screenshot path (no/late gesture) does not create audio nodes prematurely and cannot crash the canvas. Worst case with many ships = many lightweight voices; a concurrency cap is a future optimization, noted not built.
- **Known risk:** `THREE.AudioContext.setContext` + R3F `<positionalAudio args={[listener]}>` reconciliation — if R3F's catalogue doesn't auto-resolve `positionalAudio`, construct the `PositionalAudio` imperatively in the effect and `parent.add(it)` via a parent `ref` instead. The pure volume mapping + facade getter are unaffected either way.
