import { createLowpass } from "./synth/filters";
import { createNoiseBuffer } from "./synth/noise";
import type { EngineState } from "./types";

const TAU = 0.08; // smoothing time-constant (s) — kills zipper noise

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

const IDLE_GAIN = 0.0001;

export function engineDroneMasterGain(state: EngineState): number {
  const heat = clamp01(state.heat / 100);
  const speed = clamp01(state.speed / 160);
  const heatWhine = clamp01((heat - 0.5) * 2);
  const cruise = state.cruiseLock ? 0.34 : 0;
  // Main throttle AND strafe (translation RCS) are "regular thrusters" → the roar.
  // Rotation is handled by the separate air-nozzle voice, so it's excluded here.
  const thruster = Math.max(clamp01(Math.abs(state.throttle)), clamp01(state.rcs));
  // Thrusters get a strong audible floor: even a tiny minute-adjustment nudge jumps to
  // an audible bed instead of staying near-silent (was only loud at high thrust).
  const thrusterBed = thruster > 0.02 ? 0.14 + thruster * 0.38 : 0;
  // Non-thruster activity (coasting, heat, cruise, boost) stays a gentler bed.
  const ambient = Math.max(speed * 0.28, heatWhine * 0.35, cruise, state.boost ? 1 : 0);
  const ambientBed = ambient > 0.02 ? 0.04 + ambient * 0.42 : 0;
  const level = Math.max(thrusterBed, ambientBed);
  return level < 0.02 ? IDLE_GAIN : level;
}

/** Persistent engine-drone voice: brown-noise roar body + sub weight + thrust LFO + heat whine. */
export class EngineDrone {
  private readonly subOsc: OscillatorNode;
  private readonly whineOsc: OscillatorNode;
  private readonly lfoOsc: OscillatorNode;
  private readonly noise: AudioBufferSourceNode;
  private readonly noiseLp: BiquadFilterNode;
  private readonly subGain: GainNode;
  private readonly whineGain: GainNode;
  private readonly bodyGain: GainNode;
  private readonly lfoDepth: GainNode;
  private readonly master: GainNode;
  private started = false;
  private lastState: EngineState = {
    throttle: 0,
    rcs: 0,
    rotation: 0,
    boost: false,
    heat: 0,
    cruiseLock: false,
    speed: 0,
  };

  constructor(
    private readonly ctx: BaseAudioContext,
    output: AudioNode,
  ) {
    this.master = ctx.createGain();
    this.master.gain.value = IDLE_GAIN;
    this.master.connect(output);

    this.subOsc = ctx.createOscillator();
    this.subOsc.type = "sine";
    this.subOsc.frequency.value = 32;
    this.subGain = ctx.createGain();
    this.subGain.gain.value = 0.18;
    this.subOsc.connect(this.subGain);
    this.subGain.connect(this.master);

    // Brown-noise roar is the primary voice (was a thin 0.05 layer under the saw).
    this.noise = ctx.createBufferSource();
    this.noise.buffer = createNoiseBuffer(ctx, 2, "brown");
    this.noise.loop = true;
    this.noiseLp = createLowpass(ctx, 200, 0.9);
    this.bodyGain = ctx.createGain();
    this.bodyGain.gain.value = 0.05;
    this.noise.connect(this.noiseLp);
    this.noiseLp.connect(this.bodyGain);
    this.bodyGain.connect(this.master);

    // Subtle amplitude throb whose depth scales with thrust — see setState.
    this.lfoOsc = ctx.createOscillator();
    this.lfoOsc.type = "sine";
    this.lfoOsc.frequency.value = 6;
    this.lfoDepth = ctx.createGain();
    this.lfoDepth.gain.value = 0;
    this.lfoOsc.connect(this.lfoDepth);
    this.lfoDepth.connect(this.bodyGain.gain);

    this.whineOsc = ctx.createOscillator();
    this.whineOsc.type = "triangle";
    this.whineOsc.frequency.value = 2200;
    this.whineGain = ctx.createGain();
    this.whineGain.gain.value = IDLE_GAIN;
    this.whineOsc.connect(this.whineGain);
    this.whineGain.connect(this.master);
  }

  /** Start oscillators/noise and fade the master in. `at` defaults to now. */
  start(at?: number): void {
    if (this.started) {
      return;
    }
    const t = at ?? this.ctx.currentTime;
    this.subOsc.start(t);
    this.whineOsc.start(t);
    this.lfoOsc.start(t);
    this.noise.start(t);
    this.started = true;
  }

  stop(at?: number): void {
    if (!this.started) {
      return;
    }
    const t = at ?? this.ctx.currentTime;
    this.master.gain.setTargetAtTime(IDLE_GAIN, t, TAU);
    const end = t + 0.4;
    this.subOsc.stop(end);
    this.whineOsc.stop(end);
    this.lfoOsc.stop(end);
    this.noise.stop(end);
    this.started = false;
  }

  /** Map game state onto the voice with smoothing. */
  setState(state: EngineState, at?: number): void {
    const t = at ?? this.ctx.currentTime;
    this.lastState = state;
    const drive = clamp01(Math.abs(state.throttle));
    const heat = clamp01(state.heat / 100);
    const cruise = state.cruiseLock ? 1 : 0;
    // Throttle and strafe both fire "regular thrusters" → the roar responds to either.
    const thruster = Math.max(drive, clamp01(state.rcs));

    this.subOsc.frequency.setTargetAtTime(30 + drive * 26, t, TAU);
    this.noiseLp.frequency.setTargetAtTime(180 + thruster * 920, t, TAU);

    this.subGain.gain.setTargetAtTime(0.16 + thruster * 0.24, t, TAU);
    // Brown body carries the roar, with an audible floor as soon as any thruster fires.
    const body = thruster > 0.01 ? 0.25 + thruster * 0.6 : 0.05;
    this.bodyGain.gain.setTargetAtTime(body * (1 - cruise * 0.3), t, TAU);

    // Subtle throb: depth scales QUADRATICALLY with thrust so minute adjustments stay
    // clean and the modulation only emerges as a power "churn" near full burn.
    this.lfoDepth.gain.setTargetAtTime(thruster * thruster * 0.12, t, TAU);

    const whine = clamp01((heat - 0.5) * 2);
    this.whineOsc.frequency.setTargetAtTime(1800 + heat * 1600, t, TAU);
    this.whineGain.gain.setTargetAtTime(IDLE_GAIN + whine * 0.12, t, TAU);
    this.master.gain.setTargetAtTime(engineDroneMasterGain(state), t, TAU);
  }

  /** Momentary boost swell. */
  boost(at?: number): void {
    const t = at ?? this.ctx.currentTime;
    this.master.gain.setTargetAtTime(0.85, t, 0.02);
    this.master.gain.setTargetAtTime(engineDroneMasterGain(this.lastState), t + 0.18, 0.12);
  }
}
