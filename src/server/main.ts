import { websocket } from "hono/bun";

import { createApp } from "./app";
import { openDatabase } from "./db";
import { WorldStream } from "./realtime";
import { getServerWorld } from "./world";

const port = Number(process.env["PORT"] ?? "8787");
const db = openDatabase();
const world = getServerWorld(db);
world.start();
const worldStream = new WorldStream(world);
worldStream.start();
const app = createApp({ db, world, worldStream });

Bun.serve({
  port,
  fetch: app.fetch,
  websocket,
});

console.log(`Haystack server listening on http://127.0.0.1:${port}`);
