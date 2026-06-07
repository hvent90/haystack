/** Beat times in [fromTime, untilTime) aligned to `interval` (epsilon-guarded). */
export function nextBeatTimes(
  fromTime: number,
  untilTime: number,
  interval: number,
  phase = 0,
): number[] {
  if (interval <= 0) {
    return [];
  }
  const eps = interval * 1e-6;
  const k = Math.ceil((fromTime - phase) / interval - eps);
  const beats: number[] = [];
  for (let n = k; ; n += 1) {
    const t = phase + n * interval;
    if (t >= untilTime - eps) {
      break;
    }
    if (t >= fromTime - eps) {
      beats.push(Number(t.toFixed(10)));
    }
  }
  return beats;
}

/**
 * Lookahead scheduler ("A Tale of Two Clocks"): a setTimeout loop (lookahead ~25ms)
 * that schedules beat callbacks ~100ms ahead against AudioContext.currentTime.
 */
export class LookaheadScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private nextFrom = 0;

  constructor(
    private readonly ctx: AudioContext,
    private readonly interval: number,
    private readonly onBeat: (time: number) => void,
    private readonly lookahead = 0.1,
    private readonly tickMs = 25,
  ) {}

  start(): void {
    if (this.timer !== null) {
      return;
    }
    this.nextFrom = this.ctx.currentTime;
    this.timer = setInterval(() => {
      const until = this.ctx.currentTime + this.lookahead;
      for (const time of nextBeatTimes(this.nextFrom, until, this.interval)) {
        this.onBeat(time);
      }
      this.nextFrom = until;
    }, this.tickMs);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
