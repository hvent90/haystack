import { Effect, EffectAttribute } from "postprocessing";
import { Color, Uniform, type Texture } from "three";

// Custom postprocessing Effect for the "scanning" pulse. A shell expands outward from the
// player (who sits at the scene origin) and, as it passes over a surface, lights that surface up
// according to how directly its normal points back at the camera ("facing ratio") — faces square
// on to you glow, faces seen edge-on stay dark. This reveals surface orientation from the actual
// per-face normals rather than tracing polygon edges.
//
// Normals come from a real NormalPass (crisp, per-facet, view-space) threaded in as an explicit
// uniform — postprocessing has no EffectAttribute for normals (only NONE/DEPTH/CONVOLUTION).
//
// The radial gate uses linear eye distance (`-getViewZ(depth)`) directly as the player distance —
// valid because the camera is at the scene origin and this is a plain perspective depth buffer
// (no logarithmic depth). No matrix uniforms or world reconstruction needed.
//
// Mounted via ScanPulseEffect.tsx (the SSAO-style forwardRef + <primitive> pattern).

const fragmentShader = /* glsl */ `
uniform sampler2D uNormalBuffer;
uniform vec3 uColor;
uniform float uRadius;       // expanding shell radius, in eye-distance (scene) units
uniform float uBandWidth;    // half-thickness of the shell band
uniform float uStrength;     // overall envelope; 0 == idle (free passthrough)
uniform float uFacingPower;  // contrast on the facing term

// Linear eye distance from raw [0,1] depth. getViewZ is negative (camera looks down -Z).
float scanEyeDist(const in float d) {
  return -getViewZ(d);
}

void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) {
  // Idle, or background / far plane: nothing to scan.
  if (uStrength <= 0.0 || depth >= 1.0) {
    outputColor = inputColor;
    return;
  }

  // View-space surface normal (NormalPass packs n * 0.5 + 0.5). In view space the camera looks
  // down -Z, so a face pointing straight back at the camera has normal.z ~ 1.
  vec3 normal = normalize(texture2D(uNormalBuffer, uv).rgb * 2.0 - 1.0);
  float facing = pow(clamp(normal.z, 0.0, 1.0), uFacingPower);

  // Expanding radial shell: radial coordinate == eye distance == player distance.
  float dC = scanEyeDist(depth);
  float shell = smoothstep(uRadius - uBandWidth, uRadius, dC) -
    smoothstep(uRadius, uRadius + uBandWidth, dC);

  // Additive emissive glow that the Bloom pass (added after) will faintly bloom.
  outputColor = vec4(inputColor.rgb + uColor * (facing * shell * uStrength), inputColor.a);
}
`;

export type ScanPulseOptions = {
  normalBuffer?: Texture | null;
  color?: string;
  bandWidth?: number;
  facingPower?: number;
};

export class ScanPulseEffectImpl extends Effect {
  constructor({
    normalBuffer = null,
    color = "#7de5d8",
    bandWidth = 2.4,
    facingPower = 1.5,
  }: ScanPulseOptions = {}) {
    super("ScanPulseEffect", fragmentShader, {
      attributes: EffectAttribute.DEPTH,
      uniforms: new Map<string, Uniform>([
        ["uNormalBuffer", new Uniform(normalBuffer)],
        ["uColor", new Uniform(new Color(color))],
        ["uRadius", new Uniform(0)],
        ["uBandWidth", new Uniform(bandWidth)],
        ["uStrength", new Uniform(0)],
        ["uFacingPower", new Uniform(facingPower)],
      ]),
    });
  }

  set normalBuffer(texture: Texture | null) {
    const uniform = this.uniforms.get("uNormalBuffer");
    if (uniform !== undefined) {
      uniform.value = texture;
    }
  }

  // Drive each frame from the pulse animation.
  setPulse(radius: number, strength: number): void {
    const radiusUniform = this.uniforms.get("uRadius");
    const strengthUniform = this.uniforms.get("uStrength");
    if (radiusUniform !== undefined) {
      radiusUniform.value = radius;
    }
    if (strengthUniform !== undefined) {
      strengthUniform.value = strength;
    }
  }
}
