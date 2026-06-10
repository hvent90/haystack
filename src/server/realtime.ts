import { randomUUID } from "node:crypto";

import type { WSContext, WSMessageReceive } from "hono/ws";

import type {
  FlightInputCommand,
  Ship,
  ThrustCommand,
  WorldSnapshot,
  WorldSnapshotKey,
  WorldSnapshotPatch,
  WorldStreamClientMessage,
  WorldStreamServerMessage,
} from "../shared/types";
import {
  ASTEROIDS_FINGERPRINT,
  buildSharedWorld,
  getPilot,
  getPilotView,
  getSnapshot,
} from "./sim";
import type { SharedWorld } from "./sim";
import { metrics } from "./metrics";
import type { ServerWorld } from "./world";

// Snapshot keys whose value is identical for every peer on a tick (no per-pilot overlay), so
// their change-detection hash can be computed once per tick instead of once per peer. The
// remaining keys (me/asteroids/deposits/structures/cargo/chat) carry a per-pilot overlay and
// are hashed per peer. serverTime is excluded from replicatedKeys entirely (always re-sent).
const sharedSnapshotKeys: WorldSnapshotKey[] = [
  "field",
  "pilots",
  "activePilotIds",
  "organizations",
  "ships",
];

type SharedHashes = ReadonlyMap<WorldSnapshotKey, string>;

type WorldPeer = {
  id: string;
  pilotId: string | null;
  ws: WSContext;
  shadowHashes: Map<WorldSnapshotKey, string>;
};

const worldSnapshotKeys: WorldSnapshotKey[] = [
  "serverTime",
  "field",
  "me",
  "pilots",
  "activePilotIds",
  "organizations",
  "ships",
  "asteroids",
  "deposits",
  "structures",
  "cargo",
  "chat",
];

const replicatedKeys = worldSnapshotKeys.filter((key) => key !== "serverTime");

export class WorldStream {
  private readonly peers = new Map<string, WorldPeer>();
  private currentTick = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private publishing = false;

  constructor(private readonly world: ServerWorld) {}

  start(hz = 30): void {
    if (this.timer !== null) {
      return;
    }
    this.timer = setInterval(() => this.publishAll(), Math.max(10, 1000 / hz));
  }

  // Monotonic, deterministic broadcast clock derived from the fixed-step sim
  // time. Clients interpolate remote entities against this evenly-spaced
  // timeline rather than wall-clock arrival times.
  private serverTimeMs(): number {
    return this.world.simTime * 1000;
  }

  stop(): void {
    if (this.timer === null) {
      return;
    }
    clearInterval(this.timer);
    this.timer = null;
  }

  open(ws: WSContext, pilotId: string | null): string {
    const peer: WorldPeer = {
      id: `peer-${randomUUID()}`,
      pilotId: null,
      ws,
      shadowHashes: new Map(),
    };
    this.peers.set(peer.id, peer);
    this.subscribe(peer, pilotId);
    if (this.peers.has(peer.id)) {
      this.publishAll();
    }
    return peer.id;
  }

  close(peerId: string): void {
    const removed = this.peers.delete(peerId);
    if (removed && !this.publishing) {
      this.publishAll();
    }
  }

  activePilotIds(): string[] {
    const ids = new Set<string>();
    for (const peer of this.peers.values()) {
      if (peer.pilotId !== null) {
        ids.add(peer.pilotId);
      }
    }
    return [...ids].sort();
  }

  handleMessage(peerId: string, data: WSMessageReceive): void {
    const peer = this.peers.get(peerId);
    if (peer === undefined) {
      return;
    }

    const message = decodeClientMessage(data);
    if (message === null) {
      this.send(peer, { type: "error", message: "Expected a typed JSON stream message." });
      return;
    }

    try {
      switch (message.type) {
        case "subscribe":
          this.subscribe(peer, message.pilotId);
          return;
        case "input":
          this.handleInput(peer, message);
          return;
      }
    } catch (error) {
      this.send(peer, { type: "error", message: messageFrom(error) });
    }
  }

  publishAll(): void {
    if (this.peers.size === 0) {
      return;
    }

    const peerCount = this.peers.size;
    metrics.beginPublishTick(peerCount);
    const tickStart = performance.now();
    this.publishing = true;
    try {
      this.currentTick += 1;
      // Build the shared world — and the change-detection hashes of its peer-identical keys —
      // ONCE per tick. Each peer then only derives its per-pilot overlay, so broadcast cost is
      // O(players) (one delta each) instead of the old O(players^2) (every peer rebuilding and
      // re-hashing the whole shared world). See P2 in ralph/prd.json.
      // buildSharedWorld advances the world (advanceWorld -> advanceToNow) itself, so we no
      // longer advance explicitly here — that was the redundant double-advance (advances/tick 2->1).
      const shared = metrics.time("publish.buildShared", () =>
        buildSharedWorld(this.world.db, this.activePilotIds()),
      );
      const sharedHashes = metrics.time("publish.computeHashes", () => computeSharedHashes(shared));
      metrics.time("publish.flushPeers", () => {
        for (const peer of this.peers.values()) {
          this.flushPeer(peer, shared, sharedHashes);
        }
      });
    } finally {
      this.publishing = false;
      metrics.endPublishTick(peerCount, performance.now() - tickStart);
    }
  }

