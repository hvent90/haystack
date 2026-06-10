import { useFrame } from "@react-three/fiber";
import { useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import {
  DirectionalLight,
  Mesh,
  Object3D,
  Quaternion as ThreeQuaternion,
  SpotLight,
  Vector3 as ThreeVector3,
} from "three";
import type { Quaternion } from "../../../shared/types";
import { flightRenderStore } from "../renderStore";
import {
  flashlightAngle,
  flashlightColor,
  flashlightDecay,
  flashlightDistance,
  flashlightIntensity,
  flashlightPenumbra,
  forwardVector,
  shadowBias,
  shadowBubbleHalf,
  shadowCameraFar,
  shadowCameraNear,
  shadowLightDistance,
  shadowMapSize,
  shadowNormalBias,
  shadowSoftRadius,
  sunDiscColor,
  sunDiscSize,
  sunDirection,
  sunDistance,
  sunLightColor,
  sunLightIntensity,
} from "../lighting";

// The sun: a single directional light. The world group is only translated (floating origin),
// never rotated, so this fixed scene-space direction is a stable world direction. Target stays
// at the origin, so the light travels along -sunDirection.
export function SunLight(): ReactNode {
  const lightRef = useRef<DirectionalLight>(null);
  const targetRef = useRef<Object3D>(null);
  // Fixed orthonormal basis of the shadow camera's image plane (the sun never moves), used
  // to snap the camera-following ortho window to whole shadow-map texels each frame —
  // without this, sub-texel window motion makes every shadow edge shimmer during flight.
  const basis = useMemo(() => {
    const dir = new ThreeVector3(sunDirection.x, sunDirection.y, sunDirection.z);
    const up = Math.abs(dir.y) < 0.99 ? new ThreeVector3(0, 1, 0) : new ThreeVector3(1, 0, 0);
    const right = new ThreeVector3().crossVectors(up, dir).normalize();
    const trueUp = new ThreeVector3().crossVectors(dir, right).normalize();
    return { right, up: trueUp };
  }, []);
  const snapped = useMemo(() => new ThreeVector3(), []);

  useLayoutEffect(() => {
    const light = lightRef.current;
    const target = targetRef.current;
    if (light === null || target === null) {
      return;
    }
    light.target = target;
    light.castShadow = true;
    light.shadow.mapSize.set(shadowMapSize, shadowMapSize);
    light.shadow.bias = shadowBias;
    light.shadow.normalBias = shadowNormalBias;
    light.shadow.radius = shadowSoftRadius;
    const shadowCamera = light.shadow.camera;
    shadowCamera.left = -shadowBubbleHalf;
    shadowCamera.right = shadowBubbleHalf;
    shadowCamera.top = shadowBubbleHalf;
    shadowCamera.bottom = -shadowBubbleHalf;
    shadowCamera.near = shadowCameraNear;
    shadowCamera.far = shadowCameraFar;
    shadowCamera.updateProjectionMatrix();
  }, []);

  // Each frame, follow the camera: place the shadow-casting light just up-sun of the camera
  // (direction is what matters for a directional light) with the ortho target on the camera,
  // so the tight shadow bubble tracks the player through the floating-origin field.
  useFrame((state) => {
    const light = lightRef.current;
    const target = targetRef.current;
    if (light === null || target === null) {
      return;
    }
    // Snap the ortho window center to whole shadow-map texels on the light's image plane
    // (depth along the sun direction is unconstrained — it doesn't affect texel alignment).
    const cameraPosition = state.camera.position;
    const texel = (2 * shadowBubbleHalf) / shadowMapSize;
    const r = basis.right.dot(cameraPosition);
    const u = basis.up.dot(cameraPosition);
    const dr = Math.round(r / texel) * texel - r;
    const du = Math.round(u / texel) * texel - u;
    snapped.copy(cameraPosition).addScaledVector(basis.right, dr).addScaledVector(basis.up, du);
    light.position.set(
      snapped.x + sunDirection.x * shadowLightDistance,
      snapped.y + sunDirection.y * shadowLightDistance,
      snapped.z + sunDirection.z * shadowLightDistance,
    );
    target.position.copy(snapped);
    target.updateMatrixWorld(true);
  });

  return (
    <>
      <directionalLight ref={lightRef} intensity={sunLightIntensity} color={sunLightColor} />
      <object3D ref={targetRef} />
    </>
  );
}

// The visible sun disc. Re-anchored to the camera each frame so it reads as infinitely distant:
// it never parallaxes as the ship flies, and stays in the correct part of the sky as the ship
// turns. Unlit + tone-mapping off so it stays bright enough to crest the (faint) bloom threshold.
export function SunDisc(): ReactNode {
  const meshRef = useRef<Mesh>(null);

  useFrame((state) => {
    const mesh = meshRef.current;
    if (mesh === null) {
      return;
    }
    mesh.position.set(
      state.camera.position.x + sunDirection.x * sunDistance,
      state.camera.position.y + sunDirection.y * sunDistance,
      state.camera.position.z + sunDirection.z * sunDistance,
    );
  });

  return (
    <mesh ref={meshRef}>
      <sphereGeometry args={[sunDiscSize, 24, 24]} />
      <meshBasicMaterial color={sunDiscColor} toneMapped={false} fog={false} />
    </mesh>
  );
}

// The ship's flashlight: a spotlight at the cockpit aimed along the ship's forward axis. Its
// primary job is to rake across nearby asteroid surfaces in the dark (zero ambient) so deposits
// will later be visible on them. Off by default; toggled with F. The orientation is read from
// the same smoothed render store that drives the camera, so the cone stays locked to where the
// cockpit actually points (a raw snapshot orientation would lag/jitter against the camera).
export function ShipFlashlight({
  fallbackOrientation,
  on,
}: {
  fallbackOrientation: Quaternion;
  on: boolean;
}): ReactNode {
  const lightRef = useRef<SpotLight>(null);
  const targetRef = useRef<Object3D>(null);
  const quaternion = useMemo(() => new ThreeQuaternion(), []);
  const cockpit = useMemo(() => new ThreeVector3(0, 0.12, 0), []);
  const cockpitWorld = useMemo(() => new ThreeVector3(), []);

  useLayoutEffect(() => {
    if (lightRef.current !== null && targetRef.current !== null) {
      lightRef.current.target = targetRef.current;
    }
  }, []);

  useFrame(() => {
    const light = lightRef.current;
    const target = targetRef.current;
    if (light === null || target === null) {
      return;
    }
    const orientation = flightRenderStore.hasOwned()
      ? flightRenderStore.ownedRenderQuaternion()
      : fallbackOrientation;
    quaternion.set(orientation.x, orientation.y, orientation.z, orientation.w).normalize();
    cockpitWorld.copy(cockpit).applyQuaternion(quaternion);
    light.position.copy(cockpitWorld);
    const forward = forwardVector({
      x: quaternion.x,
      y: quaternion.y,
      z: quaternion.z,
      w: quaternion.w,
    });
    target.position.set(
      cockpitWorld.x + forward.x * flashlightDistance,
      cockpitWorld.y + forward.y * flashlightDistance,
      cockpitWorld.z + forward.z * flashlightDistance,
    );
  });

  return (
    <>
      <spotLight
        ref={lightRef}
        angle={flashlightAngle}
        penumbra={flashlightPenumbra}
        distance={flashlightDistance}
        decay={flashlightDecay}
        intensity={on ? flashlightIntensity : 0}
        color={flashlightColor}
      />
      <object3D ref={targetRef} />
    </>
  );
}
