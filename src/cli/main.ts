import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

import type {
  BuildBaseRequest,
  BuildBaseResult,
  ChatMessage,
  ChatRequest,
  CreatePilotRequest,
  FieldDiagnostic,
  MineRequest,
  MineResult,
  Mineral,
  Pilot,
  ScanReport,
  ScanRequest,
  ScanMode,
  SellRequest,
  SellResult,
  Ship,
  ThrustCommand,
  UpgradeRequest,
  UpgradeResult,
  Vector3,
  WorldSnapshot,
  WorldStreamServerMessage,
} from "../shared/types";

type CliState = {
  serverUrl: string;
  pilotId: string | null;
  callsign: string | null;
};

type ParsedArgs = {
  command: string;
  positional: string[];
  flags: Map<string, string | boolean>;
};

const defaultServerUrl = "http://127.0.0.1:8787";
const defaultStatePath = resolve(homedir(), ".haystack-cli.json");

if (import.meta.main) {
  await runCli(process.argv.slice(2));
}

export async function runCli(argv: string[]): Promise<void> {
  const parsed = parseArgs(argv);
  const statePath = String(
    parsed.flags.get("state") ?? process.env["HAYSTACK_CLI_STATE"] ?? defaultStatePath,
  );
  const state = readState(statePath);
  const serverUrl = String(
    parsed.flags.get("server") ?? state.serverUrl ?? defaultServerUrl,
  ).replace(/\/$/, "");
  state.serverUrl = serverUrl;

  switch (parsed.command) {
    case "help":
      printHelp();
      return;
    case "join":
      await join(parsed, state, statePath);
      return;
    case "status":
      await status(state);
      return;
    case "thrust":
      await thrust(parsed, state, statePath);
      return;
    case "watch":
      await watch(parsed, state);
      return;
    case "scan":
      await scan(parsed, state);
      return;
    case "mine":
      await mine(parsed, state);
      return;
    case "sell":
      await sell(parsed, state);
      return;
    case "base":
      await base(parsed, state);
      return;
    case "field":
      await field(parsed, state);
      return;
    case "upgrade":
      await upgrade(parsed, state);
      return;
    case "chat":
      await chat(parsed, state);
      return;
    case "screenshot":
      await screenshot(parsed, state);
      return;
    default:
      printHelp();
      throw new Error(`Unknown command: ${parsed.command}`);
  }
}

async function join(parsed: ParsedArgs, state: CliState, statePath: string): Promise<void> {
  const callsign = parsed.positional[0] ?? `CLI-${Math.floor(1000 + Math.random() * 9000)}`;
  const organizationFlag = parsed.flags.get("org");
  const request: CreatePilotRequest =
    typeof organizationFlag === "string"
      ? { callsign, organization: organizationFlag }
      : { callsign };
  const payload = await api<{ pilot: Pilot; snapshot: WorldSnapshot }>(
    state.serverUrl,
    "/api/pilots",
    {
      method: "POST",
      body: JSON.stringify(request),
    },
  );
  state.pilotId = payload.pilot.id;
  state.callsign = payload.pilot.callsign;
  writeState(statePath, state);
  printJson({ pilot: payload.pilot, statePath });
}

async function status(state: CliState): Promise<void> {
  const pilotId = requirePilot(state);
  const query = new URLSearchParams({ pilotId });
  const snapshot = await api<WorldSnapshot>(state.serverUrl, `/api/world?${query.toString()}`);
  const ship = snapshot.ships.find((candidate) => candidate.pilotId === pilotId);
  printJson({
    pilot: snapshot.me,
    ship,
    cargo: snapshot.cargo,
    visibleAsteroids: snapshot.asteroids.filter((asteroid) => asteroid.discovered).length,
    organizations: snapshot.organizations,
    chatLines: snapshot.chat.length,
  });
}

async function thrust(parsed: ParsedArgs, state: CliState, statePath: string): Promise<void> {
  const pilotId = requirePilot(state);
  const impulse = {
    x: numberFlag(parsed.flags, "x", 0),
    y: numberFlag(parsed.flags, "y", 0),
    z: numberFlag(parsed.flags, "z", 0),
  };
  const command: ThrustCommand =
    parsed.flags.get("stabilize") === true
      ? {
          impulse,
          stabilize: true,
        }
      : { impulse };
  const clientTick = Date.now();
  const payload =
    parsed.flags.get("rest") === true
      ? {
          protocol: "rest" as const,
          ...(await thrustRest(state.serverUrl, pilotId, command)),
        }
      : await thrustViaWorldStream(state.serverUrl, pilotId, clientTick, command).catch(
          async () => ({
            protocol: "rest-fallback" as const,
            ...(await thrustRest(state.serverUrl, pilotId, command)),
          }),
        );
  writeState(statePath, state);
  printJson(payload);
}

