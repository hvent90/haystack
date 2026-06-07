# World, the Tick Loop, and the Actor Model

> Reference implementation: **mars** (`/Users/hv/repos/mars`). Citations are `src/<path>:<line>` relative to the mars repo root. Sibling docs: [replication](./replication.md) · [client-side prediction](./client-side-prediction.md) · [command & RPC](./command-rpc.md) · [runtime topologies](./runtime-topologies.md) · [index](./README.md).

## Purpose

`World` is the simulation plane: a runtime-agnostic container that owns the fixed-step tick loop, the flat actor list, and the three.js scene-graph root. It holds **no renderer, no canvas, no DOM** (`src/core/world.ts:16-21`). Everything that simulates is an `Actor` attached to the world; everything that draws (the browser `RenderSystem`) or transports state (the `NetDriver`) sits _outside_ the world and consumes it. This is the layer a haystack port must get exactly right before replication, prediction, or rendering can be reasoned about — the ordering rules here are load-bearing for all of them.

## Mental model

One `World` instance. It advances time in fixed `1/60 s` slices. Each slice (`tick()`) runs in a strict, non-negotiable order: pull inbound network state in, walk actors group-by-group calling `update(dt)`, push outbound network state out, then bump counters and fire listeners. Real-time front-ends (`step(wallDt)`) wrap `tick()` in a capped accumulator so wall-clock jitter never leaks into the simulation.

```
                       ┌─────────────────────── World ───────────────────────┐
   RenderSystem.rAF    │  simTime / timeScale / frame / currentTick           │
   ───────────────►    │  sceneRoot: THREE.Group   localFrameOrigin: Vector3  │
   step(wallDt)        │  mainCamera: PerspectiveCamera | null                │
        │              │  actors: Actor[]    actorUpdateMs: number[]          │
        │ drains       │  netDriver: NetDriver | null                         │
        ▼ accumulator  └──────────────────────────────────────────────────────┘
   tick() ─┬─ netDriver.apply()                         ◄── inbound (TOP)
           ├─ for group in [PrePhysics,Physics,          ◄── update(dt), in
           │      PostPhysics,PostUpdateWork]:               registration order
           │      for actor where actor.tickGroup==group:    within each group
           │          actor.update(dt)
           ├─ netDriver.collect(authoritative) + flush() ◄── outbound (BOTTOM)
           └─ frame++; currentTick++; onTick listeners   ◄── post-increment
```

Two orthogonal axes classify each actor:

- **`tickGroup`** — _when_ in the frame it runs (`PrePhysics → Physics → PostPhysics → PostUpdateWork`).
- **`role`** — _what_ authority it has (`Authoritative` / `SimulatedProxy` / `AutonomousProxy`).

`World` iterates by tick group; it only consults `role` at the two network boundaries. The tick group comment states the principle directly: "group says WHEN, role says WHAT" (`src/core/tick-group.ts:2-3`).

## Key types & APIs

### World

```ts
// src/core/world.ts:22-65
export class World {
  readonly fixedDt = 1 / 60;
  simTime = 0; // universal sim time (s), advanced once per tick
  timeScale = 1; // 1 = realtime, 0 = paused
  // frame and currentTick advance in lockstep (both ++ at tick bottom) and
  // currently hold identical values; the semantic distinction between them is
  // deferred to the Invariants section.
  frame = 0; // monotonic tick count since world start
  currentTick = 0; // monotonic tick counter, ++ at end of tick()

  readonly localFrameOrigin = new THREE.Vector3(); // floating-origin anchor
  readonly sceneRoot = new THREE.Group(); // every actor.object3D parents here
  mainCamera: THREE.PerspectiveCamera | null = null;

  actors: Actor[] = [];
  actorUpdateMs: number[] = []; // per-actor EMA update time, index-parallel to actors[]

  possessedActor: Actor | null = null;
  netDriver: NetDriver | null = null;
}
```

```ts
// Lifecycle — src/core/world.ts:119-177
addActor<T extends Actor>(actor: T): T          // attach + activate (synchronous case)
attachActor<T extends Actor>(actor: T): T       // wire in, do NOT tick
activateActor<T extends Actor>(actor: T): T     // push to tick list + net-register
removeActor(actor: Actor): void                 // full teardown (mirrors AActor::Destroy)
async setupActors(): Promise<void>              // await each actor.setup() in order
```

