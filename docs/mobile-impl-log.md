# Mobile: touch flight, UI fit, perf tier, capability gating — impl log

## Session 1 (2026-06-10) — full feature landed

Commits: `37827f4` (viewport/safe-areas), `a7cb2ae` (sticks + buttons), `c78a04e`
(touch e2e), `f03979b` (touch-ui layout), `5409a2f` (quality tier + capability screen

- e2e harness repair), plus the verification/harness commit this log ships in.

### What shipped

- **Dual virtual sticks through the existing input path.** `touch-input.ts` holds a
  `TouchFlightState` that `TouchFlightControls`' pointer handlers mutate and
  `buildFlightInput` reads on the 60 Hz input timer — the exact ref seam
  `heldKeysRef`/`mouseDeflectionRef` use, so touch emits the same
  `FlightInputCommand` stream as keyboard/mouse and prediction/server are untouched
  (hard requirement: no wire change). Touch engagement (any stick/hold-button finger
  down) plays the role pointer lock plays on desktop: it drives the timer's `active`
  flag, and releasing the last finger lets the existing trailing-command logic zero
  rotation/strafe server-side. Sticks **spawn where the thumb lands** in each zone;
  radial deadzone 0.12 with continuous re-normalization; left stick = throttle
  (vertical, momentary override exactly like W/S) + lateral strafe (horizontal);
  right stick = pitch/yaw with a **sign-preserving squared curve** (linear was
  untwitchable for aiming — the squared center is gentle, full deflection still hits
  max rate).
- **Roll is two hold-buttons, not a stick axis.** Q/E twins by the left thumb.
  Rationale: fine analog roll buys little in a belt-mining flight model, a third
  stick axis doesn't exist, and two-finger-twist conflicts with third-person pinch
  zoom. Stabilize is also a hold-button (rides commands like KeyX); boost / cruise /
  flashlight / scan pulse / camera are taps.
- **Camera scoping.** First person: stick zones own the canvas. Third person: zones
  unmount and the screen belongs to orbit gestures — one-finger drag orbits (same
  `orbitCamera` writes as mouse drag, never a flight command), two-finger pinch zooms
  through `zoomBy`'s wheel-delta curve. Touch never requests pointer lock.
- **Capability gating, not UA sniffing.** `mobile.ts`: touch UI iff
  `maxTouchPoints > 0` **and** no `(any-pointer: fine)` — a touchscreen laptop keeps
  the desktop scheme. `?touch=1/0` overrides for harnesses. Cached per session (a
  mid-flight scheme flip would tear down the stick under the thumb).
- **Mobile UI fit (`.touch-ui` class on the app shell).** Windows become fixed
  full-screen sheets (WindowFrame `static` prop kills drag/resize; minimize hidden;
  44 px controls); the HUD sheds its thrust-button grid and keybind hints (sticks
  replaced them) and the floating clusters drop below the window layer so sheets
  actually cover the screen; audio mixer collapses to its mute head (it was sitting
  on the right stick zone); verbose rail metrics hidden to keep the top rail one row.
  Portrait gets a full-screen "rotate your device" prompt — landscape-first is a
  design call (dual sticks need width; state stays mounted under the overlay so
  rotating back resumes instantly).
- **Safe areas + gesture suppression.** `viewport-fit=cover` +
  `maximum-scale=1, user-scalable=no` (iOS ignores `touch-action` for page pinch),
  `env(safe-area-inset-*)` as CSS vars consumed by every rail/cluster,
  `touch-action: none` on the world stage, `overscroll-behavior: none`, tap
  highlight/callout off.