async function thrustRest(
  serverUrl: string,
  pilotId: string,
  command: ThrustCommand,
): Promise<{ ship: Ship }> {
  return api<{ ship: Ship }>(serverUrl, `/api/ships/${encodeURIComponent(pilotId)}/thrust`, {
    method: "POST",
    body: JSON.stringify(command),
  });
}

async function thrustViaWorldStream(
  serverUrl: string,
  pilotId: string,
  clientTick: number,
  command: ThrustCommand,
): Promise<{ protocol: "world-stream"; clientTick: number; ship: Ship }> {
  const ack = await withWorldStream(serverUrl, pilotId, async (socket, nextMessage) => {
    await waitForStreamMessage(nextMessage, (message) => message.type === "hello");
    socket.send(
      JSON.stringify({
        type: "input",
        pilotId,
        clientTick,
        command,
      }),
    );
    return waitForStreamMessage(
      nextMessage,
      (message) => message.type === "ack" && message.clientTick === clientTick,
    );
  });

  if (ack.type !== "ack") {
    throw new Error("World stream did not acknowledge thrust input.");
  }

  return {
    protocol: "world-stream",
    clientTick,
    ship: ack.ship,
  };
}

async function scan(parsed: ParsedArgs, state: CliState): Promise<void> {
  const pilotId = requirePilot(state);
  const mode = (parsed.positional[0] ?? "pocket") as ScanMode;
  const asteroid = parsed.flags.get("asteroid");
  const mineral = parsed.flags.get("mineral");
  const request: ScanRequest = {
    mode,
    ...(typeof asteroid === "string" ? { targetAsteroidId: asteroid } : {}),
    ...(typeof mineral === "string" ? { mineral: mineral as Mineral } : {}),
  };
  const payload = await api<{ report: ScanReport }>(
    state.serverUrl,
    `/api/ships/${encodeURIComponent(pilotId)}/scan`,
    {
      method: "POST",
      body: JSON.stringify(request),
    },
  );
  printJson(payload);
}

async function mine(parsed: ParsedArgs, state: CliState): Promise<void> {
  const pilotId = requirePilot(state);
  const asteroidId = requireStringFlag(parsed.flags, "asteroid");
  const depositId = requireStringFlag(parsed.flags, "deposit");
  const request: MineRequest = { asteroidId, depositId };
  const payload = await api<{ result: MineResult }>(
    state.serverUrl,
    `/api/ships/${encodeURIComponent(pilotId)}/mine`,
    {
      method: "POST",
      body: JSON.stringify(request),
    },
  );
  printJson(payload);
}

async function sell(parsed: ParsedArgs, state: CliState): Promise<void> {
  const pilotId = requirePilot(state);
  const mineral = parsed.flags.get("mineral");
  const mass = parsed.flags.get("mass");
  const request: SellRequest = {
    ...(typeof mineral === "string" ? { mineral: mineral as Mineral } : {}),
    ...(typeof mass === "string" ? { mass: Number(mass) } : {}),
  };
  const payload = await api<{ result: SellResult }>(
    state.serverUrl,
    `/api/ships/${encodeURIComponent(pilotId)}/sell`,
    {
      method: "POST",
      body: JSON.stringify(request),
    },
  );
  printJson(payload);
}

async function base(parsed: ParsedArgs, state: CliState): Promise<void> {
  const pilotId = requirePilot(state);
  const name = parsed.flags.get("name");
  const request: BuildBaseRequest = {
    ...(typeof name === "string" ? { name } : {}),
    hidden: parsed.flags.get("visible") !== true,
  };
  const payload = await api<{ result: BuildBaseResult }>(
    state.serverUrl,
    `/api/ships/${encodeURIComponent(pilotId)}/bases`,
    {
      method: "POST",
      body: JSON.stringify(request),
    },
  );
  printJson(payload);
}

async function field(parsed: ParsedArgs, state: CliState): Promise<void> {
  const pilotId = requirePilot(state);
  const query = new URLSearchParams({
    radius: String(numberFlag(parsed.flags, "radius", 52000)),
    limit: String(numberFlag(parsed.flags, "limit", 16)),
  });
  const payload = await api<{ diagnostic: FieldDiagnostic }>(
    state.serverUrl,
    `/api/ships/${encodeURIComponent(pilotId)}/field-diagnostic?${query.toString()}`,
  );
  printJson(payload);
}

async function upgrade(parsed: ParsedArgs, state: CliState): Promise<void> {
  const pilotId = requirePilot(state);
  const system = parsed.positional[0];
  if (!isUpgradeSystem(system)) {
    throw new Error("Upgrade system must be cargo, scanner, mining, or stabilizer.");
  }
  const request: UpgradeRequest = { system };
  const payload = await api<{ result: UpgradeResult }>(
    state.serverUrl,
    `/api/ships/${encodeURIComponent(pilotId)}/upgrade`,
    {
      method: "POST",
      body: JSON.stringify(request),
    },
  );
  printJson(payload);
}