```ts
// Loop — src/core/world.ts:195-244
tick(): void                 // one fixed step, strict order (see below)
step(wallDt: number): number // accumulator front-end; returns ticks consumed
```

```ts
// Listeners — onTick/onActorAdded/onActorRemoved/onPossession share the
// add/remove-by-filter disposer pattern (each returns an unsubscribe fn):
// src/core/world.ts:35, 70, 77, 97
onTick(cb: () => void): () => void
onActorAdded(cb: (a: Actor) => void): () => void
onActorRemoved(cb: (a: Actor) => void): () => void
onPossession(cb: (a: Actor | null) => void): () => void
// setPossessedActor is NOT a subscribe method — it is a change-detecting
// setter that early-returns if unchanged, else notifies. It returns no disposer.
// src/core/world.ts:104
setPossessedActor(actor: Actor | null): void
```

Render constants live on the World module but the World does nothing with them — `RenderSystem` owns the actual camera layer mask and per-pass selection (`src/core/world.ts:7-14`):

```ts
export const LAYER_NEAR = 0;
export const LAYER_FAR = 1;
```

### TickGroup

```ts
// src/core/tick-group.ts:15-45
export enum TickGroup {
  PrePhysics = 0, // default; reserved for work feeding physics. No actor uses it today.
  Physics = 1, // the physics step. Exactly one actor: PhysicsActor.
  PostPhysics = 2, // read back physics, run cosmetic/proxy dynamics. dock, phobos, freighter.
  PostUpdateWork = 3, // presentation: camera, HUD, planet, post-processing. Ticks LAST.
}

export const TICK_GROUP_ORDER: readonly TickGroup[] = [
  TickGroup.PrePhysics,
  TickGroup.Physics,
  TickGroup.PostPhysics,
  TickGroup.PostUpdateWork,
];
```

`World.tick()` iterates `TICK_GROUP_ORDER` explicitly rather than reflecting over the enum (`src/core/world.ts:204`). `PostUpdateWork` ticking last is what fixes camera lag: the camera reads the freighter's _final_ pose for the frame instead of a pose from the previous tick (`src/core/tick-group.ts:30-35`).

### Role

```ts
// src/core/role.ts:8-12
export enum Role {
  Authoritative = "authoritative",
  SimulatedProxy = "simulated-proxy",
  AutonomousProxy = "autonomous-proxy",
}
```

Default is `Authoritative` (`src/core/actor.ts:28`). A single-process listen-server leaves _every_ actor authoritative, which is why pre-replication code paths are unchanged. `World` only branches on role at net boundaries — register and collect are restricted to `Role.Authoritative` (`src/core/world.ts:149, 218`).

### Actor

```ts
// src/core/actor.ts:8-79
export abstract class Actor<TState = unknown> {
  object3D: THREE.Object3D = new THREE.Group(); // empty Group by default; compose children in
  world!: World; // back-ref, assigned by attachActor — NOT the ctor
  abstract readonly id: string; // stable, globally-unique; enforced at attach

  role: Role = Role.Authoritative;
  tickGroup: TickGroup = TickGroup.PrePhysics;

  // STATIC, per-class manifests — reached via actor.constructor, not the instance:
  static readonly replicatedProperties: readonly ReplicatedField[] = []; // NetDriver reads this
  static readonly callable: readonly string[] = []; // RPC 'call' allowlist

  abstract setup(): void | Promise<void>; // async-capable build phase
  abstract update(dt: number): void; // called each tick in this actor's group

  state(): TState | undefined {
    return undefined;
  } // inspection / snapshot surface
  getTargetEntry(): TargetEntry | null {
    return null;
  } // camera-target panel opt-in
  dispose(): void {}
}
```

### Actor registry

```ts
// src/core/actor-registry.ts:20-52
export type ActorFactory = (id: string) => Actor;
export function registerActorClass(className: string, factory: ActorFactory): void;
export function createActor(className: string, id: string): Actor;
export function knownClasses(): readonly string[];
export function resetActorRegistry(): void; // test-only
```

A module-global `Map<string, ActorFactory>` keyed by constructor name (`src/core/actor-registry.ts:22`). Wire `Spawn` messages carry a `className` string; the receiving peer resolves it through `createActor`. Re-registering the **same** factory reference is a silent no-op (HMR / double-import safe); a **different** factory for an existing name throws (`src/core/actor-registry.ts:25-34`). `createActor` on a missing name throws _"unknown class '<name>'. Did you import the module that registers it?"_ — the actor module's import side-effect is the registration trigger (`src/core/actor-registry.ts:37-42`).

