import { createLowpass } from "./synth/filters";
import { createNoiseBuffer } from "./synth/noise";
import type { EngineState } from "./types";

const TAU = 0.08; // smoothing time-constant (s) — kills zipper noise

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

const IDLE_GAIN = 0.0001;

export function engineDroneMasterGain(state: EngineState): number {
  const drive = clamp01(Math.abs(state.throttle));
  const heat = clamp01(state.heat / 100);
  const speed = clamp01(state.speed / 160);
  const heatWhine = clamp01((heat - 0.5) * 2);
  const cruise = state.cruiseLock ? 0.34 : 0;
  const activity = Math.max(drive, speed * 0.28, heatWhine * 0.35, cruise, state.boost ? 1 : 0);
  return activity < 0.02 ? IDLE_GAIN : 0.04 + activity * 0.46;
}

/** Persistent engine-drone voice: sub + saw + filtered-noise body + heat whine. */
export class EngineDrone {
  private readonly subOsc: OscillatorNode;
  private readonly sawOsc: OscillatorNode;
  private readonly whineOsc: OscillatorNode;
  private readonly noise: AudioBufferSourceNode;
  private readonly noiseLp: BiquadFilterNode;
  private readonly subGain: GainNode;
  private readonly sawGain: GainNode;
  private readonly whineGain: GainNode;
  private readonly bodyGain: GainNode;
  private readonly master: GainNode;
  private started = false;
  private lastState: EngineState = {
    throttle: 0,
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
    this.subGain.gain.value = 0.2;
    this.subOsc.connect(this.subGain);
    this.subGain.connect(this.master);

    this.sawOsc = ctx.createOscillator();
    this.sawOsc.type = "sawtooth";
    this.sawOsc.frequency.value = 44;
    this.sawGain = ctx.createGain();
    this.sawGain.gain.value = IDLE_GAIN;
    this.sawOsc.connect(this.sawGain);
    this.sawGain.connect(this.master);

    this.noise = ctx.createBufferSource();
    this.noise.buffer = createNoiseBuffer(ctx, 2, "brown");
    this.noise.loop = true;
    this.noiseLp = createLowpass(ctx, 240, 0.8);
    this.bodyGain = ctx.createGain();
    this.bodyGain.gain.value = 0.05;
    this.noise.connect(this.noiseLp);
    this.noiseLp.connect(this.bodyGain);
    this.bodyGain.connect(this.master);

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
    this.sawOsc.start(t);
    this.whineOsc.start(t);
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
    this.sawOsc.stop(end);
    this.whineOsc.stop(end);
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

    this.subOsc.frequency.setTargetAtTime(30 + drive * 26, t, TAU);
    this.sawOsc.frequency.setTargetAtTime(42 + drive * 120 + cruise * 18, t, TAU);
    this.noiseLp.frequency.setTargetAtTime(220 + drive * 3000, t, TAU);

    this.subGain.gain.setTargetAtTime(0.18 + drive * 0.28, t, TAU);
    this.sawGain.gain.setTargetAtTime(IDLE_GAIN + drive * 0.42, t, TAU);
    this.bodyGain.gain.setTargetAtTime(0.05 + drive * 0.45 * (1 - cruise * 0.4), t, TAU);

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
