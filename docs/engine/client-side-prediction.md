# Client-Side Prediction & Server Reconciliation

## Purpose

The owning client must not wait a network round-trip to see its own ship move. In mars, the local player's freighter runs as `Role.AutonomousProxy`: every tick it integrates its own thruster command in a private, collider-less Rapier world, renders the predicted pose immediately, and buffers each `(clientTick, command, postState)`. The authoritative server echoes the last input tick it applied (`ackClientTick`) in every replication envelope header. On reconcile the client compares its buffered prediction at that tick against the server snapshot and either accepts it (drop acked entries) or rewinds the prediction body to server state and replays the still-buffered commands. This sits between [replication](./replication.md) (which delivers the server snapshot + ack) and [world & actors](./world-and-actors.md) (which defines the three roles and the tick-group ordering that decides when prediction runs).

> Note on the production client. The shipped `?mode=client` entry (`src/runtime/multiplayer-client.ts`) is _server-authoritative_ — its file header says "every freighter on this client is a SimulatedProxy." But the spawn handler actually wires the owning peer to `Role.AutonomousProxy` (`src/runtime/multiplayer-client.ts:250`) and stamps prediction ticks (`:338`). The prediction path described here is the live `AutonomousProxy` path that the spawn handler and `FreighterActor.updateAutonomous` implement; treat the file-header comment as stale.

## Mental model

One `FreighterActor` class, three roles:

- `Role.Authoritative` — server only. Driven by the real shared Rapier physics world via `this.rigidBody`.
- `Role.SimulatedProxy` — remote players on a client. Pose written straight from replication onto `mesh.group`; no physics. See [replication](./replication.md).
- `Role.AutonomousProxy` — the local player's own ship on a client. Never touches the shared physics world or `this.rigidBody`. Owns a private `PredictionWorld` and reconciles against the server.

The key idea: the prediction body is a _physical twin_ of the server body. Same mass (`FREIGHTER_MASS = 1e6`), same isotropic inertia (`FREIGHTER_INERTIA = 1e10`), same fixed timestep (`1/60`), zero gravity, **no colliders**. Stepping it integrates only the applied thruster forces, so it tracks the server's integration of the same body 1:1 within float precision. Divergence only comes from things the client can't predict (collisions it has no colliders for, other actors, server-side corrections) — and those are exactly what reconcile fixes.

```mermaid
sequenceDiagram
    participant IS as InputSystem (client)
    participant FA as FreighterActor (AutonomousProxy)
    participant PW as PredictionWorld
    participant WS as WebSocket
    participant SRV as Authoritative server
    participant CD as WebSocketClientDriver

    Note over IS,PW: each rAF frame
    IS->>FA: sendInput(command)
    Note right of FA: tick = currentPredictionTick + 1
    FA->>FA: applyThrust(command, tick)  (set this.command locally)
    FA->>WS: {type:'input', tick, command}  (TEXT frame)
    WS->>SRV: input
    SRV->>SRV: f.applyThrust(cmd); setPeerAckTick(peer, tick)
    SRV->>SRV: world.tick() steps real physics with cmd
    SRV->>CD: packEnvelope(this.tick, ack, deltas)  (BINARY frame)
    Note right of CD: header u32 ackClientTick @ byte 4
    CD->>CD: ingest -> pending + pendingMeta{tick, ack}
    Note over CD,FA: client world.tick() TOP: driver.apply()
    CD->>CD: AutonomousProxy -> stash LastServerFrame (do NOT write fields)
    Note over FA,PW: client world.tick() PostPhysics: updateAutonomous()
    FA->>CD: takeLastServerFrame(id)
    CD-->>FA: {tick, ackClientTick, snapshot}
    FA->>FA: reconcile(frame)  (accept OR rewind+replay)
    FA->>PW: applyThrustersTo(body); step()
    PW-->>FA: snapshot -> mesh.group + velocity mirrors
    FA->>FA: predictionTick++; pushEntry({clientTick, command, postState})
```

## Key types & APIs

### `BodyState` — the unit of prediction state

`src/actors/freighter/lib/prediction-world.ts:4`