## Data-flow walkthrough

### A. One `tick()`, end to end

Verbatim order from `src/core/world.ts:195-226`:

1. `const dt = this.fixedDt * this.timeScale; this.simTime += dt` (`:196-197`). `timeScale` scales _simulated_ time, not the number of ticks.
2. **`netDriver.apply()` at the TOP** (`:202`) — inbound replication is pushed onto receivers _before_ any `update(dt)` runs, so an `AutonomousProxy` reconciles against the freshest server frame, and a `SimulatedProxy` has the latest pose written onto its `object3D` before its own update reads it.
3. For each `group` in `TICK_GROUP_ORDER`, loop `actors[]` in registration order; skip any actor whose `tickGroup !== group`; otherwise bracket `actor.update(dt)` with `performance.now()` and fold the elapsed ms into `actorUpdateMs[i]` as an EMA with `alpha = 0.1` (`:204-213`).
4. **`netDriver.collect(auth)` then `netDriver.flush()` at the BOTTOM** (`:217-221`), where `auth = this.actors.filter(a => a.role === Role.Authoritative)`. Outbound deltas reflect this tick's final, post-everything authoritative state.
5. `this.frame++; this.currentTick++` (`:223-224`), **then** fire every `onTick` listener (`:225`). Listeners observe the _post-increment_ value — `world.test.ts` asserts `onTick` sees `[1, 2]`, not `[0, 1]` (`src/core/world.test.ts:20`).

### B. Real-time front-end: `step(wallDt)`

```ts
// src/core/world.ts:234-244
step(wallDt: number): number {
  this.accumulator += wallDt
  let steps = 0
  while (this.accumulator >= this.fixedDt) {
    this.tick()
    this.accumulator -= this.fixedDt
    steps++
    if (steps >= 8) { this.accumulator = 0; break }  // spiral-of-death cap
  }
  return steps
}
```

`RenderSystem`'s rAF loop computes `wallDt = min((now - lastWall) / 1000, 0.1)` then calls `world.step(wallDt)`; after `step` returns it renders `world.sceneRoot` through `world.mainCamera` in the **same** animation frame (`src/render/render-system.ts:46-61`). So a pose applied at tick TOP (step 2 above) is on screen after `step()` returns that same rAF frame.

Headless/Node drives `tick()` directly for determinism; nobody draws `sceneRoot`. `snapshot(world)` then serializes the world to a JSON-safe `StateSnapshot` for assertions (`src/verification/state-snapshot.ts:25-45`).

### C. Boot sequence (where actors come from)

1. An entry point constructs `new World()` and optionally assigns `world.netDriver`.
2. Scene builders call `world.addActor(...)` for static actors — physics, dock, phobos, camera, planet, HUD, post-processing — each attaching then activating immediately.
3. `await world.setupActors()` runs each `actor.setup()` in registration order (`src/core/world.ts:175-177`). The camera actor claims `world.mainCamera` during its `setup()`; downstream actors that depend on it validate it is set.
4. A real-time driver begins calling `world.step(wallDt)` (browser) or free-running `world.tick()` (headless dedicated server).

### D. The attach → setup → activate split (the async-setup race)

The dedicated server's per-connection freighter is the canonical case. The freighter loads an FBX asynchronously, so ticking it before `setup()` resolves would call `update()` on empty bones and crash. The split prevents this (`src/runtime/dedicated-server.ts:171-200`):

```ts
const f = new FreighterActor(freighterId);
f.role = Role.Authoritative;
f.physics = stat.physics;
world.attachActor(f); // scene graph + world ref + id check — NOT ticking yet
ws.data.freighter = f;
try {
  await f.setup();
} catch (e) {
  // async build (FBX load)
  /* close socket, bail */
}
if (ws.readyState !== WebSocket.OPEN) {
  // peer left during setup?
  f.dispose();
  return; // skip activate → no zombie actor
}
world.activateActor(f); // now it ticks + (auth ⇒) net-registers
```

`attachActor` wires the world ref, adds `object3D` to `sceneRoot`, and enforces id uniqueness — but does **not** push into `actors[]` and does **not** net-register (`src/core/world.ts:131-143`). `activateActor` pushes into `actors[]` + a parallel `0` into `actorUpdateMs[]`, net-registers only if `netDriver && role === Role.Authoritative`, and fires `onActorAdded` (`src/core/world.ts:146-154`). The multiplayer client follows the identical attach → `await setup()` → activate shape for incoming spawns (`src/runtime/multiplayer-client.ts:253-270`).

