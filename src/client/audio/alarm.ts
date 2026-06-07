import { applyAr } from "./synth/env";
import { LookaheadScheduler } from "./scheduler";

/** Repeating overheat alarm: scheduled two-tone beeps while active. */
export class AlarmVoice {
  private readonly scheduler: LookaheadScheduler;
  private beat = 0;
  private active = false;

  constructor(
    private readonly ctx: AudioContext,
    private readonly output: AudioNode,
  ) {
    this.scheduler = new LookaheadScheduler(ctx, 0.4, (time) => this.beep(time));
  }

  setActive(active: boolean): void {
    if (active === this.active) {
      return;
    }
    this.active = active;
    if (active) {
      this.scheduler.start();
    } else {
      this.scheduler.stop();
    }
  }

  private beep(time: number): void {
    const osc = this.ctx.createOscillator();
    osc.type = "square";
    osc.frequency.value = this.beat % 2 === 0 ? 740 : 560;
    this.beat += 1;
    const gain = this.ctx.createGain();
    osc.connect(gain);
    gain.connect(this.output);
    applyAr(gain.gain, time, 0.005, 0.08, 0.1, 0.3);
    osc.start(time);
    osc.stop(time + 0.22);
  }
}
