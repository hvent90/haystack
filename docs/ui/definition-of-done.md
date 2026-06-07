# EVE UI Definition Of Done

This checklist maps the P0 floor from `docs/eve-ui-functional-requirements.md` to concrete verification.

| Capability                | Required evidence                                                                                                                                  |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| First paint is the game   | `bun run verify:screenshot` reaches `haystack-app` and nonblank `world-canvas` without login or marketing UI.                                      |
| Six canonical windows     | `bun run verify:ui` finds `flight`, `scanner`, `cargo`, `comms`, `character`, and `bases` windows plus exactly six Neocom toggles.                 |
| Window manager floor      | `bun run verify:ui` exercises close/reopen, minimize/restore, drag, resize handles, z-focus, and per-pilot layout persistence/reset.               |
| Overview table            | `bun run verify:ui` checks table headers, default distance sort, filters, row identity attributes, single-click selection, and Selected Item sync. |
| Navigation ban            | `bun run verify:ui` captures websocket frames and verifies selection, double-click, and waypoint actions do not emit ship-motion input.            |
| Flight controls preserved | `bun run verify:multiplayer` passes, and `bun run verify:ui` verifies HUD thrust/stabilize controls plus current flight-mode/throttle telemetry.   |
| Cargo loop                | `bun run verify:ui` verifies cargo capacity display, empty state, selected-deposit mining controls when discovered, and sell control wiring.       |
| Comms + Local             | `bun run verify:ui` verifies channel tabs, log/input controls, and local pilot count/list.                                                         |
| Bases + upgrades          | `bun run verify:ui` verifies discovered structures, deploy/index controls, and the four upgrade controls inside Bases, with no Upgrades window.    |
| Visual floor              | `bun run verify:ui` audits dark translucent window bodies/titlebars, full-viewport canvas, non-interactive reticle, and no light form surfaces.    |
| Mobile sanity             | `bun run verify:screenshot` keeps the mobile canvas nonblank and captures a mobile screenshot.                                                     |

The branch is not complete until `bun run verify`, `bun run verify:screenshot`, `bun run verify:multiplayer`, and `bun run verify:ui` pass from a clean checkout.