### E. Spawn through the registry

`FreighterActor` self-registers at module import time (`src/actors/freighter/freighter-actor.ts:1367`):

```ts
registerActorClass("FreighterActor", (id) => new FreighterActor(id));
```

On the client, a `SpawnMessage` carrying `{ className, actorId, ... }` is resolved via `createActor(msg.className, msg.actorId)` (`src/runtime/multiplayer-client.ts:248`). The caller then sets authority **after** construction — `actor.role = isOwn ? AutonomousProxy : SimulatedProxy` — _before_ `activateActor`, because activation's net-registration branches on `role === Authoritative`. See [client-side prediction](./client-side-prediction.md) and [replication](./replication.md) for what happens next.

### F. RPC `call` consults the static `callable` manifest

The `call` verb is the sole consumer of `Actor.callable` (`src/core/rpc-verbs.ts:73-93`):

```ts
const ctor = actor.constructor as typeof Actor;
if (!ctor.callable.includes(method)) {
  throw new RPCError(`${actorId}.${method} not in callable allowlist`, "METHOD_NOT_CALLABLE");
}
```

`FreighterActor` declares `static override readonly callable = ['applyThrust']` (`src/actors/freighter/freighter-actor.ts:209`). See [command & RPC](./command-rpc.md).

## Concrete actor examples

**`PhysicsActor`** — minimal infrastructure actor, overrides `tickGroup = TickGroup.Physics`, async `setup()` (`src/actors/physics/physics-actor.ts:24-58`):

```ts
override tickGroup = TickGroup.Physics
constructor(id = 'physics') { super(); this.id = id }

async setup(): Promise<void> {
  await RAPIER.init()                                  // WASM must init before any Rapier API
  this.physicsWorld = new RAPIER.World({ x: 0, y: 0, z: 0 })  // zero gravity
  this.physicsWorld.timestep = this.fixedDt           // 1/60
  this.physicsWorld.numSolverIterations = 8
}
update(_dt: number): void { this.physicsWorld.step() }  // ignores dt; uses fixed Rapier timestep
override dispose(): void { this.physicsWorld.free() }
```

It leaves `state()` and `getTargetEntry()` at their defaults — pure infrastructure, off the inspection and camera-target surfaces.

**`PhobosActor`** — replicated actor, `tickGroup = TickGroup.PostPhysics`, two replicated fields with **no** `set` (`src/actors/phobos/phobos-actor.ts:28-43`):

```ts
static override readonly replicatedProperties: readonly ReplicatedField[] = [
  { name: 'pos',  type: 'vec3', get: (a: any) => (a as PhobosActor).object3D.position },
  { name: 'quat', type: 'quat', get: (a: any) => (a as PhobosActor).object3D.quaternion },
]
override tickGroup = TickGroup.PostPhysics
```

Because the fields carry no custom `set`, the NetDriver's default writer applies received values via `.set(...)` on the live `object3D.position` / `object3D.quaternion`.

> **Do not generalize phobos to the freighter.** `PhobosActor` is a clean two-field, no-`set` example. The actor that actually _moves_ under replication and prediction is `FreighterActor`, which declares **eleven** replicated properties (`src/actors/freighter/freighter-actor.ts:144-207`): `pos`/`quat`/`linVel`/`angVel` (vec3/quat, no `set` → default writer, like phobos) **plus** seven command scalars (`mainThrottle`, `strafeX/Y/ZCmd`, `pitch/yaw/rollCmd`) that _do_ carry a custom `set` writing onto `command.*`. The freighter mixes both writer paths in one manifest. See [replication](./replication.md) for the field/writer mechanics.

## Invariants & gotchas