function isUpgradeSystem(system: string | undefined): system is UpgradeRequest["system"] {
  return (
    system === "cargo" || system === "scanner" || system === "mining" || system === "stabilizer"
  );
}

async function chat(parsed: ParsedArgs, state: CliState): Promise<void> {
  const pilotId = requirePilot(state);
  const channel =
    typeof parsed.flags.get("channel") === "string"
      ? String(parsed.flags.get("channel"))
      : "global";
  const body = parsed.positional.join(" ");
  const toPilot = parsed.flags.get("to");
  const request: ChatRequest = {
    channel,
    fromPilotId: pilotId,
    body,
    ...(typeof toPilot === "string" ? { toPilotId: toPilot } : {}),
  };
  const payload = await api<{ message: ChatMessage }>(state.serverUrl, "/api/chat", {
    method: "POST",
    body: JSON.stringify(request),
  });
  printJson(payload);
}

async function watch(parsed: ParsedArgs, state: CliState): Promise<void> {
  const pilotId = requirePilot(state);
  const frames = Math.max(1, Math.min(20, Math.round(numberFlag(parsed.flags, "frames", 1))));
  const messages = await withWorldStream(state.serverUrl, pilotId, async (_socket, nextMessage) => {
    const collected: WorldStreamServerMessage[] = [];
    while (collected.length < frames) {
      collected.push(await nextMessage());
    }
    return collected;
  });
  printJson({
    pilotId,
    frames: messages.map(summarizeStreamMessage),
  });
}

async function screenshot(parsed: ParsedArgs, state: CliState): Promise<void> {
  const pilotId = requirePilot(state);
  const appUrl = String(parsed.flags.get("app-url") ?? "http://127.0.0.1:5173");
  const out = resolve(String(parsed.flags.get("out") ?? "screenshots/haystack-cli.png"));
  const viewport = screenshotViewport(parsed.flags);
  const { chromium } = await import("playwright");
  // The app requires WebGPU; headless Chromium only exposes a device with these flags.
  const browser = await chromium.launch({
    args: ["--enable-unsafe-webgpu", "--enable-unsafe-swiftshader"],
  });
  const page = await browser.newPage({
    viewport: {
      width: viewport.cssWidth,
      height: viewport.cssHeight,
    },
    deviceScaleFactor: viewport.deviceScaleFactor,
    isMobile: viewport.mobile,
  });
  const url = new URL(appUrl);
  url.searchParams.set("pilotId", pilotId);
  mkdirSync(dirname(out), { recursive: true });
  try {
    await page.goto(url.toString(), { waitUntil: "networkidle" });
    await page.waitForSelector("[data-testid='haystack-app']", { timeout: 15000 });
    await page.screenshot({ path: out, fullPage: false, scale: "device" });
  } finally {
    await browser.close();
  }
  printJson({
    out,
    width: viewport.outputWidth,
    height: viewport.outputHeight,
    cssWidth: viewport.cssWidth,
    cssHeight: viewport.cssHeight,
    deviceScaleFactor: viewport.deviceScaleFactor,
    pilotId,
  });
}

async function api<T>(serverUrl: string, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${serverUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({ error: response.statusText }))) as {
      error?: string;
    };
    throw new Error(payload.error ?? response.statusText);
  }
  return (await response.json()) as T;
}

async function withWorldStream<T>(
  serverUrl: string,
  pilotId: string,
  action: (socket: WebSocket, nextMessage: () => Promise<WorldStreamServerMessage>) => Promise<T>,
): Promise<T> {
  const socket = new WebSocket(worldStreamUrl(serverUrl, pilotId));
  const queue: WorldStreamServerMessage[] = [];
  const waiters: Array<(message: WorldStreamServerMessage) => void> = [];
  let streamError: Error | null = null;

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as WorldStreamServerMessage;
    const waiter = waiters.shift();
    if (waiter !== undefined) {
      waiter(message);
      return;
    }
    queue.push(message);
  });
  socket.addEventListener("error", () => {
    streamError = new Error("World stream connection failed.");
  });

  try {
    await waitForOpen(socket);
    return await action(socket, () => nextStreamMessage(socket, queue, waiters, () => streamError));
  } finally {
    socket.close();
  }
}

function nextStreamMessage(
  socket: WebSocket,
  queue: WorldStreamServerMessage[],
  waiters: Array<(message: WorldStreamServerMessage) => void>,
  getError: () => Error | null,
): Promise<WorldStreamServerMessage> {
  const queued = queue.shift();
  if (queued !== undefined) {
    return Promise.resolve(queued);
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      const index = waiters.indexOf(waiter);
      if (index >= 0) {
        waiters.splice(index, 1);
      }
      reject(getError() ?? new Error("Timed out waiting for world stream message."));
    }, 5000);
    const waiter = (message: WorldStreamServerMessage): void => {
      clearTimeout(timeout);
      resolve(message);
    };
    waiters.push(waiter);
    if (socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) {
      clearTimeout(timeout);
      const index = waiters.indexOf(waiter);
      if (index >= 0) {
        waiters.splice(index, 1);
      }
      reject(getError() ?? new Error("World stream closed."));
    }
  });
}

