import { applyMix, createBusGraph, type BusGraph } from "./buses";
import { createAudioContext, unlock } from "./context";
import { defaultMix, type MixState } from "./mix";
import {
  boost,
  brake,
  chime,
  comms,
  scanHonk,
  targetLock,
  uiClick,
  uiHover,
  type OneShotRender,
} from "./sfx/catalog";
import { renderOneShot } from "./sfx/renderOneShot";
import type { BusName, OneShotId } from "./types";

interface OneShotEntry {
  spec: OneShotRender;
  bus: BusName;
}

/** Registry of implemented one-shots. Plan 2 extends this map. */
const ONE_SHOTS: Partial<Record<OneShotId, OneShotEntry>> = {
  uiClick: { spec: uiClick, bus: "ui" },
  uiHover: { spec: uiHover, bus: "ui" },
  targetLock: { spec: targetLock, bus: "ui" },
  comms: { spec: comms, bus: "ui" },
  chime: { spec: chime, bus: "ui" },
  boost: { spec: boost, bus: "sfx" },
  brake: { spec: brake, bus: "sfx" },
  scanHonk: { spec: scanHonk, bus: "sfx" },
};

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private graph: BusGraph | null = null;
  private mix: MixState;
  private readonly bank = new Map<OneShotId, AudioBuffer>();
  private ready = false;

  constructor(mix: MixState = defaultMix()) {
    this.mix = mix;
  }

  /** Create the context/graph and render the one-shot bank. Idempotent. */
  async init(): Promise<void> {
    if (this.ctx !== null) {
      return;
    }
    const ctx = createAudioContext();
    const graph = createBusGraph(ctx);
    applyMix(graph, this.mix);
    this.ctx = ctx;
    this.graph = graph;
    for (const [id, entry] of Object.entries(ONE_SHOTS) as [OneShotId, OneShotEntry][]) {
      this.bank.set(id, await renderOneShot(entry.spec));
    }
    this.ready = true;
  }

  /** Resume the context from a user gesture. */
  async unlock(): Promise<void> {
    if (this.ctx !== null) {
      await unlock(this.ctx);
    }
  }

  setMix(mix: MixState): void {
    this.mix = mix;
    if (this.graph !== null) {
      applyMix(this.graph, mix);
    }
  }

  getMix(): MixState {
    return this.mix;
  }

  /** Fire a one-shot through its bus with a short-lived buffer source. */
  playOneShot(id: OneShotId): void {
    if (!this.ready || this.ctx === null || this.graph === null) {
      return;
    }
    const entry = ONE_SHOTS[id];
    const buffer = this.bank.get(id);
    if (entry === undefined || buffer === undefined) {
      return;
    }
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.graph.buses[entry.bus]);
    source.start();
    source.onended = () => source.disconnect();
  }

  dispose(): void {
    void this.ctx?.close();
    this.ctx = null;
    this.graph = null;
    this.ready = false;
    this.bank.clear();
  }
}
