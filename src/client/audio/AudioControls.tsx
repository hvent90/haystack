import type { ReactNode } from "react";

import { setBus, setMaster, setMuted, type MixState } from "./mix";
import { BUS_NAMES, type BusName } from "./types";

interface AudioControlsProps {
  mix: MixState;
  unlocked: boolean;
  onChange: (next: MixState) => void;
}

const BUS_LABEL: Record<BusName, string> = {
  engine: "Engine",
  sfx: "SFX",
  ui: "UI",
  alarm: "Alarm",
};

export function AudioControls({ mix, unlocked, onChange }: AudioControlsProps): ReactNode {
  return (
    <section className="audio-controls" data-testid="audio-controls">
      <header className="audio-controls__head">
        <span>Audio</span>
        <button
          type="button"
          data-testid="audio-mute"
          aria-pressed={mix.muted}
          onClick={() => onChange(setMuted(mix, !mix.muted))}
        >
          {mix.muted ? "Unmute" : "Mute"}
        </button>
      </header>
      {!unlocked ? <p className="audio-controls__hint">Audio off — click to enable</p> : null}
      <label className="audio-controls__row">
        <span>Master</span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={mix.master}
          data-testid="audio-master"
          onChange={(event) => onChange(setMaster(mix, Number(event.target.value)))}
        />
      </label>
      {BUS_NAMES.map((bus) => (
        <label className="audio-controls__row" key={bus}>
          <span>{BUS_LABEL[bus]}</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={mix.buses[bus]}
            data-testid={`audio-bus-${bus}`}
            onChange={(event) => onChange(setBus(mix, bus, Number(event.target.value)))}
          />
        </label>
      ))}
    </section>
  );
}
