// The post-process stack, step 2 of the WebGPU bring-up (docs/gpu-asteroids-architecture.md
// §5, §7 step 2): three-native `PostProcessing` + TSL nodes replacing the WebGL-only pmndrs
// EffectComposer stack (ScanPulse + Bloom + ACES) that was removed when the app moved to
// WebGPURenderer.
//
// Graph: scenePass(MRT output+normal) → ScanPulse (additive shell glow) → bloom() (so the
// scan's glow blooms, same order as before) → PostProcessing's renderOutput (the renderer's
// ACES tone mapping + sRGB, restoring the filmic curve the old composer's ToneMapping pass
// applied). Bloom stays barely perceptible (low intensity, high threshold) per the
// "almost unnoticeable" brief; only the sun disc and emissive accents ever crest it.
//
// THE FLAGGED TRAP (§5): the old ScanPulseEffectImpl gated the shell on `-getViewZ(depth)`
// (camera eye-distance), valid only with the CAMERA at the player position. Under the
// floating origin the PLAYER (owned ship) sits at the scene origin and the camera rides a
// cockpit offset away from it — so the radial basis is re-derived here: reconstruct the
// fragment's view-space position from depth (getViewPosition), lift it to scene space with
// the camera world matrix, and use `length(scenePos)` — the distance to the PLAYER, who is
// the scene origin by construction of the floating-origin renderer (RenderDriver recenters
// every object on the owned ship's render position each frame).
//
// Normals come from the MRT `normal` target (HalfFloat, signed — no 0.5-packing like the
// old 8-bit NormalPass needed): faces square-on to the camera glow, edge-on faces stay
// dark, revealing surface orientation from real per-facet normals.

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, type ReactNode } from "react";
import * as THREE from "three/webgpu";
import { bloom } from "three/addons/tsl/display/BloomNode.js";
import {
  Fn,
  If,
  clamp,
  float,
  getViewPosition,
  length,
  mrt,
  normalize,
  output,
  pass,
  pow,
  smoothstep,
  transformedNormalView,
  uniform,
  uv,
  vec4,
} from "three/tsl";
import { bloomIntensity, bloomLuminanceSmoothing, bloomLuminanceThreshold } from "../lighting";
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

type Renderer = InstanceType<typeof THREE.WebGPURenderer>;

type PostStack = {
  postProcessing: InstanceType<typeof THREE.PostProcessing>;
  setPulse(radius: number, strength: number): void;
  dispose(): void;
};

function buildPostStack(renderer: Renderer, scene: THREE.Scene, camera: THREE.Camera): PostStack {
  // The old WebGL pipeline got ACES from the composer's ToneMapping pass; under
  // PostProcessing the final renderOutput applies the RENDERER's tone mapping, so pin it.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;

  const scenePass = pass(scene, camera);
  scenePass.setMRT(mrt({ output, normal: transformedNormalView }));
  const beauty = scenePass.getTextureNode("output");
  const normalTex = scenePass.getTextureNode("normal");
  const depthTex = scenePass.getTextureNode("depth");

  const uRadius = uniform(0);
  const uStrength = uniform(0);
  const uBand = uniform(scanShellThickness);
  const uFacingPower = uniform(scanFacingPower);
  const uScanColor = uniform(new THREE.Color(scanColor));
  // Live references: three uniform nodes re-read .value every frame, and these are the
  // camera's own mutable matrices (updated by RenderDriver / R3F before the post render).
  const uProjInv = uniform(camera.projectionMatrixInverse);
  const uCamWorld = uniform(camera.matrixWorld);

  const scanned = Fn(() => {
    const result = vec4(beauty).toVar();
    // Idle (strength 0) short-circuits to passthrough; background (depth 1) has nothing
    // to scan.
    If(uStrength.greaterThan(0), () => {
      const depth = float(depthTex).toVar();
      If(depth.lessThan(1), () => {
        const n = normalize(normalTex.rgb);
        const facing = pow(clamp(n.z, 0, 1), uFacingPower);
        const viewPos = getViewPosition(uv(), depth, uProjInv);
        const scenePos = uCamWorld.mul(vec4(viewPos, 1)).xyz;
        // Player distance under the floating origin: the owned ship IS the scene origin.
        const playerDist = length(scenePos);
        const shell = smoothstep(uRadius.sub(uBand), uRadius, playerDist).sub(
          smoothstep(uRadius, uRadius.add(uBand), playerDist),
        );
        result.rgb.addAssign(uScanColor.mul(facing.mul(shell).mul(uStrength)));
      });
    });
    return result;
  })();

  const bloomNode = bloom(scanned, bloomIntensity, 0, bloomLuminanceThreshold);
  bloomNode.smoothWidth.value = bloomLuminanceSmoothing;

  const postProcessing = new THREE.PostProcessing(renderer);
  postProcessing.outputNode = scanned.add(bloomNode);

  return {
    postProcessing,
    setPulse(radius: number, strength: number): void {
      uRadius.value = radius;
      uStrength.value = strength;
    },
    dispose(): void {
      postProcessing.dispose();
      bloomNode.dispose();
      scenePass.dispose();
    },
  };
}

// A bump of `scanNonce` (the V key) starts a one-shot pulse; the rest of the time the
// strength uniform is 0, which the node short-circuits to a passthrough. Mounting this
// component takes over the R3F render (useFrame renderPriority 1 disables the automatic
// gl.render) and renders through the PostProcessing graph instead.
export function ScenePostProcessing({ scanNonce }: { scanNonce: number }): ReactNode {
  const gl = useThree((state) => state.gl) as unknown as Renderer;
  const scene = useThree((state) => state.scene);
  const camera = useThree((state) => state.camera);

  const stack = useMemo(
    () => buildPostStack(gl, scene as THREE.Scene, camera),
    [gl, scene, camera],
  );
  useEffect(() => () => stack.dispose(), [stack]);

  const startRef = useRef<number | null>(null);
  const handledNonceRef = useRef(scanNonce);

  useFrame((state) => {
    // useFrame always runs the latest closure, so `scanNonce` is current here.
    if (handledNonceRef.current !== scanNonce) {
      handledNonceRef.current = scanNonce;
      startRef.current = state.clock.elapsedTime;
    }
    if (startRef.current !== null) {
      const elapsed = state.clock.elapsedTime - startRef.current;
      if (!scanPulseActive(elapsed)) {
        stack.setPulse(0, 0);
        startRef.current = null;
      } else {
        const progress = scanPulseProgress(elapsed);
        stack.setPulse(scanPulseRadius(progress), scanPulseEnvelope(progress) * scanStrength);
      }
    }
    stack.postProcessing.render();
  }, 1);

  return null;
}