- **`fixedDt = 1/60` is hardcoded.** Determinism depends on every tick advancing exactly `fixedDt * timeScale`. Never feed raw wall time into the simulation (`src/core/world.ts:23, 196`).
- **Counter ordering: `frame++`/`currentTick++` happen _before_ `onTick` fires** (`src/core/world.ts:223-225`), so listeners and snapshot frames observe the post-increment value (`world.test.ts:20` → `[1, 2]`). Both counters increment together every tick; they hold identical values today but are semantically distinct fields. `currentTick` is treated as the canonical tick id by net code; `frame` is mainly read by `snapshot()`.
- **`step()` caps at 8 ticks and, on hitting the cap, zeroes the accumulator** (`src/core/world.ts:241`) — silently discarding remaining sim time to prevent a spiral of death. Under a heavy stall, simulation time is dropped, not deferred.
- **`timeScale` does not change how many ticks `step()` runs.** `step()` consumes raw `wallDt` regardless; `timeScale` only scales `simTime` inside `tick()` (`timeScale = 0` pauses sim advance but `step` still loops). `RenderSystem` additionally clamps `wallDt ≤ 0.1 s` before calling `step` (`src/render/render-system.ts:50`).
- **Tick groups gate WHEN, Role gates WHAT.** `World` no longer branches on role inside the group loop — each actor's `update()` handles auth vs proxy internally. `World` uses `Role` only at net boundaries: `register` (`:149`) and `collect` (`:218`) are restricted to `Authoritative`.
- **Within a tick group, actors run in registration (`actors[]` insertion) order.** The order of `addActor`/`activateActor` calls is load-bearing for same-group actors.
- **`PrePhysics` (the default `tickGroup`) is unused by any actor.** It exists so a newly-added actor doesn't accidentally land in the presentation (`PostUpdateWork`) slot (`src/core/tick-group.ts:16-20`). Today: `Physics` = `PhysicsActor` only; `PostPhysics` = dock, phobos, freighter; `PostUpdateWork` = camera, HUD, planet, post-processing.
- **NetDriver order is strict: `apply()` TOP, `collect()`+`flush()` BOTTOM.** `apply` is unconditional; `collect` receives only the authoritative-filtered subset (`src/core/world.ts:202, 217-221`).
- **`attach` vs `activate` split exists for async `setup()`.** Attach wires the scene graph + id uniqueness without ticking; you `await setup()`; then activate to begin ticking. The dedicated server also guards against the disconnect-during-setup race by disposing and skipping activate (`src/runtime/dedicated-server.ts:193-199`).
- **`world` is definite-assignment (`world!: World`) and null until `attachActor` runs.** Constructors (and registry factories) must **not** read `this.world`, and must **not** assume `role` — role is set by the caller after construction (`src/core/actor.ts:10`, `src/core/actor-registry.ts:15-18`).
- **`object3D` is captured by reference at attach time; mutate in place, never reassign.** `attachActor` does `sceneRoot.add(actor.object3D)` and `removeActor` does `sceneRoot.remove(actor.object3D)`. Reassigning `object3D` after attach desyncs the scene graph — the old Group stays parented, the new one is never added (`src/core/world.ts:141, 167`).
- **The two manifests are STATIC and per-class**, reached via `actor.constructor as typeof Actor`, not via the instance (`src/core/rpc-verbs.ts:82`). A method is RPC-callable only if its name is in `callable` _and_ it resolves to a function.
- **Duplicate-id check scans `actors[]`, which `attachActor` itself does not populate** (`src/core/world.ts:135-139`). Uniqueness is therefore enforced against already-_activated_ actors. An empty/falsy id throws _"has no id"_.
- **`actorUpdateMs` is index-parallel to `actors[]`** and spliced in lockstep on `removeActor` (`src/core/world.ts:165-166`). Any code that reorders `actors[]` must reorder `actorUpdateMs[]` too.
- **`removeActor(absent)` is a no-op** (`idx < 0` early return, `src/core/world.ts:163-164`). Full teardown otherwise: splice both arrays, detach `object3D`, unregister from netDriver, clear possession via `setPossessedActor(null)` if it pointed here, fire `onActorRemoved`, then `actor.dispose()`.
- **`localFrameOrigin` is mutated each tick by the dock actor (PostPhysics)** to its Kepler position; the planet is drawn at `-localFrameOrigin` so near-station geometry keeps float precision. `snapshot()` copies it component-wise (`x`/`y`/`z`), not by reference (`src/verification/state-snapshot.ts:37-41`).
- **`mainCamera` starts null and is claimed by the camera actor during its `setup()`.** Consumers must null-check (`RenderSystem` skips render if `!cam`, `src/render/render-system.ts:54-55`). Register the camera actor before anything that depends on it.
- **`snapshot()` key sets can differ:** `actors` includes only actors whose `state() !== undefined`, but `actorTimings` includes _all_ actors (`src/verification/state-snapshot.ts:28-33`).
- **`world.netDriver` may be null.** The headless one-shot path runs the tick loop cleanly with no driver (`src/core/world.ts:202, 217` both guard on `if (this.netDriver)`).
- **`onTick`-driven `setTick` lags the state it carries by one tick.** The dedicated server wires `world.onTick(() => driver.setTick(world.currentTick))` (`src/runtime/dedicated-server.ts:86`), which fires at tick _bottom_ — after `flush()`. So the envelope packed during the _next_ tick's flush carries the previous tick's `currentTick` in its header. This is a deliberate one-tick header/state offset, documented in [replication](./replication.md); the net-driver prose calling `apply` "top of each tick" is loose wording — the wiring makes it bottom.

