# Ship lights, flashlight replication, HUD hints, collisions — impl log

## Session 1 (2026-06-09) — all four features landed

Commits: `ffe65a0` (lights/flashlight/HUD), `2092f58` (collisions).

### What shipped

- **Replicated light toggles.** `Ship.navLightsOn` / `Ship.flashlightOn` ride the exact
  `cruiseLock` pattern end to end: optional `navLights`/`flashlight` booleans on
  `FlightInputCommand` → `receiveFlightInput` applies them (omitted = keep current) →
  new `nav_lights`/`flashlight` columns (with `ensureColumn` migrations) → replicated
  fields on `ShipActor` → delta/ack. L toggles nav lights (first free key; F/V/Tab/J
  taken), F's flashlight now replicates. Both ride **every** flight input from
  `buildFlightInput`, so the server state is sticky and self-healing.
- **Remote rendering.** `OtherShipMesh` gates three unlit hull markers (port red /
  starboard green / tail white), a strobe **beacon sprite rescaled every frame to a
  fixed apparent size** (`distance × 0.011`, clamped), a 700 m hull-wash point light,
  and — for the flashlight — a shadowless 8 km spotlight plus a faint additive cone so
  the beam is visible even when it hits nothing. All marker materials are `fog: false`
  (the 18 km fog would otherwise extinguish exactly the long-range visibility the
  feature exists for).
- **HUD hints**: `F flashlight on/off`, `L nav lights on/off` chips in `HudCluster`,
  hidden on the mobile breakpoint (no keyboard there — and the extra row overlapped
  the mobile window layer; `verify:screenshot` caught it).
- **Collisions.** `src/shared/collision.ts`: `SHIP_COLLISION_RADIUS = 50` m (matches
  the 0.08-scale remote cone), broad phase = segment-AABB cell range (±1 cell, so
  O(nearby) always), swept-sphere entry test (no tunneling at any speed; tested at
  2 km/step), pushout + restitution 0.2. The same environment object is injected into
  `ShipActor.update` (server) and `OwnedShipPrediction` predict/replay (client), so a
  predicted rock hit reconciles bit-identically. Ship-ship is a server-only pass after
  actor updates (sorted-id pair order; impulse only when approaching; positional
  separation capped at 4 m/tick).
- **Spawn ring.** With solid ships, the everyone-spawns-at-stationSpawn behavior became
  physically impossible; new pilots now spawn on a deterministic hash ring (180–380 m)
  with a salted re-probe against occupied spots.

### Decisions

- **Third copy of the virtual-rock math, guarded by a test.** The derivation exists in
  `src/server/field.ts` and `src/client/eve/field-core.ts` (parity-gated). Refactoring
  both to a shared module risked the field worker / parity surface for zero behavior
  change, so `collision.ts` carries its own mirror plus an integration test asserting
  bit-identity with `deriveVirtualField` — drift now fails CI instead of desyncing
  prediction.
- **Bump, not stop.** Restitution 0.2: flying into a rock at 200 m/s rebounds at
  40 m/s. A test originally asserted "rests at contact" and failed — the bounce-and-
  drift-away behavior is the intended physical response, so the test now asserts the
  bounce magnitude instead.
- **Resting overlap separates without impulse.** The pair resolver fires its impulse
  only when closing, so overlapped-at-rest ships (legacy DBs with stacked spawns)
  glide apart at ≤4 m/tick instead of exploding.

### Surprises (and what they cost)

- **Headless SwiftShader throttles the 60 Hz input timer to ~7 Hz.** The reconcile
  debug log showed consecutive acks ~9 fixed ticks apart. Consequence: in the
  prediction e2e, ANY fast-moving ship corrects on every ack (server integrates ~9
  wall ticks per client input) — an environment artifact players on real GPUs never
  hit. The e2e therefore reports correction counts but asserts the player-facing
  invariant instead: the rendered ship never appears inside the rock (an unpredicted
  stop would render ~100 m of penetration for the full 550 ms ack delay). The
  bit-identical prediction guarantee lives in `tests/integration/collision.test.ts`.
- **The delayed-ack precondition (`ackTick === 0`) was frame-rate dependent** — under
  slow SwiftShader frames the `waitForFunction` polls are hundreds of ms apart, so the
  first acks land before the condition is observed. Replaced with "prediction tick must
  lead ack tick by ≥5" (same intent, robust to poll latency).
- **`deriveVirtualField[0]` is NOT the nearest rock to the ship** — it sorts by
  distance to the _cell center_. The first collision e2e run flew into a different rock
  than it was watching (bounce signature at the wrong range). Fixed by sorting by
  surface distance to the ship.
