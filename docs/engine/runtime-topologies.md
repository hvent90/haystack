# Runtime Topologies & Scene Composition

## Purpose

This document covers how mars assembles **one `World` per process** out of shared, reusable pieces — static scene actors, freighter actors with a `Role`, a `NetDriver`, and (in the browser) a presentation layer — into three distinct runtime topologies: **listen-server**, **dedicated-server**, and **multiplayer-client**. The entry points live in `src/runtime/`; the composition helpers in `src/runtime/sim-scene.ts` and `src/runtime/presentation-setup.ts`. This sits one level above the [World/Actor lifecycle](./world-and-actors.md) and the [replication transport](./replication.md): the topology files decide _which actors exist, with what authority, behind which driver_, and the World/replication layers do the rest. For the prediction path an `AutonomousProxy` runs, see [client-side prediction](./client-side-prediction.md); for the agent control plane, see [command RPC](./command-rpc.md).

## Mental model

There is exactly one `World` per process. Scene composition is split along two axes:

1. **Static actors** (`physics`, `dock`, optional `phobos`) — identical on every peer, constructed _locally_ by `buildStaticScene`, carry **no replicated state**, and are never sent over the wire (`src/runtime/sim-scene.ts:35`).
2. **Freighter actors** — the player ships. Each is spawned with an explicit `Role` (`src/runtime/sim-scene.ts:61`). The `Role` is the _single axis_ that distinguishes the three topologies at the actor level.

Three entry-point files compose these differently:

```
                         ┌───────────────────────── shared ─────────────────────────┐
                         │  buildStaticScene  spawnFreighter  World  Role  NetDriver  │
                         └───────────────────────────────────────────────────────────┘
                                    │                    │                    │
        ┌───────────────────────────┘                    │                    └───────────────────────────┐
        ▼                                                 ▼                                                ▼
 listen-server.ts                              dedicated-server.ts                          multiplayer-client.ts
 (browser, ?mode≠client)                       (headless Bun/Node process)                  (browser, ?mode=client)
 ───────────────                               ───────────────────                          ──────────────────
 InMemoryNetDriver (pass-through)              WebSocketNetDriver (per-peer shadow)          WebSocketClientDriver (ingest)
 1 Authoritative 'freighter'                   per-peer Authoritative 'freighter-<id>'        own = AutonomousProxy
 + full presentation                           + RPC unix socket (agent control)              others = SimulatedProxy
                                               + Bun.serve WebSocket per peer                  + full presentation, no local sim
```

Role assignment is purely a function of topology + ownership:

