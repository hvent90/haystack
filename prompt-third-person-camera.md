# Goal: Third-Person View + EVE-Style Camera Controls in Cursor Mode

Add a third-person camera to Haystack and, when the player is in third person with the
cursor free, make the camera behave like EVE Online's: click-drag orbits the camera around
your ship, the scroll wheel zooms in and out, and none of it touches the ship's actual
orientation. The end state: you can pop the cursor (`LeftAlt`), drag to swing the camera
around your own ship, zoom out to take in the belt, and your ship keeps flying exactly as it
was — then re-lock and fly normally from either view.

## Source Of Truth

This file is the contract for this loop. Re-read it before each implementation pass.

## Why This Exists

Haystack is currently first-person only: the camera sits at a fixed cockpit offset
(`[0, 0.12, 0]`) and mirrors the ship quaternion every frame in `RenderDriver`
(`src/client/eve/components/WorldView.tsx:1063–1137`). The local player has no rendered
ship — only other pilots get the cone mesh + nav lights (`OtherShipMesh`). That means the
player can never see their own ship, their own lights, or themselves in context against the
field. The game's identity is scale — a tiny ship against an enormous belt — and a
third-person orbit camera is how the player actually experiences that. EVE's camera is the
reference because it solves exactly this problem: ship motion and camera framing are fully
decoupled, and the camera is an observation tool you steer with the cursor.

## Current Architecture (audit these before writing code)

- **Camera drive:** `RenderDriver` in `src/client/eve/components/WorldView.tsx` (useFrame)
  reads the smoothed owned-ship transform from `flightRenderStore.ownedRenderQuaternion()`
  (`src/client/eve/renderStore.ts`) and writes `camera.position` / `camera.quaternion`
  directly each frame. Camera state is exposed for tests via `window.__probe`
  (`WorldView.tsx:~1120`).
- **Modes:** `flightMode: "cursor" | "flight"` in `src/client/eve/EveApp.tsx` (state at
  ~line 154, `FlightMode` type in `src/client/eve/types.ts`). `LeftAlt` toggles pointer
  lock via `toggleFlightLock()`; `pointerlockchange` is the source of truth. In cursor
  mode all flight input is suspended and mouse deflection decays (`relativeMouseDecay`).
- **Mouse/wheel:** pointer-locked `mousemove` deltas feed `mouseDeflectionRef` →
  `FlightInputCommand.rotation` at ~60 Hz. The wheel currently adjusts `flightInputScale`
  and early-returns when not in flight mode (`EveApp.tsx:~470`) — so the wheel is **free**
  in cursor mode.
- **Local ship invisible:** `WorldView.tsx:~214` filters ships by
  `pilotId !== myShip.pilotId`; only remote ships render (cone, nav lights, flashlight).
- **Netcode:** the camera is purely client-side. Ship orientation replicates via
  `FlightInputCommand`; nothing in this goal touches the server.

## What To Build

### 1 — View mode + local ship rendering

- A camera-view toggle, first-person ↔ third-person, on a key (suggest `V`), independent
  of `flightMode` — view mode is _what you see_, flight mode is _what the mouse controls_.
  Keep it client-side state; do not overload the `FlightMode` union.
- In third person, render the local player's ship using the same visual treatment remote
  ships get (mesh, nav lights, flashlight cone), driven from `flightRenderStore`'s owned
  transform so it's frame-smooth, not snapshot-stepped. The local ship must not render in
  first person (no cockpit clipping), and the pilotId filter for remote ships stays intact.
