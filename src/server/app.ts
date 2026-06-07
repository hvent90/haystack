import { Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";
import { cors } from "hono/cors";

import type {
  BuildBaseRequest,
  ChatRequest,
  CreatePilotRequest,
  MineRequest,
  ScanRequest,
  SellRequest,
  ThrustCommand,
  UpgradeRequest,
} from "../shared/types";
import { openDatabase, type HaystackDb } from "./db";
import { WorldStream } from "./realtime";
import { getServerWorld, type ServerWorld } from "./world";
import {
  applyThrust,
  buildForwardHab,
  createPilot,
  getPilot,
  getSnapshot,
  inspectField,
  listChat,
  mineDeposit,
  postChat,
  runScan,
  sellCargo,
  upgradeShip,
} from "./sim";

export type AppDependencies = {
  db?: HaystackDb;
  world?: ServerWorld;
  worldStream?: WorldStream;
};

export function createApp(dependencies: AppDependencies = {}): Hono {
  const db = dependencies.db ?? openDatabase();
  const world = dependencies.world ?? getServerWorld(db);
  const worldStream = dependencies.worldStream ?? new WorldStream(world);
  const app = new Hono();

  app.use(
    "*",
    cors({
      origin: "*",
      allowMethods: ["GET", "POST", "OPTIONS"],
      allowHeaders: ["Content-Type"],
    }),
  );

  app.get("/api/health", (context) =>
    context.json({
      ok: true,
      service: "haystack-server",
      time: new Date().toISOString(),
    }),
  );

  app.post("/api/pilots", async (context) => {
    try {
      const request = await context.req.json<CreatePilotRequest>();
      const pilot = createPilot(db, request);
      worldStream.publishAll();
      return context.json(
        { pilot, snapshot: getSnapshot(db, pilot.id, worldStream.activePilotIds()) },
        201,
      );
    } catch (error) {
      return problem(context, error);
    }
  });

  app.get("/api/pilots/:pilotId", (context) => {
    const pilot = getPilot(db, context.req.param("pilotId"));
    if (pilot === null) {
      return context.json({ error: "Pilot not found." }, 404);
    }
    return context.json({ pilot });
  });

  app.get("/api/world", (context) => {
    const pilotId = context.req.query("pilotId") ?? null;
    return context.json(getSnapshot(db, pilotId, worldStream.activePilotIds()));
  });

  app.get("/api/engine", (context) => {
    return context.json({ engine: world.inspect() });
  });

  app.get(
    "/api/world/stream",
    upgradeWebSocket((context) => {
      const pilotId = context.req.query("pilotId") ?? null;
      let peerId: string | null = null;

      return {
        onOpen: (_event, ws) => {
          peerId = worldStream.open(ws, pilotId);
        },
        onMessage: (event) => {
          if (peerId !== null) {
            worldStream.handleMessage(peerId, event.data);
          }
        },
        onClose: () => {
          if (peerId !== null) {
            worldStream.close(peerId);
          }
        },
      };
    }),
  );

  app.post("/api/ships/:pilotId/thrust", async (context) => {
    try {
      const request = await context.req.json<ThrustCommand>();
      const ship = applyThrust(db, context.req.param("pilotId"), request);
      worldStream.publishAll();
      return context.json({ ship });
    } catch (error) {
      return problem(context, error);
    }
  });

  app.post("/api/ships/:pilotId/scan", async (context) => {
    try {
      const request = await context.req.json<ScanRequest>();
      const report = runScan(db, context.req.param("pilotId"), request);
      worldStream.publishAll();
      return context.json({ report });
    } catch (error) {
      return problem(context, error);
    }
  });

  app.post("/api/ships/:pilotId/mine", async (context) => {
    try {
      const request = await context.req.json<MineRequest>();
      const result = mineDeposit(db, context.req.param("pilotId"), request);
      worldStream.publishAll();
      return context.json({ result });
    } catch (error) {
      return problem(context, error);
    }
  });

  app.post("/api/ships/:pilotId/sell", async (context) => {
    try {
      const request = await context.req.json<SellRequest>();
      const result = sellCargo(db, context.req.param("pilotId"), request);
      worldStream.publishAll();
      return context.json({ result });
    } catch (error) {
      return problem(context, error);
    }
  });

  app.post("/api/ships/:pilotId/bases", async (context) => {
    try {
      const request = await context.req.json<BuildBaseRequest>();
      const result = buildForwardHab(db, context.req.param("pilotId"), request);
      worldStream.publishAll();
      return context.json({ result }, 201);
    } catch (error) {
      return problem(context, error);
    }
  });

  app.get("/api/ships/:pilotId/field-diagnostic", (context) => {
    try {
      const radius = Number(context.req.query("radius") ?? "52000");
      const limit = Number(context.req.query("limit") ?? "16");
      return context.json({
        diagnostic: inspectField(db, context.req.param("pilotId"), radius, limit),
      });
    } catch (error) {
      return problem(context, error);
    }
  });

  app.post("/api/ships/:pilotId/upgrade", async (context) => {
    try {
      const request = await context.req.json<UpgradeRequest>();
      const result = upgradeShip(db, context.req.param("pilotId"), request);
      worldStream.publishAll();
      return context.json({ result });
    } catch (error) {
      return problem(context, error);
    }
  });

  app.post("/api/chat", async (context) => {
    try {
      const request = await context.req.json<ChatRequest>();
      const message = postChat(db, request);
      worldStream.publishAll();
      return context.json({ message }, 201);
    } catch (error) {
      return problem(context, error);
    }
  });

  app.get("/api/chat", (context) => {
    const pilotId = context.req.query("pilotId") ?? null;
    const channel = context.req.query("channel") ?? "global";
    const limit = Number(context.req.query("limit") ?? "50");
    return context.json({ messages: listChat(db, pilotId, channel, limit) });
  });

  return app;
}

function problem(
  context: { json: (value: unknown, status?: number) => Response },
  error: unknown,
): Response {
  const message = error instanceof Error ? error.message : "Unexpected server error.";
  return context.json({ error: message }, 400);
}
