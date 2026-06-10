// Debug-gated instrumentation for owned-ship prediction cadence. OFF by default and
// effectively free when off (one boolean check per call). Lets the owner confirm the
// jerk fix on a real WebGPU machine, where the headless build cannot run.
//
// In the browser console:
//   __predictionDebug.enable()      // start sampling
//   __predictionDebug.report()      // { timerHz, predictedStepsPerSec, correctionsPerSec, maxFireGapMs }
//   __predictionDebug.disable()
//
// What to look for: under main-thread contention the input TIMER drops below 60Hz
// (timerHz < 60, maxFireGapMs > 17), but with the elapsed-time accumulator
// predictedStepsPerSec stays ~60 and correctionsPerSec stays ~0. Before the fix,
// predictedStepsPerSec tracked timerHz and correctionsPerSec spiked with the deficit.

class PredictionDebug {
  private enabled = false;
  private windowStartMs = 0;
  private fires = 0;
  private predictedSteps = 0;
  private corrections = 0;
  private lastFireMs = 0;
  private maxFireGapMs = 0;

  enable(): void {
    this.enabled = true;
    this.resetWindow(now());
    this.lastFireMs = 0;
  }

  disable(): void {
    this.enabled = false;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** Record one input-timer fire that drained `steps` fixed prediction steps. */
  noteFire(steps: number): void {
    if (!this.enabled) {
      return;
    }
    const t = now();
    if (this.lastFireMs !== 0) {
      this.maxFireGapMs = Math.max(this.maxFireGapMs, t - this.lastFireMs);
    }
    this.lastFireMs = t;
    this.fires += 1;
    this.predictedSteps += steps;
  }

  /** Record one reconcile correction (predicted pose disagreed with the server ack). */
  noteCorrection(): void {
    if (this.enabled) {
      this.corrections += 1;
    }
  }

  /** Per-wall-second rates over the window since the last report(), then reset. */
  report(): {
    windowSec: number;
    timerHz: number;
    predictedStepsPerSec: number;
    correctionsPerSec: number;
    maxFireGapMs: number;
  } {
    const t = now();
    const windowSec = Math.max(1e-3, (t - this.windowStartMs) / 1000);
    const out = {
      windowSec: round(windowSec, 2),
      timerHz: round(this.fires / windowSec, 1),
      predictedStepsPerSec: round(this.predictedSteps / windowSec, 1),
      correctionsPerSec: round(this.corrections / windowSec, 1),
      maxFireGapMs: round(this.maxFireGapMs, 1),
    };
    this.resetWindow(t);
    return out;
  }

  private resetWindow(t: number): void {
    this.windowStartMs = t;
    this.fires = 0;
    this.predictedSteps = 0;
    this.corrections = 0;
    this.maxFireGapMs = 0;
  }
}

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : 0;
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

export const predictionDebug = new PredictionDebug();

if (typeof window !== "undefined") {
  (window as unknown as { __predictionDebug?: PredictionDebug }).__predictionDebug =
    predictionDebug;
}
