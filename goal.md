# Goal: Persistent Multiplayer Space Mining Game

Build the app end to end, using verifiers throughout the work, until the repository contains a functional persistent multiplayer space game prototype with a client/server architecture, stateful CLI client, automated integration coverage, and screenshot-based visual verification.

## Source Of Truth

This file is the current contract for the `/goal` loop. Re-read it before each implementation pass and keep the work aligned to this document unless the user explicitly replaces it with a newer source of truth.

## Required Stack And Standards

- Runtime/package manager: Bun.
- Language: TypeScript only. Do not add JavaScript files.
- Type safety: full TypeScript strictness.
- Formatting: `oxfmt`.
- Server: Hono.
- Persistence: SQLite.
- Tests: end-to-end integration tests covering real client/server behavior.
- Rendering: Three.js with React Three Fiber.
- App model: client/server architecture, not a single in-memory browser toy.
- Development server: host the app on a hot reload dev server. Prefer exposing it through a Cloudflare Tunnel so the user can periodically inspect progress from a public URL; fall back to a LAN-bound URL if tunnel access is unavailable.
- Multiplayer-first development: from the first playable vertical slice, the hosted dev build must support at least two real remote users joining the same shared space at the same time.
- CLI: provide a stateful CLI client that can drive the app, inspect state, and export verification screenshots.
- Screenshots: any screenshot used for verification must be at least 1080p.

## Product Objective

Create a persistent multiplayer game set in a single shared networked space world. The player pilots a ship through asteroid belts and related deep-space locations, primarily mining, hauling, scanning, hiding, discovering, and returning to stations or bases.

Multiplayer is not a late feature. The earliest playable build should already let the user and a friend connect to the same hosted world, see each other in the same shared space, and exercise the available game loop together.

The core design loop is "needle in a haystack" gameplay across multiple orders of magnitude:

- Close scale: comb over an asteroid surface to find a specific mineral deposit.
- Belt scale: glide between asteroids while pulsing scanners to find a specific asteroid, hidden structure, player, comm relay, signal, or bounty target.
- Region scale: zoom out to choose which pocket of a massive asteroid belt to investigate.
- Logistics scale: travel between stations, hidden forward bases, habitats, and remote operating locations.
- Social scale: discover, avoid, cooperate with, or hunt other players and organizations.

## Game Requirements

- The world must be persistent across server restarts.
- The world must support multiplayer clients connected to one persistent shared state.
- Two real remote players must be able to join the hosted dev build simultaneously from the start of playable development.
- Players must be able to see enough of each other's presence, position, movement, chat, and shared-world effects to evaluate the multiplayer experience during each iteration.
- The player controls a ship in zero gravity with no default flight assist.
- Temporary stabilization or assisted control may exist, but it must have a cost such as heat generation.
- Ship systems should be upgradeable so players can make longer and deeper expeditions into the belt.
- Scanning must exist at multiple scales and support the "needle in a haystack" loop for resources, players, structures, comms, relays, hidden bases, navigation, and lost/found gameplay.
- Mining and hauling must be functional enough to create a loop: find resource, mine or collect it, store it, move it, and sell or deposit it.
- Include global chat.
- Include chat channels and direct messages.
- Include character cards.
- Include player organizations.
- Include at least one station outside or at the edge of the belt that functions as a return point.
- Include hidden lightweight bases or habitats that players can place and try to keep hidden.
- Use a "mid-scifi" aesthetic: grounded enough to feel constrained by real-world physics and engineering, but stylized enough for ships and stations to have identity.
- Use low-poly dev-art with basic blocky silhouettes, clear affordances, and simple moving parts. Prioritize functional readability over polish.

## UI Requirements

