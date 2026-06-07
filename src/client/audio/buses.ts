import type { MixState } from "./mix";
import { BUS_NAMES, type BusName } from "./types";

export interface BusGraph {
  master: GainNode;
  buses: Record<BusName, GainNode>;
}

export function createBusGraph(ctx: AudioContext): BusGraph {
  const master = ctx.createGain();
  master.connect(ctx.destination);
  const make = (): GainNode => {
    const node = ctx.createGain();
    node.connect(master);
    return node;
  };
  return {
    master,
    buses: { engine: make(), sfx: make(), ui: make(), alarm: make() },
  };
}

export function applyMix(graph: BusGraph, mix: MixState): void {
  graph.master.gain.value = mix.muted ? 0 : mix.master;
  for (const bus of BUS_NAMES) {
    graph.buses[bus].gain.value = mix.buses[bus];
  }
}
