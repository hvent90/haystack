import { Bloom, EffectComposer, ToneMapping } from "@react-three/postprocessing";
import { ToneMappingMode } from "postprocessing";
import type { ReactNode } from "react";
import { bloomIntensity, bloomLuminanceSmoothing, bloomLuminanceThreshold } from "../lighting";
import { ScanPulseEffect } from "./ScanPulseEffect";

// The post-process stack. enableNormalPass adds the NormalPass the scan effect samples for the
// surface-facing term; multisampling is off because MSAA can disagree with the depth/normal taps
// at silhouettes. Order is render order: scan -> Bloom (so the scan's additive glow blooms) ->
// ToneMapping last. ToneMapping (ACES) restores the filmic curve that the default R3F pipeline
// applied before this composer existed — without it the scene runs hot and the sky washes out.
// Bloom is kept barely perceptible (low intensity, high threshold) per the "almost unnoticeable"
// brief; only the sun disc and emissive accents ever crest it.
export function ScenePostProcessing({ scanNonce }: { scanNonce: number }): ReactNode {
  return (
    <EffectComposer enableNormalPass multisampling={0}>
      <ScanPulseEffect scanNonce={scanNonce} />
      <Bloom
        mipmapBlur
        intensity={bloomIntensity}
        luminanceThreshold={bloomLuminanceThreshold}
        luminanceSmoothing={bloomLuminanceSmoothing}
      />
      <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
    </EffectComposer>
  );
}