> **Authoritative UI contract:** the full, verifiable functional requirements for the EVE-Online-style
> interface — including the in/out-of-scope ledger, the current-state gap analysis, the `data-testid`
> convention, and the end-to-end verification/testing plan — live in
> [`docs/eve-ui-functional-requirements.md`](docs/eve-ui-functional-requirements.md). The current
> `src/client/App.tsx` UI does not meet that contract; treat that document as the source of truth for the
> UI rewrite and its verification. Scope decisions baked in: keep manual zero-g Newtonian flight (EVE's
> navigation/targeting model is out of scope), adopt EVE's window/chrome UX over the existing core feature
> windows only, and make every visual requirement assertable in e2e.

- Build an EVE Online style interface with floating windows.
- Windows should be movable and resizable.
- Add docking behavior when practical, but prioritize stable, usable floating/resizable windows first.
- UI should expose essential ship, scanner, cargo, chat, map, character, organization, and station/base interactions.
- The first screen should be the usable game experience, not a marketing page.

## Scale And Simulation Requirements

- Design the asteroid system to plausibly support millions of asteroids.
- Use instanced meshes and spatial partitioning where appropriate.
- Use floating origin rebasing if large world coordinates require it.
- Use cubic quadtrees or another appropriate spatial indexing strategy if needed.
- Be careful with ECS. Do not force the entire app into ECS by default.
- Prefer traditional actors/controllers for players, ships, sessions, and other entity types that need identity and imperative control.
- For massively parallel systems such as asteroid fields, consider focused data-oriented design instead of global ECS architecture.

## Suggested Architecture Direction

- Treat `docs/engine/README.md` and the sibling `docs/engine/*.md` files as the reference architecture for the real-time engine port, with Haystack-specific adaptations in those docs taking precedence over Mars-specific transport details.
- Treat `docs/flight-controls.md` as the design contract for the keyboard/mouse, Elite-Dangerous-style flight model: it defines the control expectations, the Flight-Assist-as-heat-costed-Stabilizer inversion required by the zero-g/no-default-assist rule, the default KB/M bind map, the multi-scale travel/cruise tier, and the prioritized work to add ship orientation, continuous predicted input, and an orientation-following camera. Honor it when implementing or revising ship piloting.
- Server owns authoritative world state, persistence, multiplayer sessions, chat, scanning, mining, inventory, economy, bases, and organizations.
- Move toward an authoritative in-memory `World` seeded from SQLite, advanced by a fixed-step server loop, with SQLite used for durable seed/state persistence rather than per-request simulation as the long-term source of truth.
- Keep the simulation plane runtime-agnostic: plain sim actors/classes own state, ticking, roles, replication manifests, and three.js objects; React Three Fiber renders from that state and should not be the authoritative simulation model.
- Preserve the core engine ordering from the docs: apply inbound replication at tick top, tick actors in ordered groups, collect/flush outbound replication at tick bottom, then advance frame counters/listeners.
- Use explicit actor roles for authority and client behavior: server-owned authoritative actors, remote simulated proxies, and owned autonomous proxies when client-side prediction is implemented.
- For networked multiplayer replication, `collect()` captures current authoritative state once per tick, and `flush()` diffs that capture against one shadow per peer, advances each peer's shadow after computing that peer's delta, and sends only the needed delta. Do not replace this with a single global shadow for all peers.
- Prefer WebSocket replication/input over polling for real-time play. Keep text frames or typed JSON messages for low-frequency control/input and binary or typed delta envelopes for high-frequency replicated state when that split becomes useful.
- Implement client-side prediction and reconciliation for the owned ship once movement latency matters: stamp inputs with a client prediction tick, echo acknowledgements from the server, stash authoritative frames for the owned actor, and replay unacknowledged inputs after correction.
- Browser client renders the game, drives input, and displays the EVE-style UI.
- During development, keep the browser client and server reachable through a hot reload dev server. Prefer a Cloudflare Tunnel public URL, fall back to a LAN-accessible URL if needed, and report the active URL after starting or changing it.
- Treat the hosted dev server as a shared playtest environment for at least two human players, not just a solo preview.
- CLI client talks to the same server APIs/protocol as the browser client and can:
  - create or select a player,
  - connect to a world,
  - move or simulate a ship,
  - trigger scanning,
  - inspect cargo/resources/world state,
  - send chat messages,
  - create or inspect bases,
  - export screenshots for verification.
