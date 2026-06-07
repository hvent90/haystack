# Haystack

Persistent multiplayer space mining prototype built with Bun, strict TypeScript, Hono, SQLite, React Three Fiber, and Three.js.

## Run

```sh
bun install
bun run dev:server
bun run dev:client
```

Open `http://127.0.0.1:5173/`. The Vite dev server binds to `0.0.0.0` and proxies `/api` to the Hono server, so a LAN URL or Cloudflare Tunnel can use the same browser origin for client and API calls.

For LAN testing:

```sh
ipconfig getifaddr en0
```

Then open `http://<lan-ip>:5173/` from another device on the same network. If `cloudflared` is installed, expose the hot reload client with:

```sh
cloudflared tunnel --url http://127.0.0.1:5173
```

## CLI

```sh
bun run cli join Prospector
bun run cli status
bun run cli scan pocket
bun run cli thrust --x 4 --y 0 --z -8
bun run cli field
bun run cli base --name "Cold Cache HAB"
bun run cli upgrade scanner
bun run cli chat "needle ping online"
bun run cli screenshot --out screenshots/haystack-cli.png
```

Screenshots default to 1920x1080. For a high-resolution mobile layout:

```sh
bun run cli screenshot --mobile --width 390 --height 844 --device-scale 3 --out screenshots/haystack-mobile.png
```

## Verify

```sh
bun run verify
bun run build
bun run verify:screenshot
bun run verify:multiplayer
bun run verify:e2e
```

`verify:screenshot` starts the real server and Vite client, drives the app through the CLI, exports desktop and mobile screenshots, and checks rendered canvas pixels.

`verify:multiplayer` starts a real Hono server and Vite client, opens two isolated browser clients with different pilots, verifies they see each other in the shared world, applies thrust to one pilot, and waits for the other browser to show the movement telemetry.
