import { createLowpass } from "./synth/filters";
import { createNoiseBuffer } from "./synth/noise";
import type { MixState } from "./mix";

const IDLE_GAIN = 0.0001;

/** Listener master volume for spatialized sources, derived from the engine bus mix. */
export function spatialMasterVolume(mix: MixState): number {
  return mix.muted ? 0 : mix.master * mix.buses.engine;
}

export interface SpatialDroneState {
  throttle: number;
  heat: number;
  speed: number;
}

const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);

export function spatialDroneGainForState(state: SpatialDroneState): number {
  const drive = clamp01(Math.abs(state.throttle));
  const speed = clamp01(state.speed / 120);
  const heat = clamp01(state.heat / 100);
  const activity = Math.max(drive, speed * 0.38, Math.max(0, heat - 0.65) * 0.8);
  return activity < 0.02 ? IDLE_GAIN : 0.03 + activity * 0.32;
}

export interface SpatialDrone {
  output: AudioNode;
  setState(state: SpatialDroneState): void;
  dispose(): void;
}

/**
 * Lightweight always-on engine voice for a remote ship: low saw + filtered brown
 * noise summed into a gain. Fed to a THREE.PositionalAudio via setNodeSource; the
 * panner handles distance/direction. Simpler than the local EngineDrone on purpose.
 */
export function createSpatialDrone(ctx: BaseAudioContext): SpatialDrone {
  const output = ctx.createGain();
  output.gain.value = IDLE_GAIN;

  const saw = ctx.createOscillator();
  saw.type = "sawtooth";
  saw.frequency.value = 68;
  const sawGain = ctx.createGain();
  sawGain.gain.value = 0.2;
  saw.connect(sawGain);
  sawGain.connect(output);

  const noise = ctx.createBufferSource();
  noise.buffer = createNoiseBuffer(ctx, 2, "brown");
  noise.loop = true;
  const lp = createLowpass(ctx, 480, 0.8);
  const noiseGain = ctx.createGain();
  noiseGain.gain.value = 0.28;
  noise.connect(lp);
  lp.connect(noiseGain);
  noiseGain.connect(output);

  saw.start();
  noise.start();

  return {
    output,
    setState(state): void {
      const t = ctx.currentTime;
      const drive = clamp01(Math.abs(state.throttle));
      const speed = clamp01(state.speed / 120);
      saw.frequency.setTargetAtTime(58 + Math.max(drive, speed) * 80, t, 0.12);
      lp.frequency.setTargetAtTime(320 + Math.max(drive, speed) * 1100, t, 0.12);
      output.gain.setTargetAtTime(spatialDroneGainForState(state), t, 0.12);
    },
    dispose(): void {
      try {
        saw.stop();
      } catch {
        // already stopped
      }
      try {
        noise.stop();
      } catch {
        // already stopped
      }
      output.disconnect();
    },
  };
}
