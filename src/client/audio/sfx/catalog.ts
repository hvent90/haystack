import { applyAr } from "../synth/env";
import { createBandpass, createHighpass, createLowpass } from "../synth/filters";
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

// uiHover — softer, shorter sibling of uiClick (UI family)
export const uiHover: OneShotRender = {
  durationSeconds: 0.05,
  build(ctx, destination, t0) {
    const src = ctx.createBufferSource();
    src.buffer = createNoiseBuffer(ctx, 0.05, "white");
    const band = createBandpass(ctx, 3200, 4);
    const high = createHighpass(ctx, 1800);
    const gain = ctx.createGain();
    src.connect(band);
    band.connect(high);
    high.connect(gain);
    gain.connect(destination);
    applyAr(gain.gain, t0, 0.002, 0.003, 0.04, 0.35);
    src.start(t0);
    src.stop(t0 + 0.05);
  },
};

// targetLock — rising two-blip (UI family): two short square blips, second higher
export const targetLock: OneShotRender = {
  durationSeconds: 0.22,
  build(ctx, destination, t0) {
    const blip = (start: number, freq: number): void => {
      const osc = ctx.createOscillator();
      osc.type = "square";
      osc.frequency.value = freq;
      const high = createHighpass(ctx, 600);
      const gain = ctx.createGain();
      osc.connect(high);
      high.connect(gain);
      gain.connect(destination);
      applyAr(gain.gain, start, 0.004, 0.02, 0.05, 0.4);
      osc.start(start);
      osc.stop(start + 0.09);
    };
    blip(t0, 880);
    blip(t0 + 0.11, 1320);
  },
};

// comms — soft single blip (UI family): sine + gentle env
export const comms: OneShotRender = {
  durationSeconds: 0.18,
  build(ctx, destination, t0) {
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(660, t0);
    osc.frequency.exponentialRampToValueAtTime(990, t0 + 0.12);
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(destination);
    applyAr(gain.gain, t0, 0.01, 0.04, 0.12, 0.3);
    osc.start(t0);
    osc.stop(t0 + 0.18);
  },
};

// chime — clean two-note tonal chime (UI family, docking/deploy)
export const chime: OneShotRender = {
  durationSeconds: 0.7,
  build(ctx, destination, t0) {
    const note = (start: number, freq: number, dur: number): void => {
      const osc = ctx.createOscillator();
      osc.type = "triangle";
      osc.frequency.value = freq;
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(destination);
      applyAr(gain.gain, start, 0.005, 0.05, dur, 0.4);
      osc.start(start);
      osc.stop(start + dur + 0.06);
    };
    note(t0, 587.33, 0.3); // D5
    note(t0 + 0.16, 880, 0.45); // A5
  },
};

// boost — upward noise-sweep whoosh + sub thump (ship mass, sfx bus)
export const boost: OneShotRender = {
  durationSeconds: 0.6,
  build(ctx, destination, t0) {
    // noise sweep
    const noise = ctx.createBufferSource();
    noise.buffer = createNoiseBuffer(ctx, 0.6, "white");
    const lp = createLowpass(ctx, 400, 1);
    lp.frequency.setValueAtTime(400, t0);
    lp.frequency.exponentialRampToValueAtTime(6000, t0 + 0.4);
    const nGain = ctx.createGain();
    noise.connect(lp);
    lp.connect(nGain);
    nGain.connect(destination);
    applyAr(nGain.gain, t0, 0.05, 0.15, 0.35, 0.5);
    noise.start(t0);
    noise.stop(t0 + 0.6);
    // sub thump
    const sub = ctx.createOscillator();
    sub.type = "sine";
    sub.frequency.setValueAtTime(70, t0);
    sub.frequency.exponentialRampToValueAtTime(45, t0 + 0.3);
    const sGain = ctx.createGain();
    sub.connect(sGain);
    sGain.connect(destination);
    applyAr(sGain.gain, t0, 0.01, 0.08, 0.25, 0.7);
    sub.start(t0);
    sub.stop(t0 + 0.5);
  },
};

// brake — short filtered-noise burst + descending tone (ship mass, sfx bus)
export const brake: OneShotRender = {
  durationSeconds: 0.35,
  build(ctx, destination, t0) {
    const noise = ctx.createBufferSource();
    noise.buffer = createNoiseBuffer(ctx, 0.35, "brown");
    const bp = createBandpass(ctx, 500, 1.2);
    const nGain = ctx.createGain();
    noise.connect(bp);
    bp.connect(nGain);
    nGain.connect(destination);
    applyAr(nGain.gain, t0, 0.005, 0.05, 0.25, 0.55);
    noise.start(t0);
    noise.stop(t0 + 0.35);
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(300, t0);
    osc.frequency.exponentialRampToValueAtTime(90, t0 + 0.25);
    const oGain = ctx.createGain();
    const lp = createLowpass(ctx, 1200, 0.7);
    osc.connect(lp);
    lp.connect(oGain);
    oGain.connect(destination);
    applyAr(oGain.gain, t0, 0.005, 0.04, 0.2, 0.4);
    osc.start(t0);
    osc.stop(t0 + 0.3);
  },
};

// scanHonk — big resonant low->high sweep (diegetic, sfx bus)
export const scanHonk: OneShotRender = {
  durationSeconds: 0.6,
  build(ctx, destination, t0) {
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(120, t0);
    osc.frequency.exponentialRampToValueAtTime(900, t0 + 0.45);
    const bp = createBandpass(ctx, 600, 8);
    bp.frequency.setValueAtTime(300, t0);
    bp.frequency.exponentialRampToValueAtTime(1800, t0 + 0.45);
    const gain = ctx.createGain();
    osc.connect(bp);
    bp.connect(gain);
    gain.connect(destination);
    applyAr(gain.gain, t0, 0.03, 0.3, 0.25, 0.5);
    osc.start(t0);
    osc.stop(t0 + 0.6);
  },
};
