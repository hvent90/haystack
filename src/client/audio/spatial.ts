import { createLowpass } from "./synth/filters";
import { createNoiseBuffer } from "./synth/noise";
import type { MixState } from "./mix";

/** Listener master volume for spatialized sources, derived from the engine bus mix. */
export function spatialMasterVolume(mix: MixState): number {
  return mix.muted ? 0 : mix.master * mix.buses.engine;
}

export interface SpatialDrone {
  output: AudioNode;
  dispose(): void;
}

/**
 * Lightweight always-on engine voice for a remote ship: low saw + filtered brown
 * noise summed into a gain. Fed to a THREE.PositionalAudio via setNodeSource; the
 * panner handles distance/direction. Simpler than the local EngineDrone on purpose.
 */
export function createSpatialDrone(ctx: BaseAudioContext): SpatialDrone {
  const output = ctx.createGain();
  output.gain.value = 0.6;

  const saw = ctx.createOscillator();
  saw.type = "sawtooth";
  saw.frequency.value = 68;
  const sawGain = ctx.createGain();
  sawGain.gain.value = 0.25;
  saw.connect(sawGain);
  sawGain.connect(output);

  const noise = ctx.createBufferSource();
  noise.buffer = createNoiseBuffer(ctx, 2, "brown");
  noise.loop = true;
  const lp = createLowpass(ctx, 480, 0.8);
  const noiseGain = ctx.createGain();
  noiseGain.gain.value = 0.5;
  noise.connect(lp);
  lp.connect(noiseGain);
  noiseGain.connect(output);

  saw.start();
  noise.start();

  return {
    output,
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
