import { useFrame } from "@react-three/fiber";
import { EffectComposerContext } from "@react-three/postprocessing";
import { forwardRef, useContext, useMemo, useRef, type ReactNode } from "react";
import {
  scanColor,
  scanFacingPower,
  scanPulseActive,
  scanPulseEnvelope,
  scanPulseProgress,
  scanPulseRadius,
  scanShellThickness,
  scanStrength,
} from "../scan";
import { ScanPulseEffectImpl } from "./ScanPulseEffectImpl";

// React wrapper that mounts the ScanPulseEffectImpl the SSAO way: it pulls the NormalPass
// texture off EffectComposerContext (so it must live inside an <EffectComposer enableNormalPass>),
// builds the effect once, and forwards its ref to the <primitive> so the composer can fold it
// into an EffectPass. wrapEffect cannot do this — it never reads EffectComposerContext.
//
// A bump of `scanNonce` (driven by the V key) starts a one-shot pulse; the rest of the time the
// effect's strength uniform is 0, which the shader short-circuits to a passthrough.
export const ScanPulseEffect = forwardRef<ScanPulseEffectImpl, { scanNonce: number }>(
  function ScanPulseEffect({ scanNonce }, ref): ReactNode {
    const { normalPass, downSamplingPass } = useContext(EffectComposerContext);

    const effect = useMemo(() => {
      if (normalPass === null && downSamplingPass === null) {
        console.error("ScanPulseEffect requires <EffectComposer enableNormalPass>.");
        return null;
      }
      const normalBuffer =
        downSamplingPass !== null && downSamplingPass !== undefined
          ? downSamplingPass.texture
          : normalPass!.texture;
      return new ScanPulseEffectImpl({
        normalBuffer,
        color: scanColor,
        bandWidth: scanShellThickness,
        facingPower: scanFacingPower,
      });
    }, [normalPass, downSamplingPass]);

    const startRef = useRef<number | null>(null);
    const handledNonceRef = useRef(scanNonce);

    useFrame((state) => {
      if (effect === null) {
        return;
      }
      // useFrame always runs the latest closure, so `scanNonce` is current here.
      if (handledNonceRef.current !== scanNonce) {
        handledNonceRef.current = scanNonce;
        startRef.current = state.clock.elapsedTime;
      }
      if (startRef.current === null) {
        return;
      }
      const elapsed = state.clock.elapsedTime - startRef.current;
      if (!scanPulseActive(elapsed)) {
        effect.setPulse(0, 0);
        startRef.current = null;
        return;
      }
      const progress = scanPulseProgress(elapsed);
      effect.setPulse(scanPulseRadius(progress), scanPulseEnvelope(progress) * scanStrength);
    });

    if (effect === null) {
      return null;
    }
    return <primitive ref={ref} object={effect} dispose={null} />;
  },
);