- **Server side** (dedicated-server, and the listen-server's single ship): always `Role.Authoritative`. Owns canonical state, creates the Rapier body in `setup()`, is auto-registered with the driver.
- **Client side** (`?mode=client`): the client owns _no_ sim authority. Freighters arrive via `Spawn` messages. The client compares `Spawn.ownerPlayerId` to its own `Hello.playerId` to choose `AutonomousProxy` (its own ship, with client-side prediction) vs `SimulatedProxy` (everyone else, mesh driven directly by replicated deltas).

The async actor lifecycle — `attachActor` → `await setup()` → `activateActor` — exists because `FreighterActor.setup()` async-loads an FBX and `update()` crashes on un-loaded bones. Attaching (scene graph + world ref) is separated from activating (tick list + replication registration) so the already-running tick loop never ticks a half-loaded ship.

## Key types & APIs

### Role — the single composition axis

```ts
// src/core/role.ts:8
export enum Role {
  Authoritative = "authoritative",
  SimulatedProxy = "simulated-proxy",
  AutonomousProxy = "autonomous-proxy",
}
```

`activateActor` only auto-registers `Authoritative` actors with the driver (`src/core/world.ts:149`). `SimulatedProxy` and `AutonomousProxy` are _not_ auto-registered — on the client, `handleSpawn` calls `driver.registerReceiver(actor)` explicitly.

### Scene composition (`src/runtime/sim-scene.ts`)

```ts
// src/runtime/sim-scene.ts:11
export type SceneName = "default" | "crane-test";

// src/runtime/sim-scene.ts:16 — identical on every peer, never replicated
export interface StaticSceneActors {
  physics: PhysicsActor;
  dock: FreightDockActor;
  phobos?: PhobosActor;
  applyPostSetup: (freighter: FreighterActor | null) => void;
}

// src/runtime/sim-scene.ts:23 — Role is caller-supplied: this is where each topology stamps authority
export interface SpawnFreighterOptions {
  id: string;
  role: Role;
  scene: SceneName;
  static: StaticSceneActors;
}

// src/runtime/sim-scene.ts:81 — listen-server-only convenience bundle
export interface SimActors {
  physics: PhysicsActor;
  dock: FreightDockActor;
  freighter: FreighterActor;
  phobos?: PhobosActor;
  applyPostSetup: () => void;
}
```

```ts
// src/runtime/sim-scene.ts:35
export function buildStaticScene(world: World, scene: SceneName): StaticSceneActors;

// src/runtime/sim-scene.ts:61
export function spawnFreighter(world: World, opts: SpawnFreighterOptions): FreighterActor;

// src/runtime/sim-scene.ts:89 — buildStaticScene + one Authoritative 'freighter'
export function buildSimScene(world: World, scene: SceneName): SimActors;
```

`buildStaticScene` adds `PhysicsActor` and `FreightDockActor` (wiring `dock.physics = physics`), adds `PhobosActor` only for `scene === 'default'`, and for `crane-test` sets `world.timeScale = 0` and returns an `applyPostSetup` that calls `placeFreighterInCraneReach` (`src/runtime/sim-scene.ts:106`). `spawnFreighter` constructs the freighter, sets `f.role` from the option, wires `f.physics`, and — only when `role === Role.Authoritative` — points `dock.freighter = f` (the dock tracks one "primary" freighter for crane logic; `src/runtime/sim-scene.ts:69`). Note `spawnFreighter` calls `world.addActor` (attach + activate immediately), which is fine because all callers run `world.setupActors()` before any tick.

### Presentation (browser only, `src/runtime/presentation-setup.ts`)

```ts
// src/runtime/presentation-setup.ts:13 — handles are 'any' because the modules are dynamically imported
export interface PresentationActors {
  camera: any; // PlayerCameraActor
  planet?: any; // PlanetActor
  hud: any; // HUDActor
  postProcessing: any; // PostProcessingActor
}

// src/runtime/presentation-setup.ts:20
export async function buildPresentation(
  world: World,
  render: RenderSystem,
  canvas: HTMLCanvasElement,
  scene: SceneName,
  sim: SimActors,
): Promise<PresentationActors>;
```

Every WebGPU/THREE-dependent actor module is loaded with `await import(...)` (`src/runtime/presentation-setup.ts:29,38,53,66,73`), so this file _never evaluates_ in Node — the dedicated-server imports none of it. For `default` it imports and wires `PlanetActor` and sets `sim.freighter.planet`; for non-planet scenes it imports `three` and adds a `DirectionalLight` + `AmbientLight` on layer 1. It then imports `PlayerCameraActor` (target = `freighter.group` for default, else `dock.object3D`; `world.mainCamera = camera.camera`), `HUDActor`, and `PostProcessingActor` (`atmosphereEnabled = false` if no planet; `render.hasPostProcessing = true`).

### Dedicated-server config & per-peer state (`src/runtime/dedicated-server.ts`)

```ts
// src/runtime/dedicated-server.ts:25
interface Args {
  scene: SceneName;
  sockPath: string; // --sock, default /tmp/mars.sock
  publicDir: string; // --public
  startPaused: boolean; // --paused
  hz: number; // --hz, default 60
  wsPort: number; // --ws-port, default 6499
  defaultFreighter: boolean; // --default-freighter
}

// src/runtime/dedicated-server.ts:58 — carried on ws.data per WebSocket
interface PeerState {
  playerId: string;
  freighterId: string;
  freighter: FreighterActor | null; // null until setup() completes; close handler guards on it
}
```

```ts
// src/runtime/websocket-net-driver.ts:26
export interface WebSocketNetDriverOptions {
  send: (peerId: string, bytes: Uint8Array) => void;
  ownerOf: (actorId: string) => string | null;
}
```

The dedicated-server constructs the driver with `send` resolving `peerSockets.get(peerId).send` and **`ownerOf: () => null`** (`src/runtime/dedicated-server.ts:83`) — see [Invariants](#invariants--gotchas) for why.

### Wire messages (`src/runtime/wire-protocol.ts`)

```ts
// src/runtime/wire-protocol.ts:22 — server→client, first message on open
export interface HelloMessage {
  type: "hello";
  playerId: string;
  scene: SceneName;
  tick: number;
}

// src/runtime/wire-protocol.ts:32 — server→client; client compares ownerPlayerId to myPlayerId
export interface SpawnMessage {
  type: "spawn";
  actorId: string;
  className: string;
  ownerPlayerId: string | null;
  initialState: ReplicatedSnapshot;
}

// src/runtime/wire-protocol.ts:53 — client→server only
export interface InputMessage {
  type: "input";
  tick: number;
  command: ThrusterCommand;
}
```

Text frames carry JSON `WireMessage`s (`hello`/`spawn`/`despawn`/`input`/`peer-joined`/`peer-left`); binary frames carry replication envelopes. There is no top-level binary discriminant — receivers branch on `typeof data` (`src/runtime/wire-protocol.ts:5-15`). See [replication](./replication.md) for the envelope encoding.

### World attach/activate split (`src/core/world.ts`)

```ts
// src/core/world.ts:119 — attach + activate, used when the tick loop is NOT yet running
addActor<T extends Actor>(actor: T): T

// src/core/world.ts:131 — id check + world ref + sceneRoot.add(object3D); does NOT tick
attachActor<T extends Actor>(actor: T): T

// src/core/world.ts:146 — push to tick list; if netDriver && role===Authoritative → netDriver.register(actor)
activateActor<T extends Actor>(actor: T): T
```

## Data-flow walkthrough

The three topologies share `World.tick()`, whose ordering every driver plugs into (`src/core/world.ts:195`): `netDriver.apply()` at the **top**, then tick groups in order (`PrePhysics → Physics → PostPhysics → PostUpdateWork`), then `auth = actors.filter(role===Authoritative); netDriver.collect(auth); netDriver.flush()` at the **bottom**, then counters increment and `onTick` listeners fire. **Send is at tick bottom; apply is at tick top.**

### Browser boot dispatch

`src/main.ts:5` reads `URLSearchParams('mode')`: `=== 'client'` → `mainMultiplayerClient`, otherwise `mainListenServer`. The dedicated-server is launched separately as a Bun/Node process.

### Topology 1 — Listen-server (`mainListenServer`, `src/runtime/listen-server.ts:18`)

1. `setAssetLoader(browserAssetLoader)`; read `?scene`.
2. `new World()`; `world.netDriver = new InMemoryNetDriver()` (`src/runtime/listen-server.ts:26`).
3. `RenderSystem` init.
4. `buildSimScene(world, scene)` → static scene + one singleton `Authoritative` freighter id `'freighter'` (`src/runtime/sim-scene.ts:89`).
5. `await buildPresentation(...)` — dynamic-imports camera/HUD/planet/post.
6. `await world.setupActors()` — FBX load; the Rapier body is created here because the freighter is `Authoritative`.
7. `sim.applyPostSetup()`; `world.setPossessedActor(sim.freighter)`.
8. `InputSystem` callback → `sim.freighter.applyThrust`; `DebugHUD` with server-authoritative controls.
9. rAF loop: `input.tick(); world.step(wallDt); render`.

The `InMemoryNetDriver` collects + flushes every tick but **no receivers are registered**, so replication stays pure pass-through (`src/runtime/listen-server.ts:14-16` doc-comment). It keeps the replication path warm for debug.

### Topology 2 — Dedicated-server (`main`, `src/runtime/dedicated-server.ts:64`)

**Boot:**

1. `parseArgs`; `setAssetLoader(createNodeAssetLoader(publicDir))`.
2. `new World()`; `buildStaticScene(world, scene)` (static imports only — Node-safe).
3. Construct `WebSocketNetDriver({ send: peerSockets…, ownerOf: () => null })`; `world.netDriver = driver`; `world.onTick(() => driver.setTick(world.currentTick))` (`src/runtime/dedicated-server.ts:86`).
4. Optionally `spawnFreighter('freighter', Authoritative)` if `--default-freighter` (`src/runtime/dedicated-server.ts:95`).
5. `await world.setupActors()`; `stat.applyPostSetup(defaultFreighter)` (`src/runtime/dedicated-server.ts:104`).
6. Build `Dispatcher` + `registerVerbs` + `RPCServer.listen(sockPath)` — the agent control plane (`src/runtime/dedicated-server.ts:112-113`; see [command RPC](./command-rpc.md)).
7. `Bun.serve` WebSocket on `:wsPort/net` (gameplay plane) — the `fetch` handler 404s any path other than `/net` (`src/runtime/dedicated-server.ts:137,141`).
8. `setInterval(1000 / hz)` ticks `world` **only when `mode.value === 'free-running'`** (`src/runtime/dedicated-server.ts:247-248`).

**Per-peer join handshake** (`websocket.open`, `src/runtime/dedicated-server.ts:149`) — note the strict ordering:

1. `peerSockets.set(playerId, ws)`; `driver.addPeer(playerId)`.
2. **Send `Hello` FIRST** — clients gate all spawn handling on it (`src/runtime/dedicated-server.ts:162`).
3. **Send a `Spawn` for every existing `FreighterActor`** in `world.actors` (`src/runtime/dedicated-server.ts:165-169`).
4. `new FreighterActor(freighterId)` with `role = Authoritative`, `physics = stat.physics`; `world.attachActor(f)`; `ws.data.freighter = f` (`src/runtime/dedicated-server.ts:175-179`).
5. `await f.setup()` (FBX load); on throw → `ws.close(); return` (`src/runtime/dedicated-server.ts:182-187`).
6. **Zombie guard:** if `ws.readyState !== WebSocket.OPEN` (peer left during setup), `f.dispose(); return` _without activating_ (`src/runtime/dedicated-server.ts:193-196`).
7. `stat.dock.freighter = f`; `world.activateActor(f)` (this registers it with the driver, since it is `Authoritative`); if `crane-test`, `stat.applyPostSetup(f)` (`src/runtime/dedicated-server.ts:198-200`).
8. `spawn = buildSpawnMessage(f)`; **send `spawn` directly to the owning peer** (`ws.send`), then `broadcast(spawn, except = playerId)` and `broadcast(peer-joined, except = playerId)` (`src/runtime/dedicated-server.ts:205-209`).

`buildSpawnMessage` (`src/runtime/dedicated-server.ts:126`) captures a snapshot and sets `ownerPlayerId = f.id.startsWith('freighter-') ? f.id.slice('freighter-'.length) : null`. **The `'freighter-'` id prefix is the only mechanism by which a client learns which freighter is its own.**

**Steady state:** a client `input` text frame → `ws.data.freighter?.applyThrust(command, tick)` + `driver.setPeerAckTick(playerId, tick)` (`src/runtime/dedicated-server.ts:221-225`). All non-input message types are server-originated and ignored. Each tick, `flush()` diffs the per-peer shadow and `packEnvelope(tick, peerAckTick, deltas)` → `ws.send` binary to each peer (`src/runtime/websocket-net-driver.ts:95-116`). Because `ownerOf` returns null, even the owner receives its own freighter's state.

**Disconnect** (`websocket.close`, `src/runtime/dedicated-server.ts:230`): `peerSockets.delete`; `driver.removePeer`; **`if (freighter) world.removeActor(freighter)`** — the `freighter !== null` guard is what prevents the zombie path; then `broadcast(despawn(freighterId))` + `broadcast(peer-left(playerId))`.

### Topology 3 — Multiplayer-client (`mainMultiplayerClient`, `src/runtime/multiplayer-client.ts:151`)

**Boot:**

1. `connectAndHandshake(wsUrl)` (`src/runtime/multiplayer-client.ts:91`) opens the socket (`binaryType = 'arraybuffer'`), buffers every message until the first text message decodes to `type === 'hello'`, then resolves `{ ws, hello, buffered }`. 5s timeout; error/close before hello reject.
2. `myPlayerId = hello.playerId`; `sceneName = hello.scene`.
3. `new World()`; `driver = new WebSocketClientDriver()`; `world.netDriver = driver`.
4. `RenderSystem` init; `buildStaticScene(sceneName)` (Node-safe parts; runs locally — same actors as the server's).
5. Dynamic-import planet (default) / lights (crane), `PlayerCameraActor`, `HUDActor`, `PostProcessingActor` — **no local freighter built** (`src/runtime/multiplayer-client.ts:182-215`).
6. `await world.setupActors()`; `stat.applyPostSetup(null)`.
7. `DebugHUD` with server-authoritative panels hidden (this peer is not the authority).
8. Install the real `onMessage`; **replay `buffered` in order** (`src/runtime/multiplayer-client.ts:316-317`).
9. rAF loop: `input.tick(); world.step(wallDt); render`.

**Per-`Spawn`** (`handleSpawn`, `src/runtime/multiplayer-client.ts:238`):

1. Dedup on `proxies.has(msg.actorId)`; only handle `className === 'FreighterActor'`.
2. `createActor(msg.className, msg.actorId)` (`src/core/actor-registry.ts`).
3. `isOwn = msg.ownerPlayerId === myPlayerId`; `actor.role = isOwn ? AutonomousProxy : SimulatedProxy`; `actor.physics = stat.physics`; wire `planet` if present.
4. `world.attachActor(actor)`; `await actor.setup()` (proxy: no Rapier body; `AutonomousProxy`: a private `PredictionWorld`); on throw → status error + return.
5. `applyInitialState(actor, msg.initialState)` (`src/runtime/multiplayer-client.ts:62`) — writes the full snapshot using the same semantics as the driver's `applyValue` (custom `set`, else scalar assign, else vec3/quat `.set`).
6. If `isOwn`: `actor.syncPredictionFromMesh()` — push the server pose into the `PredictionWorld` body (must run _after_ `applyInitialState`).
7. `world.activateActor(actor)`; **`driver.registerReceiver(actor)`** (proxies aren't auto-registered); `proxies.set(...)`.
8. If `isOwn`: `camera.target = actor.group`; `world.setPossessedActor(actor)`.

**Steady state:** each binary frame → `driver.ingest` merges deltas into `pending` (`src/runtime/websocket-client-driver.ts:60`). `world.tick()` top → `driver.apply()` (`src/runtime/websocket-client-driver.ts:86`): `SimulatedProxy` deltas are written straight onto the mesh getters via `applyValue`; `AutonomousProxy` deltas are **stashed** as `lastServerFrames` (consumed by reconcile inside `updateAutonomous`, _not_ applied directly). Local input → `applyThrust` locally + `InputMessage` over the WS — see [client-side prediction](./client-side-prediction.md).

## Invariants & gotchas

- **Role is the only composition switch.** `activateActor` auto-registers with the driver _only_ for `Authoritative` actors (`src/core/world.ts:149`). On the client, proxies are not `Authoritative`, so `handleSpawn` must call `driver.registerReceiver(actor)` explicitly (`src/runtime/multiplayer-client.ts:270`) — `activateActor` will not.

- **Async lifecycle ordering: attach → await setup() → activate.** `attachActor` does scene-graph + world ref only, _no tick_ (`src/core/world.ts:131`); `await setup()` async-loads the FBX (and creates the Rapier body for `Authoritative`); `activateActor` adds to the tick list + registers replication (`src/core/world.ts:146`). `update()` on an un-loaded freighter crashes on empty bones, and the already-running `setInterval` / rAF loop would tick it mid-load — hence the split is used in both `dedicated-server.open` and client `handleSpawn` while the loop runs.

- **Spawn order on open is load-bearing.** `Hello` first (clients buffer everything until it arrives — `connectAndHandshake`), then pre-existing `Spawn`s, then (after `setup()`) the new freighter's `Spawn` (`src/runtime/dedicated-server.ts:155-209`).

- **Server→owning-peer Spawn echo asymmetry.** The join sequence sends the new freighter's `Spawn` _directly_ to its own socket (`ws.send(encodeMessage(spawn))`) **and** `broadcast(spawn, playerId)` — which _excludes_ the joiner (`src/runtime/dedicated-server.ts:207-208`). So a joiner receives its own `Spawn` via the direct send, never via the broadcast. The first joiner sees no pre-existing `Spawn`s, only its own direct one. The e2e test documents this exact asymmetry (`src/runtime/multiplayer-e2e.test.ts:92-100`).

- **Zombie-on-disconnect guard.** If the peer disconnects during `await f.setup()`, the `close` handler already ran but `world.removeActor(freighter)` was a no-op: `f` was only _attached_, not yet in `world.actors`, so `removeActor`'s `indexOf` returns `<0` (`src/core/world.ts:163`). Activating after `setup` would resurrect `f` as a zombie — ticked forever, broadcast to future joiners. The guard re-checks `ws.readyState !== WebSocket.OPEN` after `setup` and calls `f.dispose(); return` instead of activating (`src/runtime/dedicated-server.ts:193-196`).

- **Close handler guards on `ws.data.freighter` being non-null.** It is `null` until `setup()` completes (`src/runtime/dedicated-server.ts:235`), so a disconnect _before_ setup never calls `removeActor`. The two guards (this one + the readyState check) together are what prevent the leak.

- **`ownerOf: () => null` on the server is deliberate.** The owner-skip optimization in `flush` (`if (ownerOf(actorId) === peerId) continue`, `src/runtime/websocket-net-driver.ts:102`) only makes sense once client-side prediction is real — the owning peer already has authoritative pos/quat locally. Until then a client is a pure proxy and needs the server's state for its _own_ freighter or it never moves. Setting `ownerOf` to a real mapping would freeze a `SimulatedProxy`-only client's own ship (`src/runtime/dedicated-server.ts:71-84`).

- **AutonomousProxy frames are NOT applied to the mesh by the driver.** `WebSocketClientDriver.apply` stashes them via `lastServerFrames` for reconcile and `continue`s (`src/runtime/websocket-client-driver.ts:90-98`). This is why `sendInput` must `applyThrust` locally — the prediction body would otherwise integrate a stale command and diverge (`src/runtime/multiplayer-client.ts:330-339`). See [client-side prediction](./client-side-prediction.md).

- **`syncPredictionFromMesh` must run after `applyInitialState` for the own freighter.** `setup()` seeds the `PredictionWorld` from a Kepler-at-current-time pose, but the server-supplied `initialState` is the truth. Without the sync, the first prediction step integrates from the seeded pose and clobbers `mesh.group` until reconcile runs (`src/runtime/multiplayer-client.ts:262-268`).

- **Static-scene actors are constructed identically and locally on every peer and are never replicated.** Only `FreighterActor` carries `replicatedProperties`; `physics`/`dock`/`phobos` carry none. `dock.freighter` tracks a single "primary" freighter for crane logic even when multiple exist — set to the most-recently-activated `Authoritative` freighter on the server (`src/runtime/dedicated-server.ts:198`, `src/runtime/sim-scene.ts:69`).

- **`crane-test` freezes the sim.** `buildStaticScene` sets `world.timeScale = 0` (`src/runtime/sim-scene.ts:45`) so nothing moves until something drives it, and `placeFreighterInCraneReach` needs a Rapier body — so it only does anything when the freighter is `Authoritative` (`src/runtime/sim-scene.ts:106-131`).

- **Node-safety via dynamic import.** `presentation-setup.ts` and the client both load every WebGPU/THREE-dependent actor module with `await import(...)` so those files never evaluate in Node. The dedicated-server imports only `buildStaticScene`/`spawnFreighter` (static, Node-safe) plus `FreighterActor`, which self-registers in the actor registry at import time.

- **Two independent server transports.** The unix-socket RPC plane and the per-peer WebSocket plane are independent; an input's `ackClientTick` may not appear in the immediately-next envelope. E2E tests drive multiple ticks for margin and buffer all WS messages via a persistent listener to avoid Bun dropping frames between discrete `receive()` awaits (`src/runtime/multiplayer-e2e.test.ts`).

## Comparison table

|                    | listen-server                                          | dedicated-server                                                              | multiplayer-client                                                |
| ------------------ | ------------------------------------------------------ | ----------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Process            | browser (`?mode≠client`)                               | headless Bun/Node, long-lived                                                 | browser (`?mode=client`)                                          |
| Entry              | `mainListenServer` (`src/runtime/listen-server.ts:18`) | `main` (`src/runtime/dedicated-server.ts:64`)                                 | `mainMultiplayerClient` (`src/runtime/multiplayer-client.ts:151`) |
| NetDriver          | `InMemoryNetDriver` (pass-through)                     | `WebSocketNetDriver` (per-peer shadow)                                        | `WebSocketClientDriver` (ingest only)                             |
| Freighter role(s)  | one `Authoritative` (`'freighter'`)                    | per-peer `Authoritative` (`'freighter-<id>'`); optional default `'freighter'` | own = `AutonomousProxy`; others = `SimulatedProxy`                |
| Sim authority      | yes (local)                                            | yes (authoritative)                                                           | none                                                              |
| Presentation       | full (`buildPresentation`)                             | none (headless)                                                               | full (inline dynamic imports)                                     |
| Gameplay transport | in-process                                             | Bun WS per peer (`:wsPort/net`)                                               | client WS to server                                               |
| Control transport  | — (none)                                               | RPC unix socket (`--sock`, agent control plane)                               | — (none)                                                          |
| Tick loop          | rAF (`world.step`)                                     | `setInterval(1000/hz)`, only when `free-running`                              | rAF (`world.step`)                                                |
| Scene helpers      | `buildSimScene`                                        | `buildStaticScene` + per-peer `spawnFreighter`                                | `buildStaticScene` + per-`Spawn` `createActor`                    |

## Porting to haystack

haystack is **Bun + Hono server + React/react-three-fiber + three.js client**, where mars is **Bun + vanilla three + Rapier + a unix-socket RPC**. The composition design ports cleanly; the transport and presentation layers diverge.

- **Keep the static/dynamic scene split.** Reuse the `buildStaticScene` (local, never-replicated `physics`/`dock`/`phobos`) vs `spawnFreighter(role)` separation verbatim — it is runtime-agnostic and the single most reusable piece. Do **not** wire presentation (camera, planet) at actor construction; do it in a post-setup step so the same actors run headless on the server.

- **Make `Role` the only actor-level topology switch.** `Authoritative` creates the Rapier body in `setup()` and is auto-registered in `activateActor`; `SimulatedProxy` creates no body and is mesh-driven; `AutonomousProxy` runs a private prediction world and is reconciled, not directly applied. The server always stamps `Authoritative`; the client computes role from `Spawn.ownerPlayerId === myPlayerId`.

- **Implement the attach/setup/activate split in your World.** This is mandatory whenever the tick loop is already running while actors join (per-peer on the server, per-`Spawn` on the client). Without it, the loop ticks half-loaded actors.

- **Reuse the join-handshake ordering exactly:** `Hello` first, then a `Spawn` per existing freighter, then the new freighter's `Spawn` directly to the owner plus a `broadcast(exclude owner)` of `Spawn` + `PeerJoined`. Encode ownership in the actor id (`freighter-<playerId>`) so the owner learns "which is mine" from the id convention alone.

- **Port both disconnect guards.** Re-check the socket is `OPEN` after `await setup()` before activating (else `dispose` + return), and guard the close handler so it only `removeActor`s when setup completed. Both are required or a disconnect-during-load leaks a ticked, broadcast ghost.

- **Set `ownerOf` to return null until prediction is real**, so the owning peer still receives its own freighter's state.

- **Transport divergence — the big one.** mars uses raw `Bun.serve` WebSocket frames with no top-level binary discriminant (text = JSON control, binary = replication envelope). In haystack with Hono, terminate the WebSocket through Hono's upgrade handler but keep the same two-channel discipline. The per-peer shadow + binary envelope logic in `WebSocketNetDriver` is transport-agnostic (the `send` callback is injected) and ports directly. See [replication](./replication.md).

- **Presentation divergence.** mars dynamic-imports imperative actor modules to stay Node-safe. In react-three-fiber the presentation is declarative React components, so the Node-safety concern dissolves differently: the headless server simply never mounts the React tree. Drive the R3F scene from the same `World` + proxy actors — the proxies' `mesh.group` transforms are what your R3F components should read. Keep the sim actors free of any R3F/JSX dependency so they run identically headless.

- **Two control planes.** mars's unix-socket RPC ([command RPC](./command-rpc.md)) is for agent/CLI control sharing a mutable `TickModeRef` with the tick loop. In haystack, fold this into Hono HTTP routes (or a separate WS) but keep it _independent_ of the gameplay plane and tolerant of arrival-order races between the two.

See also: [World & Actors](./world-and-actors.md) · [Replication](./replication.md) · [Client-side prediction](./client-side-prediction.md) · [Command RPC](./command-rpc.md) · [README](./README.md)
