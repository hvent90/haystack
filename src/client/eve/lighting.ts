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

// Remote players' flashlights: same beam, dialed down. No shadow casting and a tighter
// reach than the local light — N of these can be on at once, so each must stay cheap
// while remaining clearly visible as a beam from the other ship.
export const remoteFlashlightIntensity = 9;
export const remoteFlashlightDistance = 8; // scene units (~8 km) of reach
export const remoteFlashlightAngle = 0.3;
export const remoteFlashlightPenumbra = 0.5;
// Visible beam cone (the spotlight itself is invisible in vacuum until it hits a rock).
export const remoteBeamLength = 2.2; // scene units (~2.2 km)
export const remoteBeamRadius = 0.55; // base radius at remoteBeamLength
export const remoteBeamOpacity = 0.05;

// Ship visibility (nav) lights: small always-on hull markers + a camera-distance-scaled
// strobe beacon so a lit ship reads against the black field at multi-km range. Colors
// follow aircraft convention: port red, starboard green, tail white.
export const navLightPortColor = "#ff5346";
export const navLightStarboardColor = "#46ff7d";
export const navLightTailColor = "#ffffff";
export const navBeaconColor = "#cfe7ff";
// Apparent beacon size: scale = distance * navBeaconAngularSize, clamped. ~0.6 degrees —
// a dozen-odd pixels at any range, unmistakably a light, never a blob up close.
export const navBeaconAngularSize = 0.011;
export const navBeaconMinScale = 0.02;
export const navBeaconMaxScale = 2.4;
// Hull wash so the ship body itself is visible when lit (zero-ambient vacuum).
export const navHullLightIntensity = 2.4;
export const navHullLightDistance = 0.7; // scene units (~700 m)

// Barely-perceptible bloom — only the sun disc and emissive accents should ever crest the
// luminance threshold, and even then only faintly.
export const bloomIntensity = 0.12;
export const bloomLuminanceThreshold = 0.92;
export const bloomLuminanceSmoothing = 0.18;

// Sun shadow bubble (Tier 1): a single orthographic shadow map that follows the camera
// each frame. The shadow-casting light is placed just up-sun of the camera (a directional
// light's direction is distance-independent), so the ortho depth range stays tight; the
// visible SunDisc stays far away at sunDistance, untouched.
export const shadowMapSize = 4096; // 3.9 m/texel over the 16 km bubble — crisp edges
export const shadowBubbleHalf = 8; // ortho half-width in scene units (km)
export const shadowLightDistance = 12; // units up-sun to place the shadow-casting light
export const shadowCameraNear = 1;
export const shadowCameraFar = 24;
export const shadowBias = 0.0001;
export const shadowNormalBias = 0.03; // ~30 m push — above one texel, below small-rock scale
export const shadowSoftRadius = 1;

// Crossfade from the near per-pixel shadow map to the far per-instance occlusion scalar,
// keyed on view-space depth (km). Fully shadow-map at <= near, fully per-instance at >= far.
export const shadowBubbleFadeNear = 5;
export const shadowBubbleFadeFar = 8;

// RETIRED as atmosphere (froxel volumetrics, architecture §6): the old 9..18 km linear
// fog band is superseded by the froxel participating medium, whose extinction follows the
// baked belt density (thick in clumps, clear in voids). What remains here is ONLY a
// narrow draw-distance dissolve: the GPU cull retires rocks at MAX_DRAW_SCENE (18 km,
// cull-cpu.ts — math the froxel work must not touch), and in a near-void the structured
// medium is too thin to hide that pop, so the last 3.5 km blend to the background colour.
export const fogColor = "#03040a";
export const fogNear = 14.5;
export const fogFar = 18;

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
