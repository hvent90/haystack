import { createBandpass, createLowpass } from "./synth/filters";
import { createNoiseBuffer } from "./synth/noise";

const TAU = 0.06;

/** Continuous mining laser: gritty bandpassed saw + sub, gated on/off. */
export class MiningVoice {
  private readonly saw: OscillatorNode;
  private readonly sub: OscillatorNode;
  private readonly bp: BiquadFilterNode;
  private readonly gain: GainNode;
  private started = false;

  constructor(ctx: BaseAudioContext, output: AudioNode) {
    this.gain = ctx.createGain();
    this.gain.gain.value = 0.0001;
    this.gain.connect(output);

    this.saw = ctx.createOscillator();
    this.saw.type = "sawtooth";
    this.saw.frequency.value = 116;
    this.bp = createBandpass(ctx, 900, 3);
    this.saw.connect(this.bp);
    this.bp.connect(this.gain);

    this.sub = ctx.createOscillator();
    this.sub.type = "sine";
    this.sub.frequency.value = 58;
    const subGain = ctx.createGain();
    subGain.gain.value = 0.5;
    this.sub.connect(subGain);
    subGain.connect(this.gain);

    this.saw.start();
    this.sub.start();
  }

  setActive(active: boolean, at?: number): void {
    const t = at ?? (this.gain.context.currentTime as number);
    this.gain.gain.setTargetAtTime(active ? 0.4 : 0.0001, t, TAU);
    this.started = active;
  }

  get active(): boolean {
    return this.started;
  }
}

/** Low ambient bed: very-low looped brown noise, always on at low level. */
export class AmbienceVoice {
  private readonly noise: AudioBufferSourceNode;
  private readonly gain: GainNode;

  constructor(ctx: BaseAudioContext, output: AudioNode) {
    this.noise = ctx.createBufferSource();
    this.noise.buffer = createNoiseBuffer(ctx, 3, "brown");
    this.noise.loop = true;
    const lp = createLowpass(ctx, 120, 0.7);
    this.gain = ctx.createGain();
    this.gain.gain.value = 0.0001;
    this.noise.connect(lp);
    lp.connect(this.gain);
    this.gain.connect(output);
  }

  start(at?: number): void {
    const t = at ?? (this.gain.context.currentTime as number);
    this.noise.start(t);
    this.gain.gain.setTargetAtTime(0.12, t, 0.5);
  }
}
