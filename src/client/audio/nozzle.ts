import { createBandpass, createHighpass, createLowpass } from "./synth/filters";
import { createNoiseBuffer } from "./synth/noise";
import type { EngineState } from "./types";

// Asymmetric onset: a slow rise lets micro-corrections swell in softly instead of
// machine-gunning clicks, while a quick fall keeps it from smearing into silence.
const TAU_RISE = 0.12;
const TAU_FALL = 0.05;
const TAU_FILTER = 0.1;

// Adaptive ducking: while a sustained aim is held, the level slowly settles ~18%
// (ear-adaptation) and recovers when idle, so constant aiming fades to the background.
const ADAPT_TAU = 1.0;
const DUCK_FLOOR = 0.82;

// Organic, non-periodic flutter depth at full activity (replaces the old 9 Hz sine).
const FLUTTER_DEPTH = 0.12;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Attitude (rotation) thruster activity drives the nozzle. Strafe is handled by the
 * engine roar so it sounds like a regular thruster; only rotation gets the air-nozzle. */
function nozzleActivity(state: EngineState): number {
  return clamp01(state.rotation);
}

/**
 * Base steady level for the nozzle (before adaptive ducking + flutter, which are
 * applied live in {@link RcsNozzle.setState}). A gentle power curve keeps tiny aiming
 * nudges to a whisper instead of snapping to a fixed floor, so constant mouse
 * adjustments stay pleasant rather than fatiguing.
 */
export function rcsNozzleGain(state: EngineState): number {
  const activity = nozzleActivity(state);
  if (activity < 0.02) return 0;
  const shaped = Math.pow(activity, 1.6);
  return 0.04 + shaped * 0.34;
}

/**
 * RCS air-nozzle voice: a soft filtered-noise "pff" for the attitude thrusters.
 * Pink noise through a warm, dark band (low formant + lowpass + high-shelf cut)
 * with organic random flutter, a gentle perceptual gain curve, ear-adaptation
 * ducking, and a quiet sub body — tuned to be pleasant during the constant small
 * adjustments the player makes while aiming, rather than a sizzly hiss.
 */
export class RcsNozzle {
  private readonly noise: AudioBufferSourceNode;
  private readonly hp: BiquadFilterNode;
  private readonly bp: BiquadFilterNode;
  private readonly lp: BiquadFilterNode;
  private readonly shelf: BiquadFilterNode;
  private readonly master: GainNode;

  // Organic flutter: brown noise cascaded through two slow lowpasses → a smooth
  // random control signal added onto the master gain (no periodic buzz).
  private readonly flutterNoise: AudioBufferSourceNode;
  private readonly flutterDepth: GainNode;

  // Sub-160 Hz pneumatic body so it reads as gas, not pure hiss.
  private readonly body: AudioBufferSourceNode;
  private readonly bodyGain: GainNode;

  private started = false;
  private adapt = 1;
  private lastTime: number | null = null;
  private lastLevel = 0;

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
    this.hp = createHighpass(ctx, 280, 0.7); // keep a little warmth, not a thin hiss
    this.bp = createBandpass(ctx, 600, 0.7); // low, gentle nozzle formant
    this.lp = createLowpass(ctx, 1100, 0.7); // dark roll-off — no 2 kHz sizzle
    this.shelf = ctx.createBiquadFilter();
    this.shelf.type = "highshelf";
    this.shelf.frequency.value = 2500;
    this.shelf.gain.value = -14; // tame any residual top-end fatigue
    this.noise.connect(this.hp);
    this.hp.connect(this.bp);
    this.bp.connect(this.lp);
    this.lp.connect(this.shelf);
    this.shelf.connect(this.master);

    // Organic flutter — brown noise lowpassed twice to a slow random wander.
    this.flutterNoise = ctx.createBufferSource();
    this.flutterNoise.buffer = createNoiseBuffer(ctx, 3, "brown");
    this.flutterNoise.loop = true;
    const flutterLp1 = createLowpass(ctx, 10, 0.7);
    const flutterLp2 = createLowpass(ctx, 10, 0.7);
    this.flutterDepth = ctx.createGain();
    this.flutterDepth.gain.value = 0;
    this.flutterNoise.connect(flutterLp1);
    flutterLp1.connect(flutterLp2);
    flutterLp2.connect(this.flutterDepth);
    this.flutterDepth.connect(this.master.gain);

    // Quiet sub-160 Hz pneumatic body, on its own gentle gain to the same output.
    this.body = ctx.createBufferSource();
    this.body.buffer = createNoiseBuffer(ctx, 2, "pink");
    this.body.loop = true;
    const bodyLp = createLowpass(ctx, 160, 0.8);
    this.bodyGain = ctx.createGain();
    this.bodyGain.gain.value = 0;
    this.body.connect(bodyLp);
    bodyLp.connect(this.bodyGain);
    this.bodyGain.connect(output);
  }

  start(at?: number): void {
    if (this.started) {
      return;
    }
    const t = at ?? this.ctx.currentTime;
    this.noise.start(t);
    this.flutterNoise.start(t);
    this.body.start(t);
    this.started = true;
  }

  stop(at?: number): void {
    if (!this.started) {
      return;
    }
    const t = at ?? this.ctx.currentTime;
    this.master.gain.setTargetAtTime(0, t, TAU_FALL);
    this.flutterDepth.gain.setTargetAtTime(0, t, TAU_FALL);
    this.bodyGain.gain.setTargetAtTime(0, t, TAU_FALL);
    const end = t + 0.3;
    this.noise.stop(end);
    this.flutterNoise.stop(end);
    this.body.stop(end);
    this.started = false;
  }

  setState(state: EngineState, at?: number): void {
    const t = at ?? this.ctx.currentTime;
    const activity = nozzleActivity(state);
    const shaped = Math.pow(activity, 1.6);

    // Ear-adaptation ducking: integrate toward a duck floor while aim is sustained,
    // recover toward unity when idle. Works for both live frames and scheduled `at`.
    if (this.lastTime !== null && t > this.lastTime) {
      const dt = t - this.lastTime;
      const target = activity > 0.05 ? DUCK_FLOOR : 1;
      this.adapt += (target - this.adapt) * (1 - Math.exp(-dt / ADAPT_TAU));
    }
    this.lastTime = t;

    // Harder maneuvers open the formant a little brighter, but stay in a warm band.
    this.bp.frequency.setTargetAtTime(560 + shaped * 500, t, TAU_FILTER);
    this.lp.frequency.setTargetAtTime(1100 + shaped * 500, t, TAU_FILTER);

    const level = rcsNozzleGain(state) * this.adapt;
    // Slow rise so micro-corrections swell; quick fall so they don't smear.
    this.master.gain.setTargetAtTime(level, t, level >= this.lastLevel ? TAU_RISE : TAU_FALL);
    this.lastLevel = level;

    // Flutter + body track activity so silence stays silent.
    this.flutterDepth.gain.setTargetAtTime(activity * FLUTTER_DEPTH, t, TAU_FILTER);
    this.bodyGain.gain.setTargetAtTime(shaped * 0.12 * this.adapt, t, TAU_RISE);
  }
}