  private subscribe(peer: WorldPeer, pilotId: string | null): void {
    if (pilotId !== null && getPilot(this.world.db, pilotId) === null) {
      this.send(peer, { type: "error", message: "Pilot not found for world stream." });
      peer.ws.close(1008, "Pilot not found");
      this.close(peer.id);
      return;
    }

    peer.pilotId = pilotId;
    peer.shadowHashes.clear();
    const snapshot = getSnapshot(this.world.db, pilotId, this.activePilotIds());
    storeShadow(peer, snapshot);
    this.send(peer, {
      type: "hello",
      protocol: "haystack.world.v1",
      peerId: peer.id,
      tick: this.currentTick,
      serverTimeMs: this.serverTimeMs(),
      snapshot,
    });
  }

  private handleInput(
    peer: WorldPeer,
    message: Extract<WorldStreamClientMessage, { type: "input" }>,
  ): void {
    if (peer.pilotId === null) {
      this.subscribe(peer, message.pilotId);
    }
    if (peer.pilotId !== message.pilotId) {
      throw new Error("Stream input pilot does not match the subscribed pilot.");
    }

    const ship = this.world.applyCommand(message.pilotId, message.command);
    this.currentTick += 1;
    // Ack the sender immediately so owned-ship reconciliation stays responsive.
    // Remote peers learn about this movement on the next regular broadcast tick
    // (publishAll), keeping snapshot arrival evenly spaced for interpolation
    // instead of bursting a full snapshot to everyone on every input frame.
    this.sendAck(peer, message.clientTick, ship);
  }

  private sendAck(peer: WorldPeer, clientTick: number, ship: Ship): void {
    this.send(peer, {
      type: "ack",
      tick: this.currentTick,
      serverTimeMs: this.serverTimeMs(),
      ackClientTick: clientTick,
      clientTick,
      ship,
    });
  }

  private flushPeer(peer: WorldPeer, shared: SharedWorld, sharedHashes: SharedHashes): void {
    if (peer.ws.readyState !== 1) {
      this.close(peer.id);
      return;
    }

    const snapshot = metrics.time("peer.getPilotView", () =>
      getPilotView(this.world.db, shared, peer.pilotId),
    );
    const changed = metrics.time("peer.hashing", () => {
      const result = collectChangedKeys(peer, snapshot, sharedHashes);
      storeShadow(peer, snapshot, sharedHashes);
      return result;
    });
    if (changed.length === 0) {
      metrics.count("peer.emptyDeltas");
      return;
    }
    metrics.count("peer.deltas");

    this.send(peer, {
      type: "delta",
      tick: this.currentTick,
      serverTimeMs: this.serverTimeMs(),
      changed,
      patch: createPatch(snapshot, changed),
    });
  }

  private send(peer: WorldPeer, message: WorldStreamServerMessage): void {
    if (peer.ws.readyState === 1) {
      const payload = metrics.time("peer.stringify", () => JSON.stringify(message));
      metrics.gauge("peer.bytes", payload.length);
      const delayMs = streamDelayMs(message);
      if (delayMs > 0) {
        setTimeout(() => {
          if (peer.ws.readyState === 1) {
            peer.ws.send(payload);
          }
        }, delayMs);
        return;
      }
      // The real WebSocket write to a live socket — the cost the in-process bench never paid.
      metrics.time("peer.send", () => peer.ws.send(payload));
    }
  }
}

function streamDelayMs(message: WorldStreamServerMessage): number {
  if (message.type !== "ack" && message.type !== "delta") {
    return 0;
  }
  const base = Number(process.env["HAYSTACK_STREAM_DELAY_MS"] ?? "0");
  const jitter = Number(process.env["HAYSTACK_STREAM_JITTER_MS"] ?? "0");
  const boundedBase = Number.isFinite(base) ? Math.max(0, base) : 0;
  const boundedJitter = Number.isFinite(jitter) ? Math.max(0, jitter) : 0;
  if (boundedBase <= 0 && boundedJitter <= 0) {
    return 0;
  }
  return boundedBase + ((message.tick * 37) % (boundedJitter + 1));
}

// Hashes of the shared (peer-identical) snapshot keys, computed once per tick. JSON.stringify
// of the shared value equals what hashSnapshotKey would produce per peer (the snapshot shares
// those values by reference), so reusing these is byte-equivalent to the old per-peer hashing.
function computeSharedHashes(shared: SharedWorld): SharedHashes {
  const hashes = new Map<WorldSnapshotKey, string>();
  for (const key of sharedSnapshotKeys) {
    hashes.set(key, JSON.stringify(shared[key as keyof SharedWorld]));
  }
  return hashes;
}

