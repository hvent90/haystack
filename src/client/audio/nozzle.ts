import { createBandpass, createHighpass, createLowpass } from "./synth/filters";
import { createNoiseBuffer } from "./synth/noise";
import type { EngineState } from "./types";

// Smoothed onsets so rapid small adjustments blend into a soft "pff" instead of
// machine-gunning harsh clicks.
const TAU = 0.06;
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Attitude (rotation) thruster activity drives the nozzle. Strafe is handled by the
 * engine roar so it sounds like a regular thruster; only rotation gets the air-nozzle. */
function nozzleActivity(state: EngineState): number {
  return clamp01(state.rotation);
}

export function rcsNozzleGain(state: EngineState): number {
  const activity = nozzleActivity(state);
  return activity < 0.02 ? 0 : 0.11 + activity * 0.42;
}

/**
 * RCS air-nozzle voice: a soft filtered-noise "pff" for the attitude thrusters.
 * Pink (not white) noise + a low gentle formant + a lowpass roll-off keep it warm and
 * semi-pleasant during lots of small adjustments, rather than a sizzly high-band hiss.
 */
export class RcsNozzle {
  private readonly noise: AudioBufferSourceNode;
  private readonly hp: BiquadFilterNode;
  private readonly bp: BiquadFilterNode;
  private readonly lp: BiquadFilterNode;
  private readonly lfoOsc: OscillatorNode;
  private readonly lfoDepth: GainNode;
  private readonly master: GainNode;
  private started = false;

  constructor(
    private readonly ctx: BaseAudioContext,
    output: AudioNode,
  ) {
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.master.connect(output);

    // Pink noise: airy but with a softer top end than white — far less abrasive.
    this.noise = ctx.createBufferSource();
    this.noise.buffer = createNoiseBuffer(ctx, 2, "pink");
    this.noise.loop = true;
    this.hp = createHighpass(ctx, 320, 0.7); // keep a little warmth, not a thin hiss
    this.bp = createBandpass(ctx, 700, 0.7); // low, gentle nozzle formant
    this.lp = createLowpass(ctx, 2000, 0.7); // roll off the abrasive sizzle on top
    this.noise.connect(this.hp);
    this.hp.connect(this.bp);
    this.bp.connect(this.lp);
    this.lp.connect(this.master);

    // Gentle flutter so it reads as soft turbulent gas, not flat static or a buzz.
    this.lfoOsc = ctx.createOscillator();
    this.lfoOsc.type = "sine";
    this.lfoOsc.frequency.value = 9;
    this.lfoDepth = ctx.createGain();
    this.lfoDepth.gain.value = 0;
    this.lfoOsc.connect(this.lfoDepth);
    this.lfoDepth.connect(this.master.gain);
  }

  start(at?: number): void {
    if (this.started) {
      return;
    }
    const t = at ?? this.ctx.currentTime;
    this.noise.start(t);
    this.lfoOsc.start(t);
    this.started = true;
  }

  stop(at?: number): void {
    if (!this.started) {
      return;
    }
    const t = at ?? this.ctx.currentTime;
    this.master.gain.setTargetAtTime(0, t, TAU);
    const end = t + 0.3;
    this.noise.stop(end);
    this.lfoOsc.stop(end);
    this.started = false;
  }

  setState(state: EngineState, at?: number): void {
    const t = at ?? this.ctx.currentTime;
    const activity = nozzleActivity(state);
    // Harder maneuvers open the formant a little brighter, but stay in a warm band.
    this.bp.frequency.setTargetAtTime(650 + activity * 650, t, TAU);
    this.lp.frequency.setTargetAtTime(1800 + activity * 1000, t, TAU);
    const level = rcsNozzleGain(state);
    this.master.gain.setTargetAtTime(level, t, TAU);
    // Flutter depth tracks activity so silence stays silent.
    this.lfoDepth.gain.setTargetAtTime(activity * 0.04, t, TAU);
  }
}