- First-person behavior, the reticle, and the HUD must be unchanged when in first-person
  view. In third person, decide what the reticle means (hide it, or project it along the
  ship's nose) and record the decision.

### 2 — Third-person chase camera (flight mode)

- While pointer-locked in third person, the camera follows behind/above the ship (a chase
  offset in ship space) and mouse steering works exactly as it does today — the ship
  turns, the camera follows. Add light smoothing/lag if it reads better; keep it subtle.
- The orbit state from cursor mode (below) should blend back gracefully when the player
  re-locks: no camera snap. A short eased recentering to the chase offset is the expected
  shape.

### 3 — EVE-style orbit camera (third person + cursor mode)

This is the heart of the goal. When in third person and `flightMode === "cursor"`:

- **Click-drag orbits.** Holding a mouse button (left-drag is EVE's; make sure it doesn't
  fight UI clicks — drag threshold or right/middle-drag fallback are both acceptable,
  record the choice) rotates the camera around the ship's render position: yaw around
  world/ship up, pitch clamped short of the poles. The cursor stays visible; no pointer
  lock.
- **Wheel zooms.** Scroll adjusts orbit distance, exponentially scaled (each notch
  multiplies distance) so zoom feels uniform from hull-filling close to far enough out
  that the ship is a speck against the field. Clamp min (don't enter the hull) and max
  (stay inside `far: 20000` with sane fog/visibility). The wheel already early-returns
  for `flightInputScale` outside flight mode, so this is free real estate — but make sure
  zoom does **not** also bleed into `flightInputScale`.
- **Fully decoupled.** Orbiting and zooming never write to `mouseDeflectionRef`, never
  emit `FlightInputCommand` rotation, and never change ship state. The ship keeps flying
  on its current inputs (throttle/cruise persist in cursor mode today — keep that).
- **The camera tracks the ship.** The orbit pivot follows the ship's smoothed position
  each frame, so a moving ship stays centered while you orbit.
- Dragging on HUD/UI elements must still work — orbit only engages on stage/canvas drags.

### 4 — Discoverability + polish

- Add keybind hints to the HUD cluster (`src/client/eve/components/HudCluster.tsx`,
  static `<kbd>` spans at ~200–215): the view toggle key, and drag-to-orbit / scroll-zoom
  hints shown when they apply.
- Persist the chosen view mode and orbit distance across the session (in-memory is fine;
  localStorage is fine too if trivial).
- Update `docs/flight-controls.md`, which currently lists chase-cam as deferred.

## Constraints

- TypeScript, strict, Bun, `oxfmt` — repo standards. Client-only change: no server code,
  no shared-protocol changes, no netcode changes. Remote players must be unaffected.
- Do not regress the render path: `RenderDriver` stays the single writer of the camera
  transform per frame, driven from `flightRenderStore` (no React-state-per-frame camera).
  Keep `window.__probe` camera exposure working — tests depend on it; extend it with
  view-mode/orbit state rather than breaking its shape.
- Don't add features beyond this contract — no free-cam, no cinematic modes, no settings
  UI, no refactors of input handling beyond what the camera needs.

## Working Rules

- You are operating autonomously. For reversible actions that follow from this contract,
  proceed without asking. Pause only for destructive actions, real scope changes, or
  input only the user can provide — and if you hit one, ask and end the turn rather than
  ending on a promise.
- Start by auditing `WorldView.tsx` (camera + RenderDriver + OtherShipMesh),
  `EveApp.tsx` (flight mode, pointer lock, mouse/wheel handlers), `renderStore.ts`, and
  `docs/flight-controls.md` so the integration surface is understood before writing code.
- Work in scoped, verifiable passes (view toggle + local ship → chase cam → orbit cam →
  polish). After each slice run typecheck, format, and the relevant verify subset.
- Before reporting progress, audit each claim against a tool result from this session.
  Only report work you can point to evidence for; if tests fail, say so with the output.
- DM the user screenshots on Discord (`discord-dm` skill) as visual milestones land —
  first sight of the local ship in third person, orbit sweep angles, max-zoom ship-as-a-
  speck against the belt. Short captions are enough; don't wait for "done."

## Completion Criteria

Do not call the goal complete until all of the following are true, with evidence:

- Toggling the view key switches first ↔ third person; in third person the local ship is
  visible with nav lights/flashlight, frame-smooth under thrust and rotation; in first
  person nothing changed (screenshot pair proving both).
- In third person + flight mode, mouse steering flies the ship with the chase camera
  following, no snap when transitioning lock states.
- In third person + cursor mode, drag orbits the camera 360° in yaw with clamped pitch,
  wheel zooms exponentially between sane clamps, and a probe-based check proves ship
  orientation/`FlightInputCommand` are untouched while orbiting and zooming.
- UI remains clickable in cursor mode (orbit doesn't eat HUD interactions), and the wheel
  no longer needs flight mode to do something useful — but `flightInputScale` behavior in
  flight mode is unchanged.
- HUD shows the new keybind hints; `docs/flight-controls.md` is updated.
- An e2e test in `tests/e2e/` (Playwright, via `window.__probe`) covers the view toggle
  and orbit/zoom decoupling, and `bun run verify`, `verify:screenshot`, `verify:ui`, and
  `verify:multiplayer` all pass.
- The final report lists commands run, screenshot paths, and any intentionally deferred
  work — without hiding missing criteria.