function hashKeyFor(
  snapshot: WorldSnapshot,
  key: WorldSnapshotKey,
  sharedHashes?: SharedHashes,
): string {
  const shared = sharedHashes?.get(key);
  return shared !== undefined ? shared : hashSnapshotKey(snapshot, key);
}

function collectChangedKeys(
  peer: WorldPeer,
  snapshot: WorldSnapshot,
  sharedHashes?: SharedHashes,
): WorldSnapshotKey[] {
  return replicatedKeys.filter(
    (key) => peer.shadowHashes.get(key) !== hashKeyFor(snapshot, key, sharedHashes),
  );
}

function storeShadow(peer: WorldPeer, snapshot: WorldSnapshot, sharedHashes?: SharedHashes): void {
  for (const key of worldSnapshotKeys) {
    peer.shadowHashes.set(key, hashKeyFor(snapshot, key, sharedHashes));
  }
}

function createPatch(snapshot: WorldSnapshot, changed: WorldSnapshotKey[]): WorldSnapshotPatch {
  const entries: Array<[WorldSnapshotKey, WorldSnapshot[WorldSnapshotKey]]> = [
    ["serverTime", snapshot.serverTime],
  ];
  for (const key of changed) {
    entries.push([key, snapshot[key]]);
  }
  return Object.fromEntries(entries) as WorldSnapshotPatch;
}

function hashSnapshotKey(snapshot: WorldSnapshot, key: WorldSnapshotKey): string {
  // The field is the one snapshot key whose serialization is huge (up to 100k rocks);
  // getSnapshot attaches a cheap cell-stable fingerprint so change-detection never has
  // to JSON.stringify the whole field every tick. All other keys are tiny.
  if (key === "asteroids") {
    const fingerprint = (snapshot as { [ASTEROIDS_FINGERPRINT]?: string })[ASTEROIDS_FINGERPRINT];
    if (fingerprint !== undefined) {
      return fingerprint;
    }
  }
  return JSON.stringify(snapshot[key]);
}

function decodeClientMessage(data: WSMessageReceive): WorldStreamClientMessage | null {
  if (typeof data !== "string") {
    return null;
  }

  try {
    const value = JSON.parse(data) as unknown;
    if (!isRecord(value)) {
      return null;
    }
    if (value["type"] === "subscribe" && typeof value["pilotId"] === "string") {
      return {
        type: "subscribe",
        pilotId: value["pilotId"],
      };
    }
    if (
      value["type"] === "input" &&
      typeof value["pilotId"] === "string" &&
      typeof value["clientTick"] === "number" &&
      isInputCommand(value["command"])
    ) {
      return {
        type: "input",
        pilotId: value["pilotId"],
        clientTick: value["clientTick"],
        command: value["command"],
      };
    }
  } catch {
    return null;
  }

  return null;
}

function isInputCommand(value: unknown): value is ThrustCommand | FlightInputCommand {
  return isThrustCommand(value) || isFlightInputCommand(value);
}

function isThrustCommand(value: unknown): value is ThrustCommand {
  if (!isRecord(value) || !isVector(value["impulse"])) {
    return false;
  }
  const stabilize = value["stabilize"];
  const boost = value["boost"];
  const angularImpulse = value["angularImpulse"];
  const frame = value["frame"];
  return (
    (stabilize === undefined || typeof stabilize === "boolean") &&
    (boost === undefined || typeof boost === "boolean") &&
    (angularImpulse === undefined || isVector(angularImpulse)) &&
    (frame === undefined || frame === "world" || frame === "local")
  );
}

function isFlightInputCommand(value: unknown): value is FlightInputCommand {
  if (
    !isRecord(value) ||
    value["kind"] !== "flight" ||
    typeof value["throttle"] !== "number" ||
    !isVector(value["strafe"]) ||
    !isVector(value["rotation"])
  ) {
    return false;
  }
  const active = value["active"];
  const stabilize = value["stabilize"];
  const boost = value["boost"];
  const cruiseLock = value["cruiseLock"];
  const navLights = value["navLights"];
  const flashlight = value["flashlight"];
  return (
    (active === undefined || typeof active === "boolean") &&
    (stabilize === undefined || typeof stabilize === "boolean") &&
    (boost === undefined || typeof boost === "boolean") &&
    (cruiseLock === undefined || typeof cruiseLock === "boolean") &&
    (navLights === undefined || typeof navLights === "boolean") &&
    (flashlight === undefined || typeof flashlight === "boolean")
  );
}

function isVector(value: unknown): value is { x: number; y: number; z: number } {
  return (
    isRecord(value) &&
    typeof value["x"] === "number" &&
    typeof value["y"] === "number" &&
    typeof value["z"] === "number"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected stream error.";
}
