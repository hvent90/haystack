import { applyAr } from "../synth/env";
import { createBandpass, createHighpass } from "../synth/filters";
import { createNoiseBuffer } from "../synth/noise";

/** A code-defined one-shot: how long it is and how to build its graph into `destination`. */
export interface OneShotRender {
  durationSeconds: number;
  build(ctx: BaseAudioContext, destination: AudioNode, startTime: number): void;
}

/** UI click: short band-passed white-noise transient with a fast attack/release. */
export const uiClick: OneShotRender = {
  durationSeconds: 0.08,
  build(ctx, destination, t0) {
    const source = ctx.createBufferSource();
    source.buffer = createNoiseBuffer(ctx, 0.08, "white");
    const band = createBandpass(ctx, 2200, 6);
    const high = createHighpass(ctx, 1200);
    const gain = ctx.createGain();
    source.connect(band);
    band.connect(high);
    high.connect(gain);
    gain.connect(destination);
    applyAr(gain.gain, t0, 0.002, 0.004, 0.05, 0.7);
    source.start(t0);
    source.stop(t0 + 0.08);
  },
};
