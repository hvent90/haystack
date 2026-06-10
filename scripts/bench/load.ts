// Live network load generator for the Haystack world-stream broadcast path.
//
// Unlike scripts/bench/world-stream.ts (which drives WorldStream in-process), THIS
// script is a real client: it talks to a running server purely over HTTP + WebSocket,
// exactly as the browser does. It imports NO server internals — only the shared protocol
// types — so it measures the real server under real socket load (the cost the in-process
// bench never pays). It reproduces the 16-player / 30Hz condition by ramping N clients in,
// each subscribing and pushing varied flight input frames, then holding while measuring the
// client-observed broadcast cadence (deltas/sec).
//
// Usage:
//   # default: 16 players, 10s ramp, 60s hold, 30Hz input against 127.0.0.1:8787
//   bun scripts/bench/load.ts
//
//   # quick smoke against an already-running dev server
//   LOAD_PLAYERS=2 LOAD_RAMP_S=1 LOAD_HOLD_S=2 bun scripts/bench/load.ts
//
//   # point at a remote/public server and push harder
//   LOAD_BASE=https://haystack.example.com LOAD_PLAYERS=32 LOAD_HZ=60 bun scripts/bench/load.ts
//
// Env knobs (with defaults):
//   LOAD_PLAYERS=16     number of concurrent clients
//   LOAD_BASE=http://127.0.0.1:8787   server base URL (http->ws, https->wss for the stream)
//   LOAD_RAMP_S=10      seconds to ramp from 1..LOAD_PLAYERS clients (evenly spaced)
//   LOAD_HOLD_S=60      seconds to hold all clients sending input
//   LOAD_HZ=30          input frames per second per client
//   LOAD_SPEED=1        throttle magnitude (~ -1..1); drives ship motion so deltas aren't empty
//
// Output:
//   STDOUT: a single final JSON summary line (machine-readable).
//   STDERR: human-readable progress every ~5s (connected count, aggregate deltas/sec).
//
// SIGINT triggers a clean shutdown (stop loops, close sockets, then print the summary).

import type {
  CreatePilotRequest,
  FlightInputCommand,
  Pilot,
  WorldStreamClientMessage,
  WorldStreamServerMessage,
} from "../../src/shared/types";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

type Config = {
  players: number;
  base: string;
  wsBase: string;
  rampS: number;
  holdS: number;
  hz: number;
  speed: number;
};

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function str(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw.trim() === "" ? fallback : raw;
}

function toWsBase(base: string): string {
  // http://... -> ws://...   https://... -> wss://...
  if (base.startsWith("https")) {
    return `wss${base.slice("https".length)}`;
  }
  if (base.startsWith("http")) {
    return `ws${base.slice("http".length)}`;
  }
  return base;
}

function readConfig(): Config {
  const base = str("LOAD_BASE", "http://127.0.0.1:8787").replace(/\/+$/, "");
  const ws = toWsBase(base);
  return {
    players: Math.max(1, Math.floor(num("LOAD_PLAYERS", 16))),
    base,
    wsBase: ws,
    rampS: Math.max(0, num("LOAD_RAMP_S", 10)),
    holdS: Math.max(0, num("LOAD_HOLD_S", 60)),
    hz: Math.max(1, num("LOAD_HZ", 30)),
    speed: num("LOAD_SPEED", 1),
  };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function now(): number {
  return Date.now();
}

function isServerMessage(value: unknown): value is WorldStreamServerMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string"
  );
}

// ---------------------------------------------------------------------------
// Pilot creation (REST, idempotent on callsign)
// ---------------------------------------------------------------------------

type CreatePilotResponse = {
  pilot: Pilot;
};