```ts
export interface BodyState {
  pos: { x: number; y: number; z: number };
  quat: { x: number; y: number; z: number; w: number };
  linVel: { x: number; y: number; z: number };
  angVel: { x: number; y: number; z: number };
}
```

Used three ways: the `PredictionWorld` constructor seed, `InputBufferEntry.postState`, and the reconcile `serverState`.

### `PredictionWorld` — single-body, collider-less twin

`src/actors/freighter/lib/prediction-world.ts:23`

```ts
export class PredictionWorld {
  readonly world: RAPIER.World;
  readonly body: RAPIER.RigidBody;
  readonly fixedDt: number;
  constructor(init: BodyState, mass: number, inertia: number, fixedDt: number);
  setState(s: BodyState): void; // hard-write body + reset force/torque accumulators
  step(): void; // world.step()
  snapshot(): BodyState;
  dispose(): void; // world.free() — frees WASM
}
```

Construction (`:28`–`:47`): zero-gravity world `new RAPIER.World({ x: 0, y: 0, z: 0 })`; `world.timestep = fixedDt`; one dynamic body with `.setCanSleep(false)`, **no colliders**, mass/inertia set via `setAdditionalMassProperties(mass, {0,0,0}, {inertia,inertia,inertia}, {0,0,0,1}, true)`. `setState` calls `resetForces(false)` / `resetTorques(false)` before writing pose — Rapier never auto-clears its force accumulator.

### `InputBufferEntry` + buffer helpers

`src/actors/freighter/lib/input-buffer.ts:4`

```ts
export interface InputBufferEntry {
  clientTick: number;
  command: ThrusterCommand;
  postState: BodyState; // post-step body state at the end of this tick's integration
}

export function pushEntry(buf: InputBufferEntry[], e: InputBufferEntry): void;
export function dropEntriesThrough(buf: InputBufferEntry[], upToInclusive: number): void; // splice leading clientTick <= threshold
export function findEntry(buf: InputBufferEntry[], clientTick: number): InputBufferEntry | null;
export function isWithinTolerance(
  a: BodyState,
  b: BodyState,
  posTol: number,
  rotTol: number,
): boolean;
```

`isWithinTolerance` (`:37`):

```ts
if (dist3(a.pos, b.pos) > posTol) return false;
const dot = a.quat.x * b.quat.x + a.quat.y * b.quat.y + a.quat.z * b.quat.z + a.quat.w * b.quat.w;
const cosHalf = Math.cos(rotTol / 2);
return Math.abs(dot) >= cosHalf;
```

Position euclidean distance AND quaternion angle are **ANDed** — both must pass. The shortest-arc half-angle between two unit quats is `acos(|dot|)`, so `|dot| >= cos(rotTol/2)` means the rotation between them is `< rotTol` radians. `Math.abs(dot)` handles the quaternion double-cover (`q` and `-q` are the same rotation).

### `ThrusterCommand`

`src/actors/freighter/freighter-actor.ts:109`

```ts
export interface ThrusterCommand {
  main: number; // [0, 1] main engine throttle
  strafeX: number; // [-1, 1] RCS translation, body-local X
  strafeY: number;
  strafeZ: number;
  pitch: number; // [-1, 1] torque, body-local X
  yaw: number;
  roll: number;
}
```

### `LastServerFrame` — the per-actor stash

`src/runtime/websocket-client-driver.ts:11`

```ts
export interface LastServerFrame {
  tick: number;
  ackClientTick: number;
  snapshot: ReplicatedSnapshot; // raw replicated delta — MAY be partial
}
```

The snapshot is the raw replicated delta, which may contain only changed fields. Reconcile fills any missing `pos`/`quat`/`linVel`/`angVel` from the current prediction state. `takeLastServerFrame` is single-shot (deletes on read).

### Prediction state & tolerances on `FreighterActor`

`src/actors/freighter/freighter-actor.ts:330`–`347`

