# Owned-ship jerky movement — root-cause + fix impl log

## Session (2026-06-09)

### Symptom

The local player's own ship movement **and** rotation were visibly jerky. Render FPS
was fine. Playing the same server over a Cloudflare tunnel from a _different_ machine
was noticeably **smoother** than playing on `localhost` via `bun dev:all`. Lower latency
making it worse is the signature of a wall-clock timing layer that network latency
accidentally smooths.

### Root cause (proven, not guessed)

The owned ship uses client-side prediction + server reconciliation. The two sides
advanced their fixed `1/60` physics step on **different clocks**:

- **Server** — `ServerWorld.advanceToNow` steps by **elapsed wall time**:
  `accumulator += elapsedMs; while (accumulator >= fixedDt) tick()` (`world.ts:340-405`).
  It integrates ~60 steps per wall-second regardless of input cadence (a forced tick
  per input is charged back against the accumulator, so input rate doesn't change the
  total).
- **Client** — `OwnedShipPrediction.predict()` advanced **one** step per
  `setInterval(1000/60)` fire (`prediction.ts:71`, driven from `EveApp.tsx`). That is a
  step **count**, not elapsed time.

On `localhost`, `bun dev:all` runs the server, the Vite client, and the per-frame WebGPU
asteroid compute all on one machine; the client's `setInterval` is starved below 60Hz by
main-thread contention. It then predicts fewer steps per wall-second than the server
integrates, the predicted pose lags the authoritative pose, and **every ack becomes a
reconcile correction** — a forward snap. The tunnel client machine is uncontended, holds
60Hz, matches the server, and stays smooth.

Rotation looked worse than translation for two compounding reasons: each correction
carried a rotation snap, and `FlightRenderStore` dead-reckoned **position** between
predicts but **not** rotation — it froze the rendered quaternion at the last predicted
step.

### Measurements

Two headless, deterministic experiments (no WebGPU needed). The second drives the
**real** `ServerWorld` + **real** `OwnedShipPrediction` with simulated wall time, so
there are no modeling assumptions; it is preserved as
`tests/integration/prediction-cadence.test.ts`.

Real-server, 5 wall-seconds, "fly forward + yaw", acks at 30Hz:

| cadence            | client timer | server steps | client predicts | corrections / acks |
| ------------------ | ------------ | ------------ | --------------- | ------------------ |
| step-count (bug)   | 60Hz         | 301          | 300             | 1 / 150 (0.7%)     |
| step-count (bug)   | 50Hz         | 301          | 250             | 36 / 150 (24%)     |
| step-count (bug)   | 40Hz         | 301          | 200             | 73 / 150 (49%)     |
| step-count (bug)   | 30Hz         | 300          | 150             | 107 / 150 (71%)    |
| elapsed-time (fix) | 50Hz         | 302          | 300             | 1 / 150 (0.7%)     |
| elapsed-time (fix) | 40Hz         | 302          | 300             | 1 / 150 (0.7%)     |
| elapsed-time (fix) | 30Hz         | 301          | 300             | 1 / 150 (0.7%)     |
| elapsed-time (fix) | 20Hz         | 300          | 300             | 0 / 150 (0%)       |

Bug-mode corrections scale directly with the timer deficit; each correction was a
~1.5 m mean / ~2.5 m max position snap plus a rotation snap up to ~0.036 rad. At an
uncontended 60Hz the bug never fires (the single correction is a startup transient that
the fix shares). The fix keeps client and server step counts matched at any fire rate
down to 20Hz, collapsing corrections to that same transient.

### Fix

1. **Predict by elapsed wall time, not by timer fires** (`EveApp.tsx` input timer,
   `constants.ts`). Each fire drains a fixed-step accumulator and sends+predicts
   `floor(elapsed / shipFixedDt)` steps. send+predict stays 1:1, so the entire
   stamp → ack → `findEntry` reconcile contract is unchanged; only the step **count**
   per wall-second changes from "timer fire rate" to "elapsed time". `maxFlightCatchupSec`
   bounds catch-up after a real stall. One-shot impulses (boost) ride only the first
   step of a fire — the server applies them exactly once.
2. **Angular-velocity dead-reckoning** in `FlightRenderStore.ownedRenderQuat()`
   (`renderStore.ts`), mirroring the existing position extrapolation (same
   `orientation * delta` convention as `ship-motion.ts`, capped at
   `maxOwnedExtrapolationSec`), so the rendered owned orientation advances every frame
   between predicts instead of freezing.

The shared integrator (`src/shared/ship-motion.ts`) stays single-source; no client/server
thrust math was forked.

### Verification

- `tests/integration/prediction-cadence.test.ts` — green: step-count@30Hz snaps on
  > 40% of acks; elapsed-time stays matched/clean at 50/40/30/20Hz.
- `bun run verify` — typecheck + oxfmt + integration tests (see commit notes for the
  known Windows-only flakes).
- **Live (owner, real WebGPU):** the headless build has no `navigator.gpu`, so smoothness
  was confirmed by the owner running `bun dev:all` at `http://localhost:5173`. Live probe
  `window.__predictionDebug` reports `timerHz`, `predictedStepsPerSec`,
  `correctionsPerSec`: under contention `timerHz` drops below 60 while
  `predictedStepsPerSec` holds ~60 and `correctionsPerSec` stays ~0.
