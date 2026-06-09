// Local-only observability endpoints, registered on the Hono app. All routes refuse unless
// HAYSTACK_METRICS=1, and are never exposed through the Cloudflare tunnel (the tunnel points at
// Vite :5273, which only proxies /api). See metrics.ts and the design spec.
//
//   GET /debug/metrics            -> self-contained HTML dashboard (timeseries + flame/icicle)
//   GET /debug/metrics/data       -> JSON rollup rows from data/haystack-metrics.sqlite
//   GET /debug/metrics/live       -> in-memory per-tick phase breakdowns (last ~120s)
//   GET /debug/profile?seconds=10 -> a real V8 .cpuprofile (open in speedscope / DevTools)

import type { Hono } from "hono";

import { METRICS_DASHBOARD_HTML } from "./metrics-dashboard";
import { metrics, TICK_BUDGET_MS } from "./metrics";

type InspectorSession = {
  connect(): void;
  disconnect(): void;
  post(
    method: string,
    params: Record<string, unknown>,
    callback: (err: Error | null, result?: unknown) => void,
  ): void;
};

let inspectorSession: InspectorSession | null = null;
let profiling = false;

async function getInspectorSession(): Promise<InspectorSession> {
  if (inspectorSession !== null) {
    return inspectorSession;
  }
  const mod = (await import("node:inspector")) as unknown as {
    Session: new () => InspectorSession;
  };
  const session = new mod.Session();
  session.connect();
  inspectorSession = session;
  return session;
}

function post(
  session: InspectorSession,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    session.post(method, params, (err, result) => (err ? reject(err) : resolve(result)));
  });
}

async function captureCpuProfile(seconds: number, intervalUs: number): Promise<unknown> {
  if (profiling) {
    throw new Error("A profile capture is already in progress.");
  }
  profiling = true;
  try {
    const session = await getInspectorSession();
    await post(session, "Profiler.enable", {});
    await post(session, "Profiler.setSamplingInterval", { interval: intervalUs });
    await post(session, "Profiler.start", {});
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
    const stopped = (await post(session, "Profiler.stop", {})) as { profile: unknown };
    return stopped.profile;
  } finally {
    profiling = false;
  }
}

function disabled(): Response {
  return new Response(
    JSON.stringify({ error: "Metrics disabled. Start the server with HAYSTACK_METRICS=1." }),
    { status: 404, headers: { "content-type": "application/json" } },
  );
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

export function registerMetricsRoutes(app: Hono): void {
  app.get("/debug/metrics", (context) => {
    if (!metrics.enabled) {
      return disabled();
    }
    return context.html(METRICS_DASHBOARD_HTML);
  });

  app.get("/debug/metrics/data", (context) => {
    if (!metrics.enabled) {
      return disabled();
    }
    const until = Number(context.req.query("until") ?? nowSec());
    const sinceParam = context.req.query("since");
    const since = sinceParam !== undefined ? Number(sinceParam) : until - 1800;
    const rows = metrics.readRollups(since, until);
    return context.json({ budgetMs: TICK_BUDGET_MS, since, until, rows });
  });

  app.get("/debug/metrics/live", (context) => {
    if (!metrics.enabled) {
      return disabled();
    }
    return context.json({ budgetMs: TICK_BUDGET_MS, ticks: metrics.liveTicks() });
  });

  app.get("/debug/profile", async (context) => {
    if (!metrics.enabled) {
      return disabled();
    }
    const seconds = Math.min(60, Math.max(1, Number(context.req.query("seconds") ?? "10")));
    const intervalUs = Math.max(100, Number(context.req.query("interval") ?? "500"));
    try {
      const profile = await captureCpuProfile(seconds, intervalUs);
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      return new Response(JSON.stringify(profile), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "content-disposition": `attachment; filename="haystack-${stamp}.cpuprofile"`,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Profile capture failed.";
      return new Response(JSON.stringify({ error: message }), {
        status: 409,
        headers: { "content-type": "application/json" },
      });
    }
  });
}