async function createOrReusePilot(base: string, callsign: string): Promise<Pilot> {
  const body: CreatePilotRequest = { callsign, organization: "LoadTest" };
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(`${base}/api/pilots`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        throw new Error(`POST /api/pilots -> HTTP ${response.status}`);
      }
      const json = (await response.json()) as CreatePilotResponse;
      if (json.pilot === undefined || typeof json.pilot.id !== "string") {
        throw new Error("POST /api/pilots returned no pilot.id");
      }
      return json.pilot;
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        await sleep(150 * attempt);
      }
    }
  }
  throw new Error(
    `create pilot "${callsign}" failed after 3 attempts: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

// ---------------------------------------------------------------------------
// Per-client load driver
// ---------------------------------------------------------------------------

class LoadClient {
  readonly index: number;
  readonly callsign: string;
  private readonly config: Config;
  private pilot: Pilot | null = null;
  private ws: WebSocket | null = null;
  private inputTimer: ReturnType<typeof setInterval> | null = null;
  private clientTick = 0;

  // Metrics
  inputsSent = 0;
  deltasReceived = 0;
  acksReceived = 0;
  hellosReceived = 0;
  connectErrors = 0;
  connected = false;
  private reconnectUsed = false;
  private stopped = false;
  private firstDeltaAt: number | null = null;
  private lastDeltaAt: number | null = null;

  constructor(index: number, config: Config) {
    this.index = index;
    this.config = config;
    // Stable callsign so re-runs reuse the same pilots (createPilot is idempotent on callsign).
    this.callsign = `Load-${String(index).padStart(2, "0")}`;
  }

  async start(): Promise<void> {
    try {
      this.pilot = await createOrReusePilot(this.config.base, this.callsign);
    } catch (error) {
      this.connectErrors += 1;
      process.stderr.write(
        `[load] client ${this.callsign}: pilot create failed: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
      return;
    }
    this.connect();
  }

  private connect(): void {
    if (this.stopped || this.pilot === null) {
      return;
    }
    const pilotId = this.pilot.id;
    const url = `${this.config.wsBase}/api/world/stream?pilotId=${encodeURIComponent(pilotId)}`;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (error) {
      this.connectErrors += 1;
      this.maybeReconnect();
      void error;
      return;
    }
    this.ws = ws;

    ws.addEventListener("open", () => {
      if (this.stopped) {
        ws.close();
        return;
      }
      this.connected = true;
      const subscribe: WorldStreamClientMessage = { type: "subscribe", pilotId };
      ws.send(JSON.stringify(subscribe));
      this.startInputLoop(pilotId, ws);
    });

    ws.addEventListener("message", (event: MessageEvent) => {
      this.onMessage(event.data);
    });

    ws.addEventListener("error", () => {
      // The 'error' event is followed by 'close'; count once and let close drive reconnect.
      this.connectErrors += 1;
    });

    ws.addEventListener("close", () => {
      this.connected = false;
      this.stopInputLoop();
      if (!this.stopped) {
        this.maybeReconnect();
      }
    });
  }

  private maybeReconnect(): void {
    if (this.stopped || this.reconnectUsed) {
      return;
    }
    this.reconnectUsed = true;
    process.stderr.write(
      `[load] client ${this.callsign}: socket closed early, reconnecting once\n`,
    );
    // Brief backoff before the single retry.
    setTimeout(() => this.connect(), 250);
  }

  private onMessage(data: unknown): void {
    if (typeof data !== "string") {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    if (!isServerMessage(parsed)) {
      return;
    }
    switch (parsed.type) {
      case "delta": {
        this.deltasReceived += 1;
        const t = now();
        if (this.firstDeltaAt === null) {
          this.firstDeltaAt = t;
        }
        this.lastDeltaAt = t;
        return;
      }
      case "ack":
        this.acksReceived += 1;
        return;
      case "hello":
        this.hellosReceived += 1;
        return;
      case "error":
        process.stderr.write(`[load] client ${this.callsign}: server error: ${parsed.message}\n`);
        return;
    }
  }

  private startInputLoop(pilotId: string, ws: WebSocket): void {
    this.stopInputLoop();
    const periodMs = 1000 / this.config.hz;
    this.inputTimer = setInterval(() => {
      if (this.stopped || ws.readyState !== ws.OPEN) {
        return;
      }
      const command = this.buildCommand();
      const message: WorldStreamClientMessage = {
        type: "input",
        pilotId,
        clientTick: this.clientTick++,
        command,
      };
      try {
        ws.send(JSON.stringify(message));
        this.inputsSent += 1;
      } catch {
        // Send can throw if the socket flipped to CLOSING between the readyState check
        // and the write; the close handler will drive reconnect.
      }
    }, periodMs);
  }

  private stopInputLoop(): void {
    if (this.inputTimer !== null) {
      clearInterval(this.inputTimer);
      this.inputTimer = null;
    }
  }

  // Vary throttle and rotation per client (keyed by index) and over time (keyed by tick)
  // so each ship actually moves and turns. Stationary ships produce empty deltas, which
  // would understate broadcast load.
  private buildCommand(): FlightInputCommand {
    const t = this.clientTick;
    const phase = this.index * 0.61803398875; // golden-ratio offset to de-sync clients
    const throttle = this.config.speed * Math.cos(t * 0.05 + phase * Math.PI * 2);
    const yaw = 0.4 * Math.sin(t * 0.07 + phase * 3.0);
    const pitch = 0.3 * Math.sin(t * 0.045 + phase * 5.0 + 1.1);
    return {
      kind: "flight",
      throttle,
      strafe: { x: 0, y: 0, z: 0 },
      rotation: { x: pitch, y: yaw, z: 0 },
      active: true,
      stabilize: false,
      boost: false,
      cruiseLock: false,
    };
  }

  // Stop sending input and close the socket without triggering reconnect.
  shutdown(): void {
    this.stopped = true;
    this.stopInputLoop();
    const ws = this.ws;
    if (ws !== null) {
      try {
        ws.close(1000, "load test complete");
      } catch {
        // ignore
      }
    }
  }

  // deltas/sec observed by this client over its active delta window.
  deltasPerSec(): number {
    if (this.firstDeltaAt === null || this.lastDeltaAt === null || this.deltasReceived === 0) {
      return 0;
    }
    const windowMs = this.lastDeltaAt - this.firstDeltaAt;
    if (windowMs <= 0) {
      // Only one delta (or all in the same ms) — report against the configured hold instead.
      return this.deltasReceived;
    }
    // Count intervals between deltas: (n-1) gaps over the window.
    return ((this.deltasReceived - 1) / windowMs) * 1000;
  }
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

type Summary = {
  players: number;
  durationS: number;
  totalInputsSent: number;
  totalDeltasReceived: number;
  perClientDeltasPerSec: { min: number; avg: number; max: number };
  connectErrors: number;
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function buildSummary(clients: LoadClient[], config: Config, durationS: number): Summary {
  const totalInputsSent = clients.reduce((acc, c) => acc + c.inputsSent, 0);
  const totalDeltasReceived = clients.reduce((acc, c) => acc + c.deltasReceived, 0);
  const connectErrors = clients.reduce((acc, c) => acc + c.connectErrors, 0);

  const rates = clients.map((c) => c.deltasPerSec());
  const min = rates.length === 0 ? 0 : Math.min(...rates);
  const max = rates.length === 0 ? 0 : Math.max(...rates);
  const avg = rates.length === 0 ? 0 : rates.reduce((a, b) => a + b, 0) / rates.length;

  return {
    players: config.players,
    durationS: round2(durationS),
    totalInputsSent,
    totalDeltasReceived,
    perClientDeltasPerSec: { min: round2(min), avg: round2(avg), max: round2(max) },
    connectErrors,
  };
}

function aggregateDeltasPerSec(clients: LoadClient[]): number {
  return clients.reduce((acc, c) => acc + c.deltasPerSec(), 0);
}

async function main(): Promise<void> {
  const config = readConfig();
  process.stderr.write(
    `[load] starting: players=${config.players} base=${config.base} ws=${config.wsBase} ` +
      `ramp=${config.rampS}s hold=${config.holdS}s hz=${config.hz} speed=${config.speed}\n`,
  );

  const clients: LoadClient[] = [];
  for (let i = 0; i < config.players; i += 1) {
    clients.push(new LoadClient(i, config));
  }

  let shuttingDown = false;
  const runStart = now();

  // Clean shutdown on SIGINT: stop loops, close sockets, print summary, exit.
  let sigintHandled = false;
  const onSigint = (): void => {
    if (sigintHandled) {
      return;
    }
    sigintHandled = true;
    shuttingDown = true;
    process.stderr.write("[load] SIGINT received, shutting down...\n");
    for (const client of clients) {
      client.shutdown();
    }
    const durationS = (now() - runStart) / 1000;
    const summary = buildSummary(clients, config, durationS);
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    // Give close frames a moment to flush, then exit.
    setTimeout(() => process.exit(0), 200);
  };
  process.on("SIGINT", onSigint);

  // Progress reporter on STDERR every ~5s.
  const progressTimer = setInterval(() => {
    if (shuttingDown) {
      return;
    }
    const connected = clients.filter((c) => c.connected).length;
    const aggDeltas = Math.round(aggregateDeltasPerSec(clients));
    const inputs = clients.reduce((acc, c) => acc + c.inputsSent, 0);
    process.stderr.write(
      `[load] t=${Math.round((now() - runStart) / 1000)}s connected=${connected}/${config.players} ` +
        `aggDeltas/s=${aggDeltas} inputsSent=${inputs}\n`,
    );
  }, 5000);

  // Ramp clients in evenly over rampS. With players P and ramp R, the first client starts
  // immediately and each subsequent client starts R/P seconds later (so the last lands near R).
  const gapMs = config.players > 0 ? (config.rampS * 1000) / config.players : 0;
  for (let i = 0; i < clients.length; i += 1) {
    if (shuttingDown) {
      break;
    }
    // Fire-and-forget: start() awaits the REST create then opens the socket. We don't await it
    // here so the ramp cadence stays even regardless of per-client create latency.
    void clients[i]?.start();
    process.stderr.write(
      `[load] ramping client ${clients[i]?.callsign} (${i + 1}/${config.players})\n`,
    );
    if (i < clients.length - 1 && gapMs > 0) {
      await sleep(gapMs);
    }
  }

  // Hold while all clients send input.
  if (!shuttingDown) {
    process.stderr.write(`[load] ramp complete, holding for ${config.holdS}s\n`);
    await sleep(config.holdS * 1000);
  }

  if (shuttingDown) {
    // SIGINT path already printed and is exiting.
    return;
  }

  // Clean shutdown.
  for (const client of clients) {
    client.shutdown();
  }
  clearInterval(progressTimer);
  process.off("SIGINT", onSigint);
  // Let close frames flush.
  await sleep(200);

  const durationS = (now() - runStart) / 1000;
  const summary = buildSummary(clients, config, durationS);
  process.stderr.write(
    `[load] done: inputs=${summary.totalInputsSent} deltas=${summary.totalDeltasReceived} ` +
      `deltas/s[min/avg/max]=${summary.perClientDeltasPerSec.min}/${summary.perClientDeltasPerSec.avg}/${summary.perClientDeltasPerSec.max} ` +
      `errors=${summary.connectErrors}\n`,
  );
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  process.exit(0);
}

main().catch((error) => {
  process.stderr.write(
    `[load] fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(1);
});
