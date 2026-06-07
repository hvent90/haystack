/**
 * Schedule an attack/hold/release envelope on a gain AudioParam.
 * Uses exponential ramps (cannot reach 0, so we floor at 0.0001) for click-free edges.
 */
export function applyAr(
  gain: AudioParam,
  startTime: number,
  attack: number,
  hold: number,
  release: number,
  peak = 1,
): void {
  const floor = 0.0001;
  gain.setValueAtTime(floor, startTime);
  gain.exponentialRampToValueAtTime(Math.max(peak, floor), startTime + attack);
  gain.setValueAtTime(Math.max(peak, floor), startTime + attack + hold);
  gain.exponentialRampToValueAtTime(floor, startTime + attack + hold + release);
}