```ts
private predictionWorld: PredictionWorld | null = null
private inputBuffer: InputBufferEntry[] = []
private predictionTick = 0
get currentPredictionTick(): number { return this.predictionTick }

private static readonly POS_TOL_M = 0.5       // meters
private static readonly ROT_TOL_RAD = 0.02    // radians
private static readonly MAX_BUFFER_SIZE = 200
```

The constants `FREIGHTER_MASS = 1e6` and `FREIGHTER_INERTIA = 1e10` are at `src/actors/freighter/freighter-actor.ts:57`–`58`.

### The envelope header that carries the ack

`src/core/net-envelope.ts:152` (`packEnvelope`), header writes at `:162`–`:186`:

```ts
const header = new Uint8Array(10);
headerView.setUint32(0, tick >>> 0, true); // bytes 0..3  tick
headerView.setUint32(4, ackClientTick >>> 0, true); // bytes 4..7  ackClientTick
headerView.setUint16(8, entryCount, true); // bytes 8..9  entryCount — back-filled at :186
```

The `tick` and `ackClientTick` writes are consecutive at `:162`–`:163`, but the `entryCount@8` write is back-filled at `:186` after the entry-counting loop runs — so the snippet's in-order layout describes the byte layout, not the source write order. 10-byte little-endian header, no magic/version. `ackClientTick` rides at byte offset 4 on **every** sent frame. (Per-field payload sizes: `FIELD_BYTES = { scalar: 8, vec3: 24, quat: 32 }`, `net-envelope.ts:31`.) `unpackEnvelope` produces `DecodedEnvelope { tick, ackClientTick, entries }` (`net-envelope.ts:144`).

## Data-flow walkthrough

One concrete path: the local player holds thrust for one frame, and the server's reply arrives a few ticks later.

### Spawn / seed

1. Server sends a `Spawn` for the new freighter to its owning peer. `handleSpawn` (`src/runtime/multiplayer-client.ts:238`) creates the `FreighterActor`, sets `role = AutonomousProxy` because `msg.ownerPlayerId === myPlayerId` (`:250`), then `await actor.setup()`.
2. `setup()`'s `AutonomousProxy` branch (`src/actors/freighter/freighter-actor.ts:502`) constructs `new PredictionWorld(initState, FREIGHTER_MASS, FREIGHTER_INERTIA, 1/60)` with `initState` seeded from Kepler-at-`t=0` pose and **zero velocity** (`:503`–`:511`). The "Kepler-at-`t=0`" pose is the `initLocalPos`/`initQuat` pair computed earlier in `setup()` (`:421`, `:440`; the comment at `:413` derives it as `freighterPos(0) − dockPos(T)`). No Rapier `rigidBody` is created for proxies.
3. `applyInitialState` (`src/runtime/multiplayer-client.ts:62`) writes the server's real initial pose/velocity onto `mesh.group` + the velocity mirrors. Then, because `isOwn`, `actor.syncPredictionFromMesh()` (`:268`) copies that into the prediction body — so prediction starts from the server's initial state, **not** the Kepler placeholder. Then `activateActor` + `driver.registerReceiver`.

### Input stamp (each frame)

4. `InputSystem.tick()` calls `sendInput(command)` (`src/runtime/multiplayer-client.ts:335`). It bails if the WS isn't open, then computes `tick = (possessed?.currentPredictionTick ?? 0) + 1` (`:338`).
5. `sendInput` calls `possessed.applyThrust(command, tick)` **locally** (`:339`). `applyThrust` (`src/actors/freighter/freighter-actor.ts:530`) does `this.command = { ...cmd }`; the `_tick` arg is ignored. This local set is required: replication skips the `AutonomousProxy` (step 9), so without it the prediction body would integrate a stale/empty command and diverge every tick.
6. `sendInput` sends `{ type: 'input', tick, command }` as a **text** WS frame (`:340`–`:341`). Input travels outside the NetDriver flow. See [command & RPC](./command-rpc.md).

### Server applies + replicates

