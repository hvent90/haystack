import { isTouchDevice } from "./mobile";

// Render quality tiers. ONE pipeline, tiered parameters (the hard constraint from the
// GPU architecture): the mobile tier changes resident-rock count, canvas pixel ratio,
// the sun shadow-map pass, and the froxel grid resolution — it never adds a second
// render path.
//
// Selection is capability-based (the touch probe doubles as the phone-class signal —
// every WebGPU touch-only device today is a phone/tablet GPU) with a `?tier=` override
// for benches and desktop debugging. Cached for the session: a tier flip mid-flight
// would re-allocate every GPU buffer under the renderer.

export type QualityTier = "desktop" | "mobile";

export type QualityParams = {
  tier: QualityTier;
  /** Client-side cap applied to FieldSummary.renderedLimit before field derivation —
      the resident-rock count the GPU pipeline actually carries. */
  renderedLimitCap: number;
  /** R3F Canvas dpr clamp [min, max]. */
  dprRange: [number, number];
  /** Sun shadow-map pass (shadow tier 1). Tier 2 (per-instance aSunlit) always stays —
      it is per-vertex math, effectively free, and carries the far-field look. */
  sunShadowMap: boolean;
  /** Froxel volumetric grid dimensions (scatter cost scales with w*h*d). */
  froxel: { w: number; h: number; d: number };
};

const DESKTOP: QualityParams = {
  tier: "desktop",
  renderedLimitCap: Number.POSITIVE_INFINITY,
  dprRange: [1, 1.5],
  sunShadowMap: true,
  froxel: { w: 160, h: 90, d: 64 },
};

// Phone-class budget: ~1/4 the resident rocks (12k still reads as a dense belt at
// phone viewing distances), native-ish 1.0 dpr (a 390pt phone canvas at dpr 1 is
// ~1/6 the pixels of a desktop 1440p canvas at 1.5), no sun shadow-map pass, and a
// froxel grid at ~27% of the desktop cell count (96*54*48 vs 160*90*64).
const MOBILE: QualityParams = {
  tier: "mobile",
  renderedLimitCap: 12000,
  dprRange: [1, 1],
  sunShadowMap: false,
  froxel: { w: 96, h: 54, d: 48 },
};

let cached: QualityParams | null = null;

export function qualityParams(): QualityParams {
  if (cached === null) {
    cached = detectTier() === "mobile" ? MOBILE : DESKTOP;
  }
  return cached;
}

export function qualityTier(): QualityTier {
  return qualityParams().tier;
}

function detectTier(): QualityTier {
  if (typeof window !== "undefined") {
    const override = new URLSearchParams(window.location.search).get("tier");
    if (override === "mobile" || override === "desktop") {
      return override;
    }
  }
  return isTouchDevice() ? "mobile" : "desktop";
}

// Test seam.
export function resetQualityCacheForTests(): void {
  cached = null;
}
