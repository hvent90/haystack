import { createLowpass } from "./synth/filters";
import { createNoiseBuffer } from "./synth/noise";
import type { EngineState } from "./types";

const TAU = 0.08; // smoothing time-constant (s) — kills zipper noise

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

const IDLE_GAIN = 0.0001;

// The high-pitched whine is the "strain" of actively thrusting while hot. It is NOT a
// constant heat readout — it lingers WHINE_HOLD seconds after the controls are released
// (so a quick burn still rings out) then fades over WHINE_RELEASE. The pleasant heat tone
// (below) is what sustains as the ongoing heat-score indicator.
const WHINE_HOLD = 2.0; // s the whine stays full after input stops
const WHINE_RELEASE = 0.6; // s the whine takes to fade once the hold expires
const INPUT_EPS = 0.02; // control magnitude below which we consider the stick released

export function engineDroneMasterGain(state: EngineState): number {
  const heat = clamp01(state.heat / 100);
  const speed = clamp01(state.speed / 160);
  const heatLevel = clamp01((heat - 0.5) * 2);
  const cruise = state.cruiseLock ? 0.34 : 0;
  // Main throttle AND strafe (translation RCS) are "regular thrusters" → the roar.
  // Rotation is handled by the separate air-nozzle voice, so it's excluded here.
  const thruster = Math.max(clamp01(Math.abs(state.throttle)), clamp01(state.rcs));
  // Thrusters get a strong audible floor: even a tiny minute-adjustment nudge jumps to
  // an audible bed instead of staying near-silent (was only loud at high thrust).
  const thrusterBed = thruster > 0.02 ? 0.14 + thruster * 0.38 : 0;
  // Non-thruster activity (coasting, heat, cruise, boost) stays a gentler bed. The heat term
  // keeps the master open while coasting hot so the sustained heat tone stays audible.
  const ambient = Math.max(speed * 0.28, heatLevel * 0.5, cruise, state.boost ? 1 : 0);
  const ambientBed = ambient > 0.02 ? 0.04 + ambient * 0.42 : 0;
  const level = Math.max(thrusterBed, ambientBed);
  return level < 0.02 ? IDLE_GAIN : level;
}

/** Persistent engine-drone voice: brown-noise roar body + sub weight + thrust LFO + heat voices. */
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
  private readonly output: AudioNode;
  // Pleasant sustained heat tone: two detuned sines (root + a fifth) through a lowpass with a
  // slow breathing tremolo. This is the continuous heat-score readout that replaced the
  // always-on abrasive whine.
  private readonly heatOsc: OscillatorNode;
  private readonly heatFifthOsc: OscillatorNode;
  private readonly heatFifthGain: GainNode;
  private readonly heatLp: BiquadFilterNode;
  private readonly heatGain: GainNode;
  private readonly heatTremOsc: OscillatorNode;
  private readonly heatTremDepth: GainNode;
  // Wall-clock (audio-context time) of the last frame with live control input, used to let the
  // whine ring out for WHINE_HOLD + WHINE_RELEASE after the stick is released.
  private lastInputTime = Number.NEGATIVE_INFINITY;
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
    this.output = output;

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

    // High-pitched whine — kept for the "strain" character, but now transient (see setState).
    this.whineOsc = ctx.createOscillator();
    this.whineOsc.type = "triangle";
    this.whineOsc.frequency.value = 2000;
    this.whineGain = ctx.createGain();
    this.whineGain.gain.value = IDLE_GAIN;
    this.whineOsc.connect(this.whineGain);
    this.whineGain.connect(this.master);

    // Pleasant sustained heat tone: warm root sine + a quieter fifth, lowpassed so it never
    // gets piercing, with a slow tremolo for a "breathing" alive feel. Routed straight to the
    // engine bus (NOT the thruster-driven master) so it reads as a steady heat-score indicator
    // that holds while coasting hot instead of dropping out the instant you release throttle.
    this.heatLp = createLowpass(ctx, 900, 0.7);
    this.heatGain = ctx.createGain();
    this.heatGain.gain.value = IDLE_GAIN;
    this.heatLp.connect(this.heatGain);
    this.heatGain.connect(this.output);

    this.heatOsc = ctx.createOscillator();
    this.heatOsc.type = "sine";
    this.heatOsc.frequency.value = 300;
    this.heatOsc.connect(this.heatLp);

    this.heatFifthOsc = ctx.createOscillator();
    this.heatFifthOsc.type = "sine";
    this.heatFifthOsc.frequency.value = 450;
    this.heatFifthGain = ctx.createGain();
    this.heatFifthGain.gain.value = 0.4;
    this.heatFifthOsc.connect(this.heatFifthGain);
    this.heatFifthGain.connect(this.heatLp);

    this.heatTremOsc = ctx.createOscillator();
    this.heatTremOsc.type = "sine";
    this.heatTremOsc.frequency.value = 2.6;
    this.heatTremDepth = ctx.createGain();
    this.heatTremDepth.gain.value = 0;
    this.heatTremOsc.connect(this.heatTremDepth);
    this.heatTremDepth.connect(this.heatGain.gain);
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
    this.heatOsc.start(t);
    this.heatFifthOsc.start(t);
    this.heatTremOsc.start(t);
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
    this.heatOsc.stop(end);
    this.heatFifthOsc.stop(end);
    this.heatTremOsc.stop(end);
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

    // Heat ramps in from the 50s up; both heat voices key off this curve.
    const heatLevel = clamp01((heat - 0.5) * 2);

    // The whine only sounds while you're actively on the controls (or within the last couple
    // seconds), so a hot burn rings out briefly after release instead of droning forever.
    const input = Math.max(drive, clamp01(state.rcs), clamp01(state.rotation));
    if (input > INPUT_EPS) {
      this.lastInputTime = t;
    }
    const since = t - this.lastInputTime;
    const whineActivity =
      since <= WHINE_HOLD ? 1 : clamp01(1 - (since - WHINE_HOLD) / WHINE_RELEASE);
    const whine = heatLevel * whineActivity;
    this.whineOsc.frequency.setTargetAtTime(1700 + heat * 1300, t, TAU);
    this.whineGain.gain.setTargetAtTime(IDLE_GAIN + whine * 0.09, t, TAU);

    // Pleasant sustained heat tone — the continuous heat-score readout. Root + fifth rise gently
    // with heat, the lowpass opens a touch, and the tremolo deepens so hotter = more "alive".
    const heatBase = 300 + heat * 150;
    this.heatOsc.frequency.setTargetAtTime(heatBase, t, TAU);
    this.heatFifthOsc.frequency.setTargetAtTime(heatBase * 1.5, t, TAU);
    this.heatLp.frequency.setTargetAtTime(900 + heatLevel * 900, t, TAU);
    this.heatGain.gain.setTargetAtTime(IDLE_GAIN + heatLevel * 0.14, t, TAU);
    this.heatTremDepth.gain.setTargetAtTime(heatLevel * 0.04, t, TAU);

    this.master.gain.setTargetAtTime(engineDroneMasterGain(state), t, TAU);
  }

  /** Momentary boost swell. */
  boost(at?: number): void {
    const t = at ?? this.ctx.currentTime;
    this.master.gain.setTargetAtTime(0.85, t, 0.02);
    this.master.gain.setTargetAtTime(engineDroneMasterGain(this.lastState), t + 0.18, 0.12);
  }
}