7. Dedicated server WS handler, on `msg.type === 'input'` (`src/runtime/dedicated-server.ts:221`): `f.applyThrust(msg.command, msg.tick)` on the authoritative freighter (`:223`) and `driver.setPeerAckTick(ws.data.playerId, msg.tick)` (`:224`). The server's `world.tick` steps the real Rapier physics with that command.
8. At the server tick bottom, `flush()` packs each peer's envelope: `packEnvelope(this.tick, this.peerAckTick.get(peerId) ?? 0, deltas, this.descs)` (`src/runtime/websocket-net-driver.ts:111`–`112`). The ack is per-peer (`peerAckTick: Map<string, number>`, `:38`), set by `setPeerAckTick` (`:70`). So this peer's `ackClientTick` is exactly the input tick the server last applied for it.

### Client ingest + apply

9. `driver.ingest(bytes)` (`src/runtime/websocket-client-driver.ts:60`): `unpackEnvelope` reads `tick` + `ackClientTick`; merges field-by-field into `pending`; records `pendingMeta { tick, ackClientTick }`, keeping the highest tick (`:71`–`:74`).
10. At the **top** of the client's `world.tick`, `driver.apply()` (`src/runtime/websocket-client-driver.ts:86`) drains `pending`. For the `AutonomousProxy` receiver it does **not** write any field values — it stashes `LastServerFrame { tick, ackClientTick (from pendingMeta), snapshot: delta }` and `continue`s (`:90`–`:98`). (`SimulatedProxy` receivers take the normal `applyValue` path, `:99`–`:103`.)

### Predict tick

11. `update(dt)` (`src/actors/freighter/freighter-actor.ts:862`) dispatches on role: `AutonomousProxy` → `updateAutonomous(dt)` and return (`:863`–`:866`). `FreighterActor.tickGroup = PostPhysics`, so this runs after `apply()`.
12. `updateAutonomous` (`:964`) order of operations:
    - **(a) Reconcile first.** `frame = driver.takeLastServerFrame(this.id) ?? null` (`:976`; guarded cast because in-memory test drivers lack the method). If a frame exists, `reconcile(frame)` runs at the **top**, before this tick's own integration.
    - **(b)** `applyThrustersTo(pw.body)` with the current `this.command` (`:980`).
    - **(c)** `pw.step()` — one fixed step (`:983`).
    - **(d)** `const s = pw.snapshot()`; write `s.pos`/`s.quat` into `mesh.group` and `s.linVel`/`s.angVel` into `_replicatedLinVel`/`_replicatedAngVel` (`:988`–`:992`).
    - **(e)** `this.predictionTick++` **then** `pushEntry(this.inputBuffer, { clientTick: this.predictionTick, command: { ...this.command }, postState: s })` (`:995`–`:1000`). Increment-before-push is what makes `entry.clientTick` equal the stamp the driving input carried.
    - **(f)** Trim: if `inputBuffer.length > MAX_BUFFER_SIZE`, `splice(0, length - 200)` (`:1003`–`:1005`).
    - **(g)** `stepCosmetics(dt)` (spine/container jiggle from the new quat) and `updateDebugVectors()`.

### Reconcile

13. `reconcile(frame)` (`src/actors/freighter/freighter-actor.ts:1016`):
    - Build `serverState: BodyState` from `frame.snapshot`, filling any missing field from `pw.snapshot()` — deltas can be partial (`:1021`–`:1028`).
    - `ack = frame.ackClientTick`; `entry = findEntry(this.inputBuffer, ack)` (`:1029`–`:1031`).
    - **Case 1 — no entry** (buffer too stale, server too far ahead): `pw.setState(serverState); this.inputBuffer.length = 0; return` (`:1032`–`:1037`). Hard-snap and clear.
    - **Case 2 — entry found AND within tolerance** (`isWithinTolerance(entry.postState, serverState, POS_TOL_M=0.5, ROT_TOL_RAD=0.02)`): `dropEntriesThrough(this.inputBuffer, ack); return` (`:1039`–`:1046`). Accept the prediction, drop acked entries.
    - **Case 3 — divergence**: `pw.setState(serverState); dropEntriesThrough(this.inputBuffer, ack)`; then for every remaining buffered `e`: `this.command = { ...e.command }; this.applyThrustersTo(pw.body); pw.step(); e.postState = pw.snapshot()` (`:1048`–`:1056`). Rewind to server state, replay all still-buffered commands forward, and **rewrite each entry's `postState`** to the corrected trajectory.

