// Third-person camera state, decoupled from React so drag/wheel handlers can write it
// and RenderDriver can read it every frame without per-frame React state. The orbit
// pivot is always the scene origin: the floating origin pins the owned ship there, so
// orbiting "around the ship" needs no pivot tracking.
//
// Distances are scene units (1 unit = 1 km, metersPerSceneUnit = 1000). The ship cone
// is ~0.11 units long, so the min clamp keeps the camera out of the hull; the max stays
// inside the fog band (fogFar = 18) so the ship reads as a fading speck, never popping
// out of a fully fogged void.

import { clamp } from "./vector";

export type ViewMode = "first" | "third";

export const minOrbitDistance = 0.18;
export const maxOrbitDistance = 16;
export const defaultOrbitDistance = 0.9;
export const maxOrbitPitchRad = (80 * Math.PI) / 180;
// Each wheel notch (deltaY ~100) multiplies distance by 2^(100/480) ≈ 1.16, so zoom
// feels uniform from hull-filling close to speck-against-the-field far.
export const orbitZoomWheelDivisor = 480;
export const orbitRadiansPerPixel = 0.006;
// How far above the chase axis the third-person flight camera sits, as a ratio of the
// chase distance (~12° look-down onto the ship with the view parallel to the nose).
export const chaseHeightRatio = 0.22;
// Eased recentering time for every camera pose change (view toggle, lock/unlock).
export const cameraBlendSec = 0.45;

const viewModeStorageKey = "haystack.cameraView";
const orbitDistanceStorageKey = "haystack.orbitDistance";

export class OrbitCameraState {
  yawRad = 0;
  pitchRad = 0.32;
  distance = defaultOrbitDistance;

  /** Click-drag orbit: yaw wraps freely, pitch clamps short of the poles. */
  orbitBy(dxPx: number, dyPx: number): void {
    this.yawRad = wrapAngle(this.yawRad + dxPx * orbitRadiansPerPixel);
    this.pitchRad = clamp(
      this.pitchRad + dyPx * orbitRadiansPerPixel,
      -maxOrbitPitchRad,
      maxOrbitPitchRad,
    );
  }

  /** Wheel zoom: exponential (each notch multiplies distance), clamped. */
  zoomBy(wheelDeltaY: number): void {
    this.distance = clamp(
      this.distance * 2 ** (wheelDeltaY / orbitZoomWheelDivisor),
      minOrbitDistance,
      maxOrbitDistance,
    );
  }

  /** Camera offset from the ship (scene units) for the current yaw/pitch/distance. */
  offsetInto(out: { x: number; y: number; z: number }): void {
    const horizontal = Math.cos(this.pitchRad) * this.distance;
    out.x = Math.sin(this.yawRad) * horizontal;
    out.y = Math.sin(this.pitchRad) * this.distance;
    out.z = Math.cos(this.yawRad) * horizontal;
  }

  /**
   * Adopt the camera's current offset from the ship so cursor-mode orbiting starts
   * where the chase camera left it (no snap when unlocking). Distance is intentionally
   * NOT adopted — the persisted zoom level survives lock/unlock round trips.
   */
  seedAnglesFromOffset(x: number, y: number, z: number): void {
    const length = Math.hypot(x, y, z);
    if (length < 1e-6) {
      return;
    }
    this.pitchRad = clamp(Math.asin(clamp(y / length, -1, 1)), -maxOrbitPitchRad, maxOrbitPitchRad);
    this.yawRad = Math.atan2(x, z);
  }
}

function wrapAngle(radians: number): number {
  const twoPi = Math.PI * 2;
  return radians - twoPi * Math.floor((radians + Math.PI) / twoPi);
}

export const orbitCamera = new OrbitCameraState();

export function loadViewMode(): ViewMode {
  if (typeof window === "undefined") {
    return "first";
  }
  return window.localStorage.getItem(viewModeStorageKey) === "third" ? "third" : "first";
}

export function saveViewMode(mode: ViewMode): void {
  if (typeof window !== "undefined") {
    window.localStorage.setItem(viewModeStorageKey, mode);
  }
}

export function loadOrbitDistance(): number {
  if (typeof window === "undefined") {
    return defaultOrbitDistance;
  }
  const stored = Number(window.localStorage.getItem(orbitDistanceStorageKey));
  return Number.isFinite(stored) && stored > 0
    ? clamp(stored, minOrbitDistance, maxOrbitDistance)
    : defaultOrbitDistance;
}

export function saveOrbitDistance(distance: number): void {
  if (typeof window !== "undefined") {
    window.localStorage.setItem(orbitDistanceStorageKey, String(distance));
  }
}

if (typeof window !== "undefined") {
  orbitCamera.distance = loadOrbitDistance();
}
