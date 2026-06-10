# Flight Controls: Elite-Dangerous-style KB/M flight for Haystack

> **Status:** Baseline implemented in the `flight-controls` worktree; still a design
> contract for follow-up tuning.
> **Scope:** Recreate the _feel_ of Elite Dangerous flight for **keyboard + mouse only**
> (no joystick/HOTAS), fitted to Haystack's existing zero-g, heat-costed, multiplayer model.
> **Audience:** the `/goal` loop and anyone implementing the flight model.
> Every non-obvious claim about the current build cites `src/<path>`.

> **Implementation note:** The historical gap analysis below describes the pre-flight-controls
> baseline that existed when this contract was written. The current implementation now includes
> ship orientation, angular velocity, ship-local thrust, streamed KB/M flight input, heat-costed
> linear/angular stabilization, boost, cruise lock, pointer-lock mouse steering, and an
> orientation-following camera.

This document answers two questions: _what will a KB/M player who knows Elite
Dangerous expect the controls to do?_ and _what concretely needs to be built to
meet those expectations without violating `goal.md`?_ It is grounded in the current
code, not aspiration — read `goal.md` (the product contract) and
`docs/engine/*` (the real-time architecture) alongside it.

---

## 1. TL;DR

- **The one expectation that dominates all others:** the player will grab the **mouse to point the ship's nose** and tap **throttle keys to set-and-hold a speed**, expecting the ship to fly _where it is looking_ — ship-relative, momentum-managed flight that feels like piloting a craft.
- **The one structural gap that blocks all of it:** Haystack has **no ship orientation anywhere** — no quaternion, no facing vector, no angular velocity (`src/shared/types.ts` `Ship`, `src/server/sim.ts` `ShipRow`). Thrust is pure **world-absolute impulse fired one click at a time** (`applyThrust`, `src/server/sim.ts`; the Flight buttons in `src/client/App.tsx`). There is literally no "nose" to point and no continuous input channel to point it with, so the central ED reflex (mouse-look + throttle) binds to _nothing_. Everything else is downstream of that one absence.
- **The native bridge that ships first:** Haystack already has a first-class **heat economy** and a **signature/stealth** theme. That maps onto ED's heat / Silent Running / "burn for performance" mental model _almost for free_ and needs none of the orientation plumbing. **Lead with heat + a HUD steering compass; treat nose-where-you-point as the keystone investment it is.**
- **The single most important design inversion:** ED defaults Flight Assist **ON** (free, always-on). `goal.md` mandates **no default assist** plus a **heat-costed Stabilizer**. So Haystack's _default is drift_ and _assist is a rationed resource_. This must be taught loudly, or every ED reflex misfires (§4).

---

## 2. The current model (grounded)

So the doc is self-contained, here is exactly how flight works today.

| Aspect           | Current behavior                                                                                                                                                                                                   | Source                                                                |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- | ------------------- | --------------------------------- |
| Thrust frame     | **World-absolute.** `applyThrust(impulse:{x,y,z})` adds impulse straight to velocity. "Forward" is a hardwired `z-8`.                                                                                              | `src/server/sim.ts` `applyThrust`; `src/client/App.tsx` Flight window |
| Orientation      | **None.** No quaternion, no facing vector, no angular velocity in `Ship`/`ShipRow`/`ThrustCommand`.                                                                                                                | `src/shared/types.ts`, `src/server/sim.ts`                            |
| Integration      | **Newtonian, no drag.** `position += velocity * dt` each tick; velocity persists forever.                                                                                                                          | `src/server/sim.ts` `advanceWorld`                                    |
| Impulse limit    | Server clamps `                                                                                                                                                                                                    | impulse                                                               | <= 12` per command. | `src/server/sim.ts` `clampVector` |
| Braking / assist | **Stabilizer only:** apply impulse, then multiply velocity by `(1 - stabilizerEfficiency)` (≤0.82) toward **world-zero**, and add ~18 heat. **Locked out at heat ≥ 96.** Momentary, per-command flag — not a mode. | `src/server/sim.ts` `applyThrust`                                     |
| Heat             | Thrust/scan/mine/stabilize all add heat; decays ~0.85/s; caps at 100.                                                                                                                                              | `src/server/sim.ts`                                                   |
| Input transport  | One impulse **per click** over WebSocket (clientTick-stamped) or HTTP RPC; UI buttons sit behind a serializing `busy` mutex. No held input, no per-frame sampler, no mouse-look.                                   | `src/client/App.tsx` `thrust`/`withAction`; `src/server/realtime.ts`  |
| Camera           | **Fixed** `[0,9,18]` frame; the ship is pinned at scene origin and the world is floating-origin-rebased (÷9000) around it. The ship mesh idly spins for flavor — it does not represent facing.                     | `src/client/App.tsx` `WorldView`/`toScene`                            |
| Scale            | Station ~7,100 m; "discovered" within ~55,000 m; scan reach ~52,000 m; impulse ~8 m/s/press; **no speed cap**.                                                                                                     | `src/server/sim.ts`, `src/server/field.ts`                            |