### Closing the loop

14. Back in `updateAutonomous`, the live tick advances on top of the reconciled state, and pushes a new entry with `clientTick = predictionTick`. The next input frame stamps `tick = currentPredictionTick + 1` — exactly the `clientTick` of the entry the _next_ prediction tick will create. So `findEntry(buf, ack)` resolves the exact entry the server's acked input drove, 1:1.

## Invariants & gotchas

- **Stamp with `currentPredictionTick + 1`, never `world.currentTick`.** The buffer is keyed on the client's private `predictionTick`, which advances only inside `updateAutonomous`, once per local prediction tick (`freighter-actor.ts:995`). `world.currentTick` advances on a different schedule (and lags the envelope header by one tick — see [replication](./replication.md)). Using the world tick would make `findEntry` miss every time.

- **Increment-before-push is load-bearing.** `predictionTick++` happens _before_ `pushEntry` (`:995`–`:1000`), so the entry's `clientTick` equals the stamp the input that drove it carried. Flip the order and every ack would resolve to the wrong entry (off by one).

- **The `AutonomousProxy` is deliberately excluded from direct replication.** `WebSocketClientDriver.apply` stashes a `LastServerFrame` and skips writing field values (`websocket-client-driver.ts:90`–`98`). If you removed that skip, replication would clobber the predicted pose on `mesh.group` every tick and prediction would be pointless.

- **`sendInput` must `applyThrust` locally as well as send over the WS.** Because of the previous invariant, the command never comes back to the `AutonomousProxy` through replication. The local `applyThrust` (`multiplayer-client.ts:339`) is the only way `this.command` reaches the prediction body. Drop it and the body integrates a stale command and diverges every tick.