## Porting to haystack

haystack is Bun + Hono + React/react-three-fiber + three.js; mars is Bun + vanilla three + Rapier + a unix-socket RPC. The simulation plane ports almost verbatim — keep it free of React and the renderer.

**Reuse essentially unchanged:**

- `World` with `fixedDt = 1/60`, `simTime += fixedDt * timeScale` exactly once per `tick()`, and the **exact** `tick()` order: `apply()` → tick groups in `TICK_GROUP_ORDER` → `collect(auth)` + `flush()` → `frame++`/`currentTick++` → `onTick`. Listeners must observe the post-increment counter.
- `step()` as a clamped accumulator with the **`8`-tick cap and accumulator-zeroing on overflow** — both values are deliberate.
- `TickGroup` as an explicit enum ordered `PrePhysics(0) < Physics(1) < PostPhysics(2) < PostUpdateWork(3)`, iterated via an explicit order array (not enum reflection). Default `tickGroup = PrePhysics`, `role = Authoritative`.
- The three-step lifecycle: `attach` (world ref + `sceneRoot.add` + non-empty + globally-unique id, no ticking), `setup` (async-capable build), `activate` (push to `actors[]` + parallel timing slot, net-register iff `netDriver && role === Authoritative`, fire added-listeners). `addActor = attach + activate` for the synchronous case. The split is **required** for async-loading actors (model loads, WASM init) so a half-built actor is never ticked.
- The string-keyed `registerActorClass` / `createActor` registry, populated as an import side-effect; same-factory re-register = no-op, different-factory = throw; test-only reset.
- `snapshot(world)` as a pure `{ frame, simTime, localFrameOrigin {x,y,z}, actors (state()≠undefined), actorTimings (all) }`, copying `localFrameOrigin` component-wise.
- Both manifests **static** so netcode/RPC introspect a class without an instance; default both to empty arrays.

**Adapt for the haystack stack:**

- **Renderer.** mars's `RenderSystem` wraps a `THREE.Scene` around `sceneRoot` and drives the rAF loop imperatively (`src/render/render-system.ts:37-52`). In react-three-fiber the render loop is R3F's `useFrame`. Wire one top-level component that holds the `World`, calls `world.step(delta)` in a single `useFrame` callback (the _only_ place that drives the sim), and mounts `world.sceneRoot` into the R3F scene (e.g. via a `<primitive object={world.sceneRoot} />`). Keep `World` itself ignorant of React: it still owns only a `THREE.Group` and a nullable `mainCamera`, never a renderer or DOM. Drive the camera from `world.mainCamera` rather than R3F's default camera, or have the camera actor write into the R3F camera.
- **Server/transport.** mars's dedicated server free-runs `world.tick()` and ships state over WebSocket / unix-socket RPC. haystack is Hono — run the authoritative `World` server-side under a fixed-interval timer driving `tick()` directly (deterministic), and expose replication over Hono's WebSocket upgrade. The `NetDriver` interface (`register`/`unregister`/`collect`/`flush`/`apply` + `lastFlush`, `src/core/net-driver.ts:16-40`) is transport-agnostic and ports as-is; only the concrete driver changes. See [runtime topologies](./runtime-topologies.md).
- **`netDriver` may be null** for one-shot headless runs and tests; keep both guard sites (`if (this.netDriver)` around apply, and around collect+flush).
- **`removeActor`** must mirror `activate` in reverse plus possession-clearing and `dispose()`: splice both arrays by the same index, detach `object3D`, unregister from netDriver, null possession via the change-detecting setter if it pointed here, fire removed-listeners, then `dispose()`. Guard the absent case (`index < 0` → no-op).
- **`LAYER_*` constants** can stay on the World module as shared constants, but the actual camera layer mask and any post-processing live in the R3F render layer, not the World — same separation mars keeps.
