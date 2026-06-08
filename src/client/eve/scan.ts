import { clamp } from "./vector";

// One-shot "scanning" pulse: a shell that expands outward from the player (who sits at the
// scene origin), highlighting object edges as it passes. Triggered manually for now; later
// it will be driven by a gameplay system.
export const scanPulseDurationSeconds = 1.6;
export const scanPulseMaxRadius = 14; // scene units (~14 km) the shell travels before fading
export const scanColor = "#7de5d8";
export const scanShellThickness = 2.4; // scene-unit half-width of the bright shell band
export const scanStrength = 1.0; // overall additive intensity at the envelope peak
// Contrast on the facing term: faces whose normal points straight at the camera glow brightest,
// grazing faces fade out. Higher = tighter highlight on the most head-on facets.
export const scanFacingPower = 1.5;

// Normalized progress through the pulse lifetime, clamped to [0, 1].
export function scanPulseProgress(
  elapsedSeconds: number,
  durationSeconds: number = scanPulseDurationSeconds,
): number {
  if (durationSeconds <= 0) {
    return 1;
  }
  return clamp(elapsedSeconds / durationSeconds, 0, 1);
}

// Whether a pulse started `elapsedSeconds` ago is still travelling.
export function scanPulseActive(
  elapsedSeconds: number,
  durationSeconds: number = scanPulseDurationSeconds,
): boolean {
  return elapsedSeconds >= 0 && elapsedSeconds < durationSeconds;
}

// Shell radius for a given progress. Eases out so it leaps away from the ship and slows as
// it dissipates.
export function scanPulseRadius(progress: number, maxRadius: number = scanPulseMaxRadius): number {
  const p = clamp(progress, 0, 1);
  const eased = 1 - (1 - p) * (1 - p);
  return eased * maxRadius;
}

// Overall brightness envelope across the pulse: swells in from nothing and fades back out.
export function scanPulseEnvelope(progress: number): number {
  return Math.sin(Math.PI * clamp(progress, 0, 1));
}