- **Quality tier (`quality.ts`) — one pipeline, tiered parameters.** Mobile tier:
  resident-rock cap 12k applied at the **FieldDeriver entry** (one seam — cell key,
  worker request, sync fallback, and therefore render/collision/overview all shrink
  together; the server's `renderedLimit` is a ceiling, not a contract, since virtual
  rocks are client-derived); Canvas dpr clamp `[1, 1]`; sun **shadow-map pass off**
  (`castShadow` + `shadowTier1Enable` uniform zeroed together; the per-instance
  aSunlit tier stays — it's per-vertex math and carries the far-field look); froxel
  grid 96×54×48 vs 160×90×64 (~27 % of scatter cost; the grid is a module-load
  constant so kernels, accum buffer, and CPU parity mirrors stay consistent —
  windowless test/worker contexts resolve to desktop, parity fixtures unchanged).
- **Capability screen.** Phone-presentable card; accurate guidance (iOS 26+ Safari,
  Android Chrome 121+, desktop Chrome/Edge 113+ / Safari 26+ / Firefox 141+ Windows).
  The §8.2 contract sentence is preserved verbatim.

### Verification (all from this session)

- `bun run verify` (typecheck + format + 184 integration tests incl. new stick-math,
  detection, and tier tests) — green.
- **`verify:touch` (new).** Real client, landscape-phone touch context, CDP-dispatched
  _trusted_ touch events (synthetic `page.dispatchEvent` pointers get rejected by
  `setPointerCapture`): stick spawns at the touch point; full-deflection hold produced
  26 m forward motion with **zero prediction snap-backs** (the prediction.ts tolerance
  pattern; corrections reported, not asserted — headless SwiftShader throttles the
  input timer); right stick moved the orientation quaternion; camera tap → third
  person where drag orbited (+0.6 rad yaw) and pinch zoomed; stick zones absent in
  third person.
- **`verify:screenshot` extended**: touch sticks/buttons render in landscape, 44 px
  targets, neocom clears a simulated 47 px notch, HUD clears the 21 px home
  indicator, scanner opens as a ≥80 %-width sheet below the rail, portrait shows the
  full-screen rotate prompt. Screenshots land in `screenshots/haystack-e2e-touch-*`.
- **Perf evidence (`verify:gpu-live`, real Chrome/Metal).** Desktop tier baseline
  PASS (p95 16.8 ms, ~60 fps). Mobile tier at phone viewport (844×390 @3×,
  `GPU_LIVE_TIER=mobile`) PASS — and at the **same** viewport, desktop tier renders
  29.0 M triangles / mobile tier 14.6 M (−50 %, shadow pass gone), shaded pixels
  −56 % (dpr 1.5→1.0 at dsf 3), froxel cells −73 %. **Caveat, stated plainly: these
  are desktop-GPU numbers; both tiers vsync-cap at 60 fps on an M-series GPU, so
  wall-clock fps cannot differentiate them here. The evidence is that the tier
  removes ~half the geometry work, ~3/4 of the froxel compute, and >half the shaded
  pixels — not a measured phone fps. No real phone was in the loop this session.**
- Desktop suites: `verify:gpu`, `verify:multiplayer`, `verify:camera`,
  `verify:audio`, `verify:ui`, `verify:prediction` — green (see harness repair
  below).

### Surprises / decisions worth knowing

- **Several desktop e2e suites were already red on main.** `2e43cf2` ("default layout
  starts with all windows closed") silently broke every suite that touches
  window-hosted UI (`flight-mode-toggle` lives in the Flight window, `.pilot-card`
  in Character, the local-presence list in Comms, the orbit-vs-UI drag check uses the
  Scanner titlebar): `verify:ui`, `verify:prediction`, `verify:camera`,
  `verify:multiplayer`, and the mobile spacing check in `verify:screenshot` all
  failed at the base commit before any of my changes (verified in a clean worktree).
  Repaired with an `openWindow(page, key)` helper that opens windows through the
  neocom; `ui.ts` also re-opens after its `layout-reset` step. All listed suites are
  green again as of this branch.
- **A zombie vite (port 5199, from a previous session) masqueraded as a multiplayer
  regression** — `--strictPort` made the suite's own vite die while `waitFor` happily
  hit the stale server, whose baked `VITE_API_URL` pointed at a dead port, so the app
  never booted. If a suite fails on boot with no code change, `lsof -i :<port>`
  first.
- **The gpu-live SHADOW gate is margin-flaky on this machine.** The diag counts are
  noise-relative (`tier1 > 2.5 × noise`) and this machine's measure view yields tiny
  absolute counts (~10 px vs the ~8000 the comment expects on Metal), so a noise
  blip of 4 px fails the gate. Observed FAIL → PASS on identical code; base commit
  shows the same tiny counts. Not addressed here — flagging for a future session.
- **gpu-live's screenshot gate assumed the desktop viewport** (hardcoded
  `2560×1440`); parameterized to `CSS × DSF` so phone-shaped runs can pass.
- **Touch-point hit-testing in e2e is a minefield — and the culprit was the target
  brackets.** A long flake hunt (intermittent "stick never spawns", pilot-correlated,
  immune to retries/settles/browser relaunches) bottomed out at the in-world target
  brackets: 32 `pointer-events: auto` islands tracking moving rocks densely cover a
  phone viewport, and Chrome's touch-target adjustment magnetizes synthesized touches
  onto them nondeterministically. The suite probes `elementFromPoint` with a ±56 px
  clean-neighborhood requirement, re-probes a fresh point per attempt, and makes the
  bracket layer inert for the stick/orbit phases (brackets aren't under test).
  Result: 12/12 consecutive green runs.
- **Real-device follow-up:** the same physics applies to thumbs — a drag that STARTS
  on a bracket selects nothing and spawns no stick (brackets sit above the zones so
  taps select targets). Recoverable (re-place the thumb), but if it annoys on
  hardware, the likely fix is bracket tap = select on `click` only, letting
  pointerdown+drag fall through to the stick zone.
- **Audio unlock on mobile**: the collapsed audio head keeps the mute toggle and the
  "click to enable" hint; any touch counts as the unlock gesture (existing useAudio
  behavior), so collapsing the mixer loses nothing.

### Real-device recipe (not exercised this session — no phone available)

WebGPU needs a secure context, so a bare LAN IP won't expose `navigator.gpu`:

```sh
bun run dev          # server
bun run dev:client   # vite on 0.0.0.0:5173
cloudflared tunnel --url http://localhost:5173   # prints a https://*.trycloudflare.com URL
# open that URL on the phone (iOS 26+ Safari / Android Chrome 121+)
```

`VITE_API_URL` defaults to same-origin proxying in dev, so the single tunneled origin
carries both the app and the API/WS. Tailscale `tailscale serve 5173` works the same
way if cloudflared is unavailable. On-device verification (real frame times, thumb
feel, safe-area behavior on hardware) is the remaining gold-standard pass.

### Deferred ideas (out of scope by spec)

- Gamepad support (the stick state object is input-source agnostic — a gamepad
  writer would slot into the same seam).
- Haptics on boost/collision (`navigator.vibrate` is Android-only).
- Key rebinding / left-handed mirror layout toggle.
- A "compact" desktop tier for weak iGPUs using the same quality params.
- Long-press as right-click alias for the radial context menu on touch.