- Prefer the CLI operating as a normal public client over a privileged command plane. If privileged/admin-only control is added, it must have an explicit need, be separately scoped, and not replace verification through the same public paths available to browser clients.
- Keep protocol boundaries explicit and typed.
- Keep deterministic or seeded generation for large asteroid fields so scale does not require eagerly storing every asteroid row.
- Persist only durable player/world changes and enough generation metadata to reconstruct large-scale fields.
- Do not add a privileged command/control plane by default. The Mars command-RPC docs are useful as reference for verification and tick control, but Haystack's CLI should remain a public client unless an explicit requirement justifies an admin-only channel.

## Verification Requirements

Use verifiers throughout the work, not only at the end. At minimum:

- Run TypeScript checks after meaningful implementation slices.
- Run formatter checks with `oxfmt`.
- Run unit or integration tests for server behavior and persistence.
- Run end-to-end integration tests against the real server/client path.
- Start or refresh the hot reload dev server during implementation passes and report the Cloudflare Tunnel public URL when available, otherwise report the LAN URL.
- Verify the public or LAN-hosted dev build supports two simultaneous clients in the same shared space before claiming multiplayer-facing slices are done.
- Use the CLI client to drive real app state.
- Verify important gameplay flows through the same public client/server APIs or WebSocket protocols that normal players use; do not rely only on privileged test hooks.
- Export at least one 1080p or larger screenshot from a real app state for visual verification.
- Verify persistence by restarting the server or re-opening storage and proving durable state remains.
- Verify multiplayer by exercising at least two clients or simulated sessions in one shared world.
- Verify scale strategy with a test or diagnostic that proves large asteroid counts are generated, indexed, queried, and rendered/represented without eagerly materializing an impractical number of objects.

## Completion Criteria

Do not call the goal complete until all of the following are true:

- The repo runs with Bun using documented commands.
- The app can be served through a Bun-compatible hot reload dev server, with a Cloudflare Tunnel public URL preferred and a LAN URL fallback documented or reported.
- The hosted dev build supports the user and a friend joining the same shared world simultaneously and seeing each other's presence and movement.
- The implementation is TypeScript-only and passes strict type checking.
- Formatting passes with `oxfmt`.
- Hono server is present and owns authoritative persistent state.
- SQLite persistence is present and verified.
- The real-time engine follows the documented fixed-step authoritative `World`/actor/replication architecture or has a clear, verified staged migration toward it.
- Browser client renders the playable space scene with React Three Fiber and Three.js.
- The player can pilot a ship with zero-g controls and use stabilization at a cost.
- The player can scan, find, mine/collect, haul, and deposit or sell at least one resource.
- The game includes a station, an asteroid belt, at least one hidden-placeable base or habitat, global chat, channels or DMs, character cards, and player organizations.
- A stateful CLI client can drive the app and export at least one 1080p verification screenshot.
- E2E integration tests cover core client/server flows.
- Verification evidence is captured in the final report, including commands run and screenshot paths.

## Working Rules For The Agent

- Start by auditing the existing repository and identifying the current app shape before coding.
- Keep each implementation pass scoped and verifiable.
- Build multiplayer presence, shared-state synchronization, and a hosted two-player playtest path in the first playable vertical slice.
- Keep the CLI on the same public client protocol as the browser unless an explicit requirement justifies a separate privileged control plane.
- Prefer durable, typed interfaces and tests over one-off demo code.
- If the existing implementation conflicts with this goal, update it toward this contract rather than preserving accidental architecture.
- If a requirement is too large for one pass, implement the smallest real vertical slice that honors the architecture and proves the path end to end.
- Record any intentionally deferred work clearly in the final report, but do not hide missing completion criteria.
