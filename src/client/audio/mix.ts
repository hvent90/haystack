import { BUS_NAMES, type BusName } from "./types";

export interface MixState {
  master: number;
  muted: boolean;
  buses: Record<BusName, number>;
}

const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);

export function defaultMix(): MixState {
  return {
    master: 0.8,
    muted: false,
    buses: { engine: 0.8, sfx: 0.9, ui: 0.6, alarm: 0.9 },
  };
}

export function setMaster(mix: MixState, value: number): MixState {
  return { ...mix, master: clamp01(value) };
}

export function setBus(mix: MixState, bus: BusName, value: number): MixState {
  return { ...mix, buses: { ...mix.buses, [bus]: clamp01(value) } };
}

export function setMuted(mix: MixState, muted: boolean): MixState {
  return { ...mix, muted };
}

export function serializeMix(mix: MixState): string {
  return JSON.stringify(mix);
}

export function deserializeMix(raw: string | null): MixState {
  const fallback = defaultMix();
  if (raw === null) {
    return fallback;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<MixState>;
    const parsedBuses = parsed.buses;
    const buses = BUS_NAMES.reduce<Record<BusName, number>>(
      (acc, bus) => {
        const candidate = parsedBuses?.[bus];
        acc[bus] = typeof candidate === "number" ? clamp01(candidate) : fallback.buses[bus];
        return acc;
      },
      { engine: 0, sfx: 0, ui: 0, alarm: 0 },
    );
    return {
      master: typeof parsed.master === "number" ? clamp01(parsed.master) : fallback.master,
      muted: typeof parsed.muted === "boolean" ? parsed.muted : fallback.muted,
      buses,
    };
  } catch {
    return fallback;
  }
}