async function waitForStreamMessage(
  nextMessage: () => Promise<WorldStreamServerMessage>,
  predicate: (message: WorldStreamServerMessage) => boolean,
): Promise<WorldStreamServerMessage> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const message = await nextMessage();
    if (predicate(message)) {
      return message;
    }
  }
  throw new Error("Timed out waiting for matching world stream message.");
}

function waitForOpen(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out opening world stream.")), 5000);
    socket.addEventListener(
      "open",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => {
        clearTimeout(timeout);
        reject(new Error("World stream connection failed."));
      },
      { once: true },
    );
  });
}

function worldStreamUrl(serverUrl: string, pilotId: string): string {
  const url = new URL("/api/world/stream", serverUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("pilotId", pilotId);
  return url.toString();
}

function summarizeStreamMessage(message: WorldStreamServerMessage): unknown {
  switch (message.type) {
    case "hello":
      return {
        type: message.type,
        tick: message.tick,
        callsign: message.snapshot.me?.callsign ?? null,
        pilots: message.snapshot.pilots.length,
        ships: message.snapshot.ships.length,
      };
    case "delta":
      return {
        type: message.type,
        tick: message.tick,
        changed: message.changed,
      };
    case "ack":
      return {
        type: message.type,
        tick: message.tick,
        clientTick: message.clientTick,
        ship: message.ship,
      };
    case "error":
      return message;
  }
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = "help", ...rest] = argv;
  const flags = new Map<string, string | boolean>();
  const positional: string[] = [];

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === undefined) {
      continue;
    }
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = rest[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(key, next);
      index += 1;
    } else {
      flags.set(key, true);
    }
  }

  return {
    command,
    positional,
    flags,
  };
}

function readState(path: string): CliState {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as CliState;
  } catch {
    return {
      serverUrl: defaultServerUrl,
      pilotId: null,
      callsign: null,
    };
  }
}

function writeState(path: string, state: CliState): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
}

function requirePilot(state: CliState): string {
  if (state.pilotId === null) {
    throw new Error("No pilot in CLI state. Run `bun run cli join <callsign>` first.");
  }
  return state.pilotId;
}

function requireStringFlag(flags: Map<string, string | boolean>, key: string): string {
  const value = flags.get(key);
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing --${key}.`);
  }
  return value;
}

function numberFlag(flags: Map<string, string | boolean>, key: string, fallback: number): number {
  const value = flags.get(key);
  if (typeof value !== "string") {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function screenshotViewport(flags: Map<string, string | boolean>): {
  cssWidth: number;
  cssHeight: number;
  deviceScaleFactor: number;
  outputWidth: number;
  outputHeight: number;
  mobile: boolean;
} {
  const minPixels = 1920 * 1080;
  const mobile = flags.get("mobile") === true;
  const cssWidth = Math.max(320, Math.round(numberFlag(flags, "width", mobile ? 390 : 1920)));
  const cssHeight = Math.max(320, Math.round(numberFlag(flags, "height", mobile ? 844 : 1080)));
  let deviceScaleFactor = Math.max(
    1,
    Math.round(numberFlag(flags, "device-scale", mobile ? 3 : 1)),
  );

  while (
    cssWidth * deviceScaleFactor < 1080 ||
    cssHeight * deviceScaleFactor < 1080 ||
    cssWidth * cssHeight * deviceScaleFactor * deviceScaleFactor < minPixels
  ) {
    deviceScaleFactor += 1;
  }

  return {
    cssWidth,
    cssHeight,
    deviceScaleFactor,
    outputWidth: cssWidth * deviceScaleFactor,
    outputHeight: cssHeight * deviceScaleFactor,
    mobile,
  };
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function printHelp(): void {
  console.log(`Haystack CLI

Commands:
  join <callsign> [--org name] [--server url]
  status
  thrust --x n --y n --z n [--stabilize] [--rest]
  watch [--frames n]
  scan [belt|pocket|surface] [--asteroid id] [--mineral name]
  mine --asteroid id --deposit id
  sell [--mineral name] [--mass n]
  base [--name label] [--visible]
  field [--radius n] [--limit n]
  upgrade <cargo|scanner|mining|stabilizer>
  chat <message> [--channel global] [--to pilotId]
  screenshot [--app-url url] [--out path] [--width 1920] [--height 1080] [--mobile] [--device-scale 3]
`);
}