- **`applyThrustersTo` reads pose from the body argument, not `mesh.group`.** `body.rotation()` / `body.translation()` (`freighter-actor.ts:606`–`609`). This is essential for the replay loop: after `pw.setState(serverState)`, `mesh.group` still holds the old predicted pose; reading from `pw.body` ensures thrust directions use the just-rewound pose. Across the replay loop `mesh.group` lags the rewound body by one iteration (it's only updated once, at the end of `updateAutonomous`).

- **Rapier never auto-clears its force/torque accumulators.** `applyThrustersTo` calls `resetForces(false)`/`resetTorques(false)` every call (`:603`–`:604`), and `PredictionWorld.setState` resets them too (`prediction-world.ts:51`–`52`). Forget either and held input piles forces up quadratically and the body spins chaotically (see the comment at `freighter-actor.ts:596`).

- **No colliders, zero gravity is what makes the twin a twin.** The prediction body only integrates applied forces. Matching the server 1:1 within float precision requires _identical_ mass (`1e6`), isotropic inertia (`1e10`), and timestep (`1/60`) on both sides. Any mismatch produces constant drift and needless rewinds.

- **Server snapshots can be partial.** `diffSnapshots` sends only changed fields (see [replication](./replication.md)), so `frame.snapshot` may carry e.g. `pos` + `quat` but not `linVel`. Reconcile fills absent fields from the current prediction snapshot before comparing/applying (`:1023`–`:1028`). Assuming all four fields are present would write `undefined` into the body.

- **Divergence replay rewrites `postState`.** Each replayed entry's `postState` is set to the new post-rewind trajectory (`:1055`). This keeps future tolerance comparisons meaningful — a later ack compares against the corrected state, not the original misprediction.

- **`this.command` after a divergence replay holds the last replayed entry's command** (`:1052`), not an explicit reset. `updateAutonomous` immediately re-applies `this.command` for the live tick; correctness relies on the input sender having kept `this.command` current via `applyThrust`. Edge case worth knowing if input ever arrives through a path that doesn't update `this.command`.

- **The buffer is a plain JS array, not a fixed ring.** `MAX_BUFFER_SIZE = 200`; overflow is trimmed by splicing the oldest excess (`:1003`–`:1005`), and `dropEntriesThrough` splices the acked prefix. Entries are always in ascending `clientTick` order (they're pushed in increasing `predictionTick` order), which both `dropEntriesThrough` and the replay loop rely on.

- **The ack travels on every frame, independent of which actors changed.** It's sourced per-peer from `peerAckTick` (`websocket-net-driver.ts:38`), so a single global value would be wrong with multiple peers. A peer with no inbound input yet acks `0` (default at `:111`).

- **`predictionWorld` holds WASM memory.** `FreighterActor.dispose` calls `predictionWorld?.dispose()` (`world.free()`) then nulls it (`:1313`–`:1315`). Skip it and you leak.

- **Reconcile runs at the top of the tick.** The just-arrived server frame is applied _before_ this tick's own integration and buffer push, so the live tick advances on top of the reconciled state.

## Porting to haystack

haystack is Bun + Hono server + React/react-three-fiber + three.js client, vs mars's Bun + vanilla three + Rapier + unix-socket RPC. The prediction algorithm is transport- and renderer-agnostic; most of it ports directly. Concrete notes:

### Current haystack implementation

Haystack now uses the custom TypeScript ship simulation, not Rapier, for owned-ship
prediction. The deterministic movement math lives in `src/shared/ship-motion.ts`; both
`src/server/world.ts` and `src/client/eve/prediction.ts` call that module instead of
duplicating thrust, cruise, boost, stabilizer, orientation, position, and heat formulas.
The shared fixed step is `shipFixedDt = 1 / 60`.

The browser-owned ship prediction loop is `OwnedShipPrediction` in
`src/client/eve/prediction.ts`:

- outgoing stream inputs are stamped with `currentPredictionTick + 1`;
- each successful send advances local prediction once and buffers
  `{ clientTick, command, postState }`;

### Cadence: predict by ELAPSED WALL TIME, not by timer-fire count

`OwnedShipPrediction.predict()` advances exactly one `shipFixedDt = 1/60` step per
call. The number of steps the client takes per wall-second must equal the number the
server integrates per wall-second, or the predicted pose drifts and every ack snaps it
back — the classic "localhost is jerkier than a remote tunnel" symptom, because the
server steps by **elapsed time** (`ServerWorld.advanceToNow`'s `while (accumulator >=
fixedDt)`, `world.ts:340-405`) while a contended client's `setInterval` fires below
60Hz.

So the EveApp input timer (`src/client/eve/EveApp.tsx`) does **not** predict once per
fire. It drains a wall-clock fixed-step accumulator: each fire adds the real elapsed
time and sends+predicts `floor(elapsed / shipFixedDt)` steps (1:1 send+predict
preserved — the server then runs one forced tick per input and ~zero background ticks,
so each acked tick maps to a predicted step). A starved timer simply takes more steps
per fire and stays matched to the server. `maxFlightCatchupSec` (constants.ts) bounds
the catch-up after a real stall (backgrounded tab) so resume reconciles once instead of
bursting. One-shot impulses (boost) ride only the first step of a fire — the server
applies them exactly once. Regression: `tests/integration/prediction-cadence.test.ts`
(step-count cadence under a 30Hz timer snaps on >40% of acks; elapsed-time cadence
stays matched and clean at 50/40/30/20Hz). Live probe: `window.__predictionDebug`.

`FlightRenderStore` (`renderStore.ts`) dead-reckons BOTH position (by `predVel`) and
orientation (by `predAngVel`, same `orientation * delta` convention as the shared
integrator) between predicts, capped at `maxOwnedExtrapolationSec`, so the rendered
owned pose advances every animation frame instead of freezing at the last predicted
step.

- ACK frames carry `ackClientTick` and the authoritative ship frame;
- matching ACKs drop buffered entries without writing the ACKed server pose onto the
  currently rendered owned ship;
- divergent ACKs rewind to the server ship and replay still-unacknowledged commands.

The Hono WebSocket world stream stays JSON-based for now. It sends `ack` messages with
both `ackClientTick` and the older compatibility field `clientTick`; it sends normal
snapshot `delta` messages for shared-world replication. The client applies remote ships
from those snapshots normally, but owned-ship movement fields from snapshot/delta traffic
are preserved from `OwnedShipPrediction` so ACKs and world deltas cannot hard-clobber the
first-person camera/local-origin source of truth. Remote ships interpolate their rendered
transform in `WorldView` to hide low-frequency snapshot stepping.

### Reuse almost verbatim

- **The input-buffer helpers** (`pushEntry`, `dropEntriesThrough`, `findEntry`, `isWithinTolerance`) are pure logic. In current Haystack they are represented inside `OwnedShipPrediction` rather than copied as standalone helpers, because the sim twin is a plain TypeScript `Ship` state instead of a Rapier body.
- **The stamp → echo → `findEntry` contract.** Stamp outgoing input with a _client_ prediction tick (`currentPredictionTick + 1`), round-trip it back unchanged as `ackClientTick`, and key the buffer on it. Keep the increment-before-push ordering. This is the heart of the design and doesn't care about transport.
- **Per-peer ack tracking.** Haystack currently sends ACKs as explicit JSON `ack` frames on the subscribed peer's world stream. If/when the stream moves to binary envelopes, keep the same per-peer `ackClientTick` semantics in the envelope header.

### Adapt for haystack's stack

- **Transport.** mars uses a single WebSocket multiplexing JSON text frames (input/spawn) and binary envelopes (replication) with no discriminant, branching on `typeof data`. Current Haystack uses typed JSON messages over Hono WebSockets: `input` client frames, `ack` server frames, and `delta` snapshot patches. What matters is that the server echoes `ackClientTick` for the owning peer and the client never treats owned-ship `delta` data as render-authoritative movement.

- **Render integration (react-three-fiber).** mars writes the predicted pose directly onto `mesh.group.position`/`.quaternion` inside `updateAutonomous` (`:989`–`:990`), driven by an imperative rAF loop. In r3f, do the same imperative write inside a `useFrame` callback against a ref'd `Object3D` — do **not** route predicted pose through React state (a per-frame `setState` will tank you). The prediction loop is the source of truth for the owned actor's transform; React only owns mount/unmount.

- **The "exclude owned actor from replication apply" rule.** mars implements this as a role check in `WebSocketClientDriver.apply` (`:90`). In current Haystack, `mergeWorldPatchForOwnedPrediction` and `mergeWorldSnapshotForOwnedPrediction` preserve the predicted owned movement fields while applying normal snapshot data for remote ships and non-motion data. Remote actors take the normal apply path.

- **Tick-group ordering.** In mars, `apply()` runs at the top of `world.tick`, `updateAutonomous` runs in the `PostPhysics` group, and the renderer draws after `world.step` returns within the same rAF frame (see [world & actors](./world-and-actors.md) and [runtime topologies](./runtime-topologies.md)). Replicate the ordering: **drain inbound frames → reconcile + predict → render**. Reconcile must consume the stashed frame _before_ the live tick integrates.

- **Spawn seed.** Don't forget the `syncPredictionFromMesh` step (`multiplayer-client.ts:268`): after the server's initial state lands on the render transform, explicitly push it into the prediction body. The `PredictionWorld` constructor seed is a placeholder that the first prediction tick would otherwise clobber the real initial state with.

### Don't skip

- Reset Rapier force/torque accumulators before every force application and on every `setState`.
- Make the prediction state use the same integrator as the authoritative server. In current Haystack that means `src/shared/ship-motion.ts`; do not reintroduce separate client/server thrust formulas.
- Tolerate partial server snapshots in reconcile.
- Rewrite `postState` during replay.
- Bound the buffer and hard-snap when an ack is older than anything buffered.

## See also

- [Replication](./replication.md) — the envelope/ack wire format and the `SimulatedProxy` apply path.
- [World & actors](./world-and-actors.md) — roles, tick groups, and tick ordering.
- [Command & RPC](./command-rpc.md) — how input messages travel outside the NetDriver.
- [Runtime topologies](./runtime-topologies.md) — server-authoritative vs other modes.
- [Engine docs index](./README.md)
