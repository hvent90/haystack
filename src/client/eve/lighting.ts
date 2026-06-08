import type { Quaternion, Vector3 } from "../../shared/types";

// The sun + the ship flashlight are the only light sources. Ambient is zero so any
// surface the sun and flashlight do not reach reads as true-vacuum black.
export const ambientIntensity = 0;

// Direction from the scene origin toward the sun, as a unit vector. The world group is
// only translated (floating origin) and never rotated, so a fixed scene-space direction
// is a fixed world-space direction — the sun stays put as the ship flies and turns.
export const sunDirection: Vector3 = normalize({ x: 0.55, y: 0.62, z: -0.56 });

// How far down the sun direction to place the directional light and the visible disc
// (scene units; 1 unit = 1 km). Large enough that the light reads as parallax-free.
export const sunDistance = 1600;
export const sunLightColor = "#fff2da";
export const sunLightIntensity = 3.1;

// Visible sun billboard. Sized for a "near Jupiter" sun — a small, bright, distant disc rather
// than a looming sphere (~1 degree across at sunDistance), so it reads as far away and keeps its
// bloom footprint tiny.
export const sunDiscColor = "#fff4dd";
export const sunDiscSize = 14;

// Flashlight mounted at the cockpit, aimed along the ship's forward axis.
export const flashlightColor = "#eaf3ff";
export const flashlightIntensity = 14;
export const flashlightDistance = 18; // scene units (~18 km) of reach
export const flashlightAngle = 0.36; // cone half-angle in radians
export const flashlightPenumbra = 0.45;
export const flashlightDecay = 0.85; // softened inverse-square so it carries to nearby rocks

// Barely-perceptible bloom — only the sun disc and emissive accents should ever crest the
// luminance threshold, and even then only faintly.
export const bloomIntensity = 0.12;
export const bloomLuminanceThreshold = 0.92;
export const bloomLuminanceSmoothing = 0.18;

// Sun shadow bubble (Tier 1): a single orthographic shadow map that follows the camera
// each frame. The shadow-casting light is placed just up-sun of the camera (a directional
// light's direction is distance-independent), so the ortho depth range stays tight; the
// visible SunDisc stays far away at sunDistance, untouched.
export const shadowMapSize = 2048;
export const shadowBubbleHalf = 8; // ortho half-width in scene units (km)
export const shadowLightDistance = 12; // units up-sun to place the shadow-casting light
export const shadowCameraNear = 1;
export const shadowCameraFar = 24;
export const shadowBias = 0.0001;
export const shadowNormalBias = 0.05;
export const shadowSoftRadius = 2;

// Crossfade from the near per-pixel shadow map to the far per-instance occlusion scalar,
// keyed on view-space depth (km). Fully shadow-map at <= near, fully per-instance at >= far.
export const shadowBubbleFadeNear = 5;
export const shadowBubbleFadeFar = 8;

// Distance fog: a gentle far extinction toward the background colour (NOT a hard cutoff).
// Loose by default so it never clips the field; tighten as asteroid density grows.
export const fogColor = "#03040a";
export const fogNear = 30;
export const fogFar = 90;

// Rotate the canonical camera-forward axis (0, 0, -1) by an orientation quaternion.
// Used to aim the flashlight (and anything else that needs the ship's facing).
export function forwardVector(orientation: Quaternion): Vector3 {
  return applyQuaternion({ x: 0, y: 0, z: -1 }, orientation);
}

function applyQuaternion(v: Vector3, q: Quaternion): Vector3 {
  // v' = v + 2 * cross(q.xyz, cross(q.xyz, v) + q.w * v)
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  return {
    x: v.x + q.w * tx + (q.y * tz - q.z * ty),
    y: v.y + q.w * ty + (q.z * tx - q.x * tz),
    z: v.z + q.w * tz + (q.x * ty - q.y * tx),
  };
}

function normalize(v: Vector3): Vector3 {
  const length = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z) || 1;
  return { x: v.x / length, y: v.y / length, z: v.z / length };
}