- **The e2e probe (`window.__probe.owned`) is rendered-frame-rate bound**: at ~3 fps
  the ship moves ~54 m between probe values, which can skip the entire 25 m contact
  window. Impact detection now uses server truth (API), the probe only guards the
  no-penetration invariant.
- **Fog kills distant emissives.** First screenshot pass: the nav beacon vanished past
  a few km. `fog: false` on every marker material (same trick GridStars uses).
- **The camera sits 120 m above the ship position** (cockpit offset) — close-range
  screenshot aiming must account for it or the subject lands below the frame.

### Verified (this session, on this machine)

- `bun run verify`: 128 pass / 1 fail — the fail is the documented pre-existing
  baseline (`diagnoses million-scale virtual asteroid index…`, formerly
  server.test.ts:921).
- `tests/integration/collision.test.ts`: 11 pass (derivation parity, pushout, swept
  no-tunnel at 2 km/step, actor wiring, prediction predict+replay, pair response,
  spawn spread).
- `verify:multiplayer`: lights on/off replicate to a second real client
  (`__probeRemoteLights` render-gate probe) + ship-ship ram: minGap 100.1 m
  (≥ 2×50 m), scout peak 21.6 m/s from the bump, final gap 107.3 m.
- `verify:prediction`: delayed-ack phase + rock collision: bounce 36.3 m/s from a
  180 m/s approach (= restitution 0.2), rendered ship never inside the rock.
- `verify:screenshot`, `verify:ui`, `verify:audio`, `verify:gameplay-100k`,
  `validate-100k` (19/19): all green.
- `verify:gpu-live:prod`: `GPU_LIVE_RESULT=PASS`, p95 16.8 ms ≈ 60 fps (frame budget
  holds with the new light components in the scene graph).
- Parity trio: `parity-check` 0/7 divergence, `parity-edge` DIVERGENT: 0,
  `parity-sphere` clean.
- Visual evidence (`bun scripts/bench/lights-visual.ts`, real Chrome/Metal):
  `screenshots/lights-close-{on,off}.png`, `screenshots/lights-far-{on,off}.png` —
  at 10.2 km the lit ship shows beam + beacon, the unlit ship is invisible.

## Session 2 (2026-06-09) — ships vs sun light + asteroid shadows: verified, no code change needed

Request: "make ships get lit up by directional lighting (but react to shadows from
asteroids)". Investigation showed **both already work**: the remote ship cone is a
`meshStandardMaterial` with `receiveShadow`, the sun is the shadow-casting directional
light, and the instanced asteroid field renders into the same tier-1 shadow map — so
asteroid shadows fall on ship hulls within the 16 km camera-following shadow bubble.

New proof harness `scripts/bench/ship-shadow-visual.ts` (real Chrome/Metal): autopilots
a remote ship to the sunlit side of a 322 m rock, then inside its shadow cone, with the
viewer at a ~260 m vantage. Result: sunlit hull = big red cone with a correct
terminator; shadowed hull = pitch black while neighboring out-of-shadow rocks stay lit.
Numeric gate: center luminance 47.96 lit vs 15.13 shaded (3.2×), `shipShadow: ok`.
Screenshots: `screenshots/ship-shadow-{sunlit,shaded}.png`.

Surprises:

- **The first two runs "failed" because the control spot was ALSO shadowed.** The field
  near spawn is dense enough that a random point has roughly even odds of sitting in
  some rendered rock's shadow — the harness now ray-marches toward the sun through all
  rendered rocks (base ± the ≤70 m cosmetic wobble: ±40 m/axis, see overlay kernel) and
  picks a verified-clear sunlit spot. This is also why ships frequently look black in
  normal play: they are correctly in shadow, which is exactly what the nav lights are
  for.
- A boosted-gain crop (`scripts/bench/png-boost.mjs`) was the diagnostic that revealed
  the "missing" ship as a pure-black silhouette against the #03040a background.

Known limits: beyond the 8 km tier-1 bubble ships do not receive the asteroids' tier-2
per-instance occlusion (asteroid-material-only) — at that range a 50 m hull is
sub-pixel, so tier-1 coverage is the whole observable regime. Ships do not cast
shadows (`castShadow` off on the cone); not requested, cheap to add if wanted.

### Not done / known limits

- Ship-ship bumps are server-corrected on the predicting client (by design — the other
  ship's inputs are unknowable); render-store smoothing absorbs the correction.
- The accepted ≤250 m visual-vs-gameplay rock mismatch (GPU cosmetic `pos` offset)
  applies to collisions as documented; gameplay uses `base` only.
- Nav-light look is functional but first-pass; beacon size/strobe cadence are
  constants in `lighting.ts` if art direction wants iteration.
