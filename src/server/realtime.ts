import { randomUUID } from "node:crypto";

import type { WSContext, WSMessageReceive } from "hono/ws";

import type {
  Ship,
  ThrustCommand,
  WorldSnapshot,
  WorldSnapshotKey,
  WorldSnapshotPatch,
  WorldStreamClientMessage,
  WorldStreamServerMessage,
} from "../shared/types";
import { getPilot, getSnapshot } from "./sim";
import type { ServerWorld } from "./world";

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

  constructor(private readonly world: ServerWorld) {}

  start(hz = 8): void {
    if (this.timer !== null) {
      return;
    }
    this.timer = setInterval(() => this.publishAll(), Math.max(50, 1000 / hz));
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
    return peer.id;
  }

  close(peerId: string): void {
    this.peers.delete(peerId);
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

    this.world.advanceToNow();
    this.currentTick += 1;
    for (const peer of this.peers.values()) {
      this.flushPeer(peer);
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
    const snapshot = getSnapshot(this.world.db, pilotId);
    storeShadow(peer, snapshot);
    this.send(peer, {
      type: "hello",
      protocol: "haystack.world.v1",
      peerId: peer.id,
      tick: this.currentTick,
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

    const ship = this.world.applyThrust(message.pilotId, message.command);
    this.currentTick += 1;
    this.sendAck(peer, message.clientTick, ship);
    for (const nextPeer of this.peers.values()) {
      this.flushPeer(nextPeer);
    }
  }

  private sendAck(peer: WorldPeer, clientTick: number, ship: Ship): void {
    this.send(peer, {
      type: "ack",
      tick: this.currentTick,
      clientTick,
      ship,
    });
  }

  private flushPeer(peer: WorldPeer): void {
    if (peer.ws.readyState !== 1) {
      this.close(peer.id);
      return;
    }

    const snapshot = getSnapshot(this.world.db, peer.pilotId);
    const changed = collectChangedKeys(peer, snapshot);
    storeShadow(peer, snapshot);
    if (changed.length === 0) {
      return;
    }

    this.send(peer, {
      type: "delta",
      tick: this.currentTick,
      changed,
      patch: createPatch(snapshot, changed),
    });
  }

  private send(peer: WorldPeer, message: WorldStreamServerMessage): void {
    if (peer.ws.readyState === 1) {
      peer.ws.send(JSON.stringify(message));
    }
  }
}

function collectChangedKeys(peer: WorldPeer, snapshot: WorldSnapshot): WorldSnapshotKey[] {
  return replicatedKeys.filter(
    (key) => peer.shadowHashes.get(key) !== hashSnapshotKey(snapshot, key),
  );
}

function storeShadow(peer: WorldPeer, snapshot: WorldSnapshot): void {
  for (const key of worldSnapshotKeys) {
    peer.shadowHashes.set(key, hashSnapshotKey(snapshot, key));
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
      isThrustCommand(value["command"])
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

function isThrustCommand(value: unknown): value is ThrustCommand {
  if (!isRecord(value) || !isVector(value["impulse"])) {
    return false;
  }
  const stabilize = value["stabilize"];
  return stabilize === undefined || typeof stabilize === "boolean";
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