The throughline: **ED hides momentum and gives you a craft that obeys the reticle for free. Haystack exposes raw Newtonian momentum and charges heat for every scrap of comfort.** An ED player expects a craft; Haystack currently hands them a hockey puck in vacuum.

---

## 3. The mental model an ED KB/M pilot brings

Four reflexes, each colliding with Haystack's reality. Note up front that the
"mouse-as-virtual-joystick" feel veterans expect is itself **not ED's stock
behavior** — auto-centering _Relative Mouse_ is an option you enable. Our scheme
(§5) deliberately keeps **yaw on mouse-X, which _is_ ED's default**, and puts roll
on the keyboard — a choice that fits a scan/mine game where roll is rarely
load-bearing.

| ED mental model                                | What it means                                                                                                                                                                                                                                       | Haystack today                                                                                                                                            |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Nose-where-you-point, ship-relative flight** | Mouse deflects a _virtual joystick_ (rate control, not snap-aim); the ship rotates toward where you push and thrust is relative to facing.                                                                                                          | No orientation, no facing, no rotation. Impulse is raw world axes. There is no nose.                                                                      |
| **Set-and-hold throttle**                      | Throttle is a persistent 0→100% (−100% reverse) **setpoint**. On keyboard W/S **step** it (they don't ramp-while-held); 25/50/75/100% direct-set keys exist. Set it, release, cruise. `X` = throttle zero (FA then stops you).                      | No setpoint, no throttle, no "go" state. Every press is one momentary impulse. Velocity persists forever — only "accumulate speed," never "hold a speed." |
| **Mouse-as-joystick**                          | With Relative Mouse: deflection → angular _rate_; hold off-center to keep turning, recenter to stop. Lore: pitch strong, yaw deliberately weak, roll fast — "roll to reposition, then pitch onto target."                                           | No mouse-look at all. The only input surface is six world-axis buttons behind a serializing mutex.                                                        |
| **FA-as-baseline ("craft" feel)**              | Flight Assist ON by default, free, always-on: nulls rotation on release, holds throttle-set speed, caps top speed. (FA-**off** is still Newtonian with capped thruster strength — the closest analog to how Haystack already flies _all the time_.) | **Inverted.** No default assist. The only assist is the heat-costed Stabilizer. Drift is default; comfort is the metered exception.                       |

---

## 4. The Flight-Assist inversion (the most important mapping)

This is the mapping most likely to be gotten wrong by copying ED literally.

In ED, **Flight Assist is the free, always-on baseline.** Release the stick and
rotation nulls; the computer holds your throttle-set max speed. FA-OFF (`Z`, a
toggle defaulting to hold-to-disable) is the deliberate, skill-gated _exception_.
The player's entire muscle memory assumes **comfort is the default and costs nothing.**

Haystack mandates the polar opposite (`goal.md`): the **default is FA-OFF-like pure
Newtonian drift**, and the only assist is the **Stabilizer** — a momentary, partial
velocity-kill toward world-zero that spends ~18 heat and **locks out at heat ≥ 96**.
Comfort is the metered exception.

**The correct re-skin: teach the Stabilizer as "ED's FA-OFF dip, but in reverse."**
Not a mode you live in — a **metered tap you spend** to arrest drift for a specific
purpose (docking at the ~7,100 m station, settling onto a surface, steadying before
a scan). Between rocks, you let momentum carry you _for free_.

What this does to expectations, and where it bites:

- An ED player reflexively **slaps `X`/`Z` to stop** on every overshoot. In Haystack that **burns heat that is shared with scanning and mining** — the core loop. They will overheat themselves out of the gameplay they came to do. That tension is a _feature_, but it must be taught, loudly.
- **UI consequence 1:** the Stabilize control must surface its **heat cost and the heat ≥ 96 lockout on the button itself.** ED players expect assist to _never fail_; Haystack must visibly signal that it _can_.
- **UI consequence 2:** with no orientation, the Stabilizer can only kill drift _toward world-zero_, never "toward the nose/throttle" — so frame it as **"brakes / anchor," never "autopilot."**
- **Two corrections to install in the UI:** (a) ED's `X` only stops you because FA bleeds the residual — in Haystack, **bind `X` to the Stabilizer itself**, or the most-pressed ED reflex visibly does nothing. (b) The angular case has _no ED-free answer_: pure rate-control mouse with no drag can leave a player **tumbling with no recenter-to-stop**. Add an **angular Stabilizer (rotation damp), also heat-costed**, or rotation becomes a soft-lock trap.

**Mental-model shift to install:** _assist is a resource, not a baseline. You manage
drift yourself; the assist is a heat-priced convenience you ration._ Heat is
Haystack's soft ceiling — the thing that makes the comfortable way of flying finite.

> **Open design fork (not settled):** should Haystack offer a _held, continuous_
> FA-ON-like mode (continuously sip heat to hold throttle / null rotation), or keep
> assist strictly _momentary_ (Stabilize taps)? **Recommendation:** ship
> momentary-only first (truest to `goal.md` and the existing model); add a
> continuous heat-draining **cruise lock** only for the long-haul tier (§6), never
> as a general comfort blanket.

---

## 5. Proposed default KB/M control map

This map assumes orientation has been added (§7). **The entire table is gated on the
new continuous-input transport (work item 5 of §7): none of these binds are
shippable on today's click-once, serialized-button transport.** ED-faithful where the
_concept_ survives; every divergence from ED's actual default vs. a veteran _rebind_
is labeled.

The rotation layout is **locked by design decision**: pitch on mouse-Y, **yaw on
mouse-X (ED default), roll on Q/E (keys)**, lateral thrust on **A/D**. This puts the
two axes you steer with constantly (pitch + yaw) on the mouse and the rarely-used
roll on the keyboard — correct for a scan/mine game rather than a dogfighter.

| Action                                | Key / Mouse                                                      | ED precedent                                                                | Haystack note                                                                                                                                                                                                                 |
| ------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | -------------------- |
| **Pitch**                             | Mouse Y (rate)                                                   | ED default mouse-Y = pitch                                                  | Strongest axis. Virtual-stick rate control (needs Relative Mouse + pointer lock). Needs orientation + angular velocity.                                                                                                       |
| **Yaw**                               | Mouse X (rate)                                                   | **ED default** (mouse-X = yaw)                                              | Primary horizontal steering. Faithful to ED's stock mouse binding.                                                                                                                                                            |
| **Roll**                              | Q / E                                                            | Keyboard roll                                                               | Moved off the mouse onto keys — least load-bearing axis in a mining game; used to reorient before a pitch onto target.                                                                                                        |
| **Lateral thrust L/R**                | A / D                                                            | ED strafe (preset-dependent)                                                | **Hold-to-fire** momentary impulse; keep cheap for surface combing.                                                                                                                                                           |
| **Vertical thrust up/down**           | Space / Ctrl                                                     | ED default                                                                  | Hold-to-fire impulse.                                                                                                                                                                                                         |
| **Yaw (keyboard, optional)**          | Unbound                                                          | ED keyboard alt                                                             | Yaw stays on mouse-X; A/D are reserved for lateral thrust.                                                                                                                                                                    |
| **Throttle up / down (step)**         | W / S                                                            | **ED keyboard default** (Increase/Decrease Throttle)                        | Drives a persistent **setpoint**, stepped per press (not ramp-while-held).                                                                                                                                                    |
| **Throttle presets**                  | direct-set keys                                                  | ED has default 25/50/75/100% set-speed binds                                | Enables the "75% on approach" braking discipline (§6).                                                                                                                                                                        |
| **Set speed to zero / all-stop**      | X                                                                | Keyboard default (mouse presets often bind All Stop to a mouse button)      | In ED, `X` zeroes the setpoint and FA stops you. In Haystack there is no setpoint to zero, so **bind `X` to the Stabilizer** (the only thing that arrests motion). See §4.                                                    |
| **Reverse**                           | S past zero                                                      | Bipolar throttle                                                            | Setpoint to −100%; only _holds_ under cruise-lock.                                                                                                                                                                            |
| **Boost**                             | Tab                                                              | **ED default = Tab**                                                        | One-shot overspeed kick. ED gates it on the **ENG capacitor + a cooldown**; we map the gate onto **heat** (locked at heat ≥ 96) and **drop the cooldown** — add one back if heat alone underconstrains it. Must respect the ` | impulse | <= 12` clamp (§7.3). |
| **Stabilize (the assist)**            | X                                                                | ED `Z` = FA toggle / hold-to-disable                                        | **Inverted semantics:** costed drift-kill, not a free baseline. Current Stabilizer is momentary, so v1 is a **tap**, not a held mode. See §4.                                                                                 |
| **Mouse lock / unlock (cursor mode)** | toggle — suggested `LeftAlt` (also: browser `Esc` force-unlocks) | No direct ED analog (ED captures the mouse for flight; UI is gamepad-style) | **Switches the mouse between flight-steering and UI.** Required so the EVE-style floating windows are clickable. See §5.1 — this is a first-class control, not an afterthought.                                               |
| **Cruise / long-haul**                | J                                                                | ED `J` = FSD/supercruise (a charged/spooled sequence)                       | Heat-costed throttle-to-target. No gravity-model analog — mirror the spool/charge feel. See §6.                                                                                                                               |
| **Select target ahead**               | T                                                                | ED default                                                                  | Lock the reticle-nearest discovered contact.                                                                                                                                                                                  |
| **Cycle next target**                 | G                                                                | ED default                                                                  | Cycle the EVE-window overview of discovered contacts. (Previous-target is a _separate_ default bind.)                                                                                                                         |
| **Match target speed**                | (ED has a default bind)                                          | ED "Match Target Speed"                                                     | **No clean analog** pre-orientation/setpoint. Honest pre-cruise answer: you cannot match speed; you Stabilize and re-approach. See §8.                                                                                        |
| **Area scan ("honk")**                | F (one-shot)                                                     | ED discovery-scanner sweep                                                  | Sweeps _all_ nearby discoverable contacts at once. Costs heat. First reflex entering a new pocket.                                                                                                                            |
| **Targeted scan pulse**               | F (repeat) / fire                                                | ED detailed/probe scan                                                      | Repeated directional needle-loop pulse. Costs heat.                                                                                                                                                                           |
| **Mine**                              | Fire trigger / R                                                 | ED hardpoint fire                                                           | Range `radius + 1400 m`; heat-throttled.                                                                                                                                                                                      |
| **Dock request / gear**               | L                                                                | ED `L` = landing gear; dock request                                         | Guaranteed early reflex; needs a real "approach the station" answer (cruise + Stabilizer + dock UI).                                                                                                                          |
| **UI panels**                         | 1 / 2 / 3 / 4                                                    | ED 1–4 default                                                              | Maps to EVE-style Flight / Scan / Cargo / Map windows. Works in either mouse mode; see §5.1 for input arbitration.                                                                                                            |
| **Camera view toggle**                | C (toggle)                                                       | ED has no third-person flight; EVE's orbit camera is the reference          | **Implemented.** First ↔ third person, independent of cursor/flight mode. In third person the local ship renders (hull, nav lights, flashlight beam) from the smoothed render transform. See §5.2.                            |
| **Free-look**                         | —                                                                | ED headlook (hold)                                                          | Superseded by the third-person camera (§5.2): chase cam while locked, EVE-style orbit in cursor mode. (`V` went to the scan pulse, so the view toggle landed on `C`.)                                                         |

**Cut from the ED reflex set: pips / capacitor distribution (arrow keys).** ED's pip
dance feeds a **capacitor Haystack does not have.** Repurposing arrows as a
"heat-budget allocation" subsystem invents a whole mechanic with no basis in the sim,
and an ED player's arrow reflex firing into nothing is worse than leaving arrows
unbound. **Leave arrows unbound in v1; treat heat-allocation as speculative vision
only (§9), not a control.**

### 5.1 Mouse lock / unlock — the cursor-vs-flight mode toggle

Because the mouse drives both **steering** (pitch/yaw as a virtual joystick) _and_
**the EVE-style floating-window UI** (drag, resize, click), the client needs an
explicit, first-class toggle between two modes. This is the concrete resolution of
the "panel focus steals flight input" trap (§8).

**Two modes:**

- **Flight mode (pointer locked):** the OS cursor is hidden and captured via the
  browser **Pointer Lock API** on the R3F canvas. Mouse X/Y feed yaw/pitch as
  relative-rate input; raw mouse movement never reaches the DOM, so the windows do
  not react. This is the default while flying.
- **Cursor mode (pointer free):** the cursor is released and visible; clicks and
  drags hit the floating windows normally. **All flight input fully suspends** —
  mouse steering _and_ keyboard flight (throttle, roll, strafe, stabilize) stop being
  read. Critically, **nothing auto-brakes or auto-damps**: the ship just keeps doing
  what it was already doing, coasting on its current linear _and_ angular velocity.
  This is the correct behavior, not a compromise — it is exactly the no-free-assist
  rule (assist always costs heat and is never automatic). Open a menu mid-drift or
  mid-spin and you stay drifting/spinning; arresting it is your job once you return to
  flight. (It also keeps cursor mode trivially cheap: it is purely an input gate, with
  zero effect on the simulation.)

**Browser reality that constrains the implementation (this is a web client):**

- The **Pointer Lock API requires a user gesture** (a click) to _engage_ lock — you
  cannot silently re-lock the pointer from code. So "return to flight" realistically
  means _click the canvas_ (or press the toggle, which then locks on the next
  canvas-focused gesture).
- **`Esc` always exits pointer lock** — the browser enforces this and you cannot
  prevent it. So `Esc` is effectively a _free, guaranteed_ "unlock to cursor mode,"
  and the bound toggle key is the deliberate one. Document both.
- Pointer lock drops on tab blur / alt-tab; the client must detect
  `pointerlockchange` and fall back to cursor mode cleanly rather than leaving the
  ship "steering" off stale input.

**Suggested default:** a **toggle** on `LeftAlt` (tap to switch modes), with browser
`Esc` as the always-available unlock and a canvas click as the re-lock gesture.
Toggle (not hold) is correct here because UI work — dragging a window, typing in
chat — is sustained, and you should not have to hold a key through it. Cursor mode is
a pure input gate: flight is fully suspended and the ship coasts unchanged (no
auto-brake, no auto-damp) — so the only remaining open choice is the final key (§10).

### 5.2 Third-person view + EVE-style orbit camera (implemented)

`C` toggles first ↔ third person. View mode is _what you see_; cursor/flight mode stays
_what the mouse controls_ — the two are independent, and both the view mode and the orbit
zoom distance persist in `localStorage`. The camera is still written once per frame by
`RenderDriver` (`src/client/eve/components/WorldView.tsx`) from the smoothed render store;
orbit state lives outside React in `src/client/eve/cameraStore.ts`.

- **Third person + flight (pointer locked): chase cam.** The camera sits behind/above the
  ship in ship space (view axis parallel to the nose), so mouse steering reads exactly as
  it does in first person. The local ship renders with the same treatment remote ships get
  (cone hull, nav lights, flashlight beam cone), driven from the smoothed owned transform.
- **Third person + cursor (pointer free): EVE-style orbit.** Left-click-drag on the
  stage/canvas orbits the camera around the ship — yaw wraps the full 360°, pitch clamps
  at ±80° — and the scroll wheel zooms exponentially between ~0.18 and 16 scene units
  (hull-filling close to speck-against-the-belt far, inside the fog band). A click that
  never crosses a ~4 px drag threshold still re-locks flight, so the "click the canvas to
  fly" habit keeps working, and drags that start on HUD/UI elements never engage the
  orbit. Orbiting and zooming are pure camera inputs: they never touch
  `mouseDeflectionRef`, never emit a `FlightInputCommand`, and never bleed into
  `flightInputScale` — the ship keeps coasting on its current inputs (`tests/e2e/camera.ts`
  pins all of this via `window.__probe`).
- **No snaps.** Every pose change (view toggle, lock/unlock) eases from the camera's
  current transform over ~0.45 s; unlocking out of chase seeds the orbit angles from the
  chase pose so the camera starts the orbit exactly where it already is.
- **Reticle decision:** the center reticle marks the cockpit view axis, which third person
  does not have (the orbit camera especially), so it is hidden in third person rather than
  projected along the nose. First-person HUD and reticle are unchanged.

---

## 6. Travel across the needle scales

> **Caveat:** the only distances the code gives are station ~7,100 m, discovery within
> ~55,000 m, scan reach ~52,000 m, against ~8 m/s/press, no drag, no speed cap
> (`src/server/sim.ts`, `src/server/field.ts`). Any belt-cube size or asteroid spacing
> below is _illustrative_, not given.

The structural problem is real regardless of exact figures: a single
~8 m/s-per-click model must serve both **fine maneuvering across tens of meters** and
**logistics across tens of kilometers**. With zero drag, _holding_ a speed is free;
the cost is **reaching and arresting it** (≈10 clicks against the serializing mutex to
build ~80 m/s; a ~50 km transit is then ~10 minutes). ED's whole multi-scale design
exists to solve exactly this, and an ED player will **expect a mode ladder**:

- **Normal impulse (free, fiddly)** — today's model, for combing a surface and fine maneuvering. Keep the cheap momentary strafe impulses.
- **Boost (`Tab`)** — a one-shot overspeed kick for the rock-to-rock glide. Heat-gated (locked at heat ≥ 96). **Constraint:** the `|impulse| <= 12` server clamp means boost cannot be one oversized impulse — it must **raise/bypass the clamp server-side for that command** or **emit a short burst of clamped impulses**. Consider keeping ED's cooldown as a second gate.
- **Cruise / throttle-to-target (`J`)** — the supercruise analog for the logistics tier, and the place Haystack _must invent_ (no star/gravity topology to borrow speed-limiting from). The clean fit: a **heat-costed "throttle controls speed" mode** that holds a target velocity (continuously draining heat) toward a **locked nav target** — a scalar speed along the target's world-vector, which needs **no facing vector and so can ship before orientation**. Mirror ED's spool/charge on engage and a braking discipline on arrival.

Echo ED's **"7-second rule"** (drop to ~75% throttle on approach to brake cleanly):
cruise should require an **overshoot/braking discipline** — you can't instantly stop;
throttle down on approach or loop back. That texture is what makes long-haul feel like
piloting rather than a loading screen. (Don't reduce the "blue zone" to a single
number — it's the optimal-maneuver band; turn rate actually peaks nearer 50% throttle.)

**Opinionated call (recommendation, not a forced fact):** a cruise tier is effectively
**mandatory** if the belt spans tens of km. One mode cannot serve both fine
maneuvering and multi-km logistics. Cruise preserves the needle-hunt's sense of vast
distance better than shrinking the world.

---

## 7. What needs to be built, prioritized

This is the work list. **Items 1→3 unlock the fantasy; 5→7 make it feel good; 8
makes the world traversable.** The heat/signature/HUD-compass slice (§4 UI, §6 nav,
§9 heat) can ship _before_ any of this as a value-delivering first pass.

1. **Ship orientation in the data model (quaternion).** _Keystone — everything below depends on it._ Add `qx,qy,qz,qw` to `Ship`/`ShipRow` (`src/shared/types.ts`, `src/server/sim.ts`), to the wire `ThrustCommand`, and to the server validator. Nothing in nose-where-you-point flight is expressible without it.
2. **Angular velocity + max angular rates.** `wx,wy,wz` plus per-axis turn caps (encode the pitch-strong / yaw-weak asymmetry). Required for rate-control mouse-look to feel right — **and** for the angular Stabilizer (§4) so players aren't stuck tumbling.
3. **Ship-relative thrust basis.** The server must rotate local thrust through the quaternion before integrating (`applyThrust`/`advanceWorld`), turning today's world-absolute impulse into "thrust along the nose." Without this, "forward" stays a world axis and the illusion fails. The `|impulse| <= 12` clamp constrains any single-press thrust, including boost.
4. **Throttle setpoint + a Flight-Assist / cruise-lock flag.** A persistent `throttle` scalar and a `flightAssist`/cruise-lock boolean (today's `stabilize` is a transient per-command flag, not a mode). This is what turns mashing into set-and-hold.
5. **Continuous / held-input transport with client prediction, incl. pointer-lock mouse capture.** Today input exists only at the instant of a click and sits behind a serializing `busy` mutex (`src/client/App.tsx`). ED-style control needs: the **mutex removed/replaced** by a per-frame input-state channel; a client `useFrame`/rAF loop emitting current input each frame; **Pointer Lock mouse capture** with the cursor/flight mode toggle and `pointerlockchange`/blur fallback (§5.1); a 6-DOF body-local command (`main` throttle + `strafe` (A/D, Space/Ctrl) + `pitch`(mouseY)/`yaw`(mouseX)/`roll`(Q/E)); and a **predict/reconcile twin** (see `docs/engine/client-side-prediction.md`). The transport _can_ carry it (fire-and-forget JSON, ack wired in `src/server/realtime.ts`) but the schema, sampler, capture, and prediction do not exist.
6. **Server fixed-step integration of held commands.** Held rotational/throttle state must integrate on a fixed step decoupled from snapshot rate (see `docs/engine/world-and-actors.md`). **Rotational prediction is the real risk:** client-side integration of angular velocity is _harder to reconcile_ than translational (orientation error is visually obvious and compounds), so over the authoritative snapshot stream this is where mouse-look will feel rubbery if reconciliation is wrong.
7. **An orientation-following camera.** The fixed `[0,9,18]` frame with the world floating-origin-rebased (÷9000) around a stationary ship _cannot express "where you point"_ (`src/client/App.tsx` `WorldView`/`toScene`). The camera must slave to orientation (chase cam) — and the **rebasing complicates this**: the ship is pinned at the origin while the world translates, so a chase cam must rotate the rebased world around the ship rather than orbit a moving ship. Free-look depends on this.
8. **Boost charge + cruise mode + speed handling.** Lower priority but needed for the travel ladder (§6). Boost as a heat-gated (ideally cooldown-gated) burst respecting the impulse clamp; cruise as a heat-draining throttle-to-target.

**Two scale notes:** adding a quaternion (+ angular velocity) to the snapshot
**increases per-tick wire payload** for many players / "millions of asteroids" —
budget the bandwidth (`docs/engine/replication.md`). And the serializing `busy` mutex
(item 5) must be _removed_, not worked around, for any of this to feel right.

---

## 8. Expectation traps — where ED muscle memory will misfire

- **World-absolute thrust** _(the deepest trap)_. ED thrust is nose-relative; Haystack's is raw world axes with no nose. Until orientation lands, every "forward" reflex pushes a fixed world direction. **Do not ship mouse-look against world-absolute thrust** — that is the uncanny valley.
- **`X` to stop does nothing unless it stabilizes.** ED's `X` stops you only because FA bleeds the residual. Zeroing a non-existent setpoint visibly does nothing — **bind `X` to the Stabilizer** and teach "tap to bleed velocity; it costs heat and can lock out." There is **no free all-stop**; say so.
- **No free all-stop, no match-speed, no recenter-to-stop.** ED gives match-target-speed and FA-recenter free; Haystack has neither, and rate-control mouse with no drag can leave a player **tumbling**. Both the **linear and angular Stabilizer** must be heat-costed conveniences, not freebies.
- **Hold-W-to-go / coast.** A veteran expects W to step a setpoint and the ship to _hold_ that speed. With no setpoint and no drag, W-as-repeated-impulse accelerates _forever_ and releasing does nothing — feels broken in both directions. The throttle setpoint (item 4) is the fix.
- **Assist-is-free.** They'll lean on Stabilize as a constant comfort blanket and **cook their shared heat budget**, locking out scanning/mining. Teach it as a rationed resource with a _visible_ failure state.
- **No top-speed cap.** ED's FA caps you at throttle-set max; Haystack's velocity is unbounded. "Mash thrust → huge velocity → mash stabilize to bleed it" is the opposite of ED's bounded band. A speed cap or cruise band is needed or the model feels like a runaway.
- **The mouse can't be in two places at once.** The mouse drives both steering and the EVE-style windows. Without the explicit cursor/flight toggle (§5.1) a player either can't click their UI (pointer locked) or can't steer (pointer free). The toggle — plus the browser's `Esc`-always-unlocks and click-to-relock behavior — is the resolution, and it must be taught in the first session. Also handle tab-blur dropping pointer lock so the ship doesn't keep steering on stale input.
- **Panel focus steals keyboard input.** ED players hit `1-4` reflexively and may type in chat or a focused field; WASD must not leak into a focused window (and window input must not leak into flight). Define focus arbitration alongside the mouse-mode toggle.
- **Headlook / free-look is non-functional today.** Fixed frame, no cockpit — cosmetic until orientation + chase-cam (item 7). Defer it rather than bind a dead key.
- **No cockpit / discrete clicks.** ED's feel lives in the cockpit and analog stick. On-screen buttons behind a serializing mutex are the _wrong shape_ — no analog, no simultaneity, no hold.
- **Multiplayer authority & latency** _(the silent killer)_. Haystack is persistent multiplayer with an authoritative snapshot stream and server-side input application (`src/server/realtime.ts`). ED muscle memory assumes near-zero-latency local feel — which _requires_ the client-side prediction twin (item 5) and **rotational prediction** specifically (item 6). Get reconciliation wrong and even a perfect bind map feels rubbery.

---

## 9. The heat overlap (ship this first)

The **strongest, most native bridge** between the two games, and largely already
built. Haystack already has a first-class heat economy (`src/server/sim.ts`):
thrust/scan/mine/stabilize add heat; heat decays ~0.85/s; caps at 100; Stabilize is
blocked at ≥96. ED players already think in this currency:

- **Heat = signature (proposed coupling, not current).** In ED a hot ship lights up scanners; a cool ship hides. Haystack has a hidden-base / low-signature _theme_ but heat is **not yet a detectable signature**, and scan pulses do **not yet** read other ships' heat. The natural next step: make heat → detectability, turning Stabilizer/cruise into a **Silent Running analogue** — a costed assist that buys a benefit while pushing toward a hard ceiling.
- **Pips → "burn heat for performance" (speculative, do not ship in v1).** ED's "pips to ENG for speed" reflex _could_ map onto spending heat for temporary performance — but ENG pips raise _max speed and boost recharge_, not per-thrust magnitude, and Haystack has no distributor. Keep this as vision.
- **Deployed-gear-slows-you → scanning/mining as a heat-throttled, slowed, _exposed_ state.** Combing a surface or pulsing a scanner should cost speed and heat and (once signature coupling exists) raise detectability — exactly the needle-in-a-haystack tension where hunting and hiding trade off.

The expectation the heat economy installs — and the one Haystack should lean into:
**flight is a thermal-budget management game.** Speed, stealth, scanning, and
drift-killing all draw from one shared, depletable pool. Crucially, _all of it is
scalar and world-absolute_ — it composes with the no-orientation model and needs no
facing vector. This is the slice of the ED fantasy Haystack can deliver **today**, and
the hook to lead with.

---

## 10. Open questions to resolve before building

1. **Momentary-only vs. continuous assist** (§4 fork). Recommendation: momentary-first; continuous "cruise lock" only for long-haul.
2. **Does the belt actually span tens of km?** Decides whether the cruise tier (§6) is mandatory or optional. Needs a real field-scale number from `src/server/field.ts`.
3. **Mouse lock/unlock: final key** (§5.1). _Behavior is decided:_ cursor mode fully suspends all flight input and the ship coasts on its current linear and angular velocity — no auto-brake, no auto-damp. Suggested `LeftAlt` toggle with `Esc` unlock; only the final key remains to confirm.
4. **Keyboard yaw on A/D — dropped.** Yaw now lives on mouse-X; A/D are lateral strafe.
5. **How much rotational prediction error is acceptable** over the authoritative snapshot rate before mouse-look feels rubbery (§7.6)? This gates the snapshot-rate / prediction budget.

---

_Sources: `goal.md` (product contract); `src/server/sim.ts`, `src/shared/types.ts`,
`src/client/App.tsx`, `src/server/realtime.ts`, `src/server/field.ts` (current build);
`docs/engine/client-side-prediction.md`, `docs/engine/world-and-actors.md`,
`docs/engine/replication.md` (architecture). Elite Dangerous control details are
KB/M-focused and label ED defaults vs. common rebinds; treat any single keybind as the
configurable default it is, not gospel._
