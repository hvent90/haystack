import { useFrame } from "@react-three/fiber";
import { useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import {
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
  return (
    <directionalLight
      position={[
        sunDirection.x * sunDistance,
        sunDirection.y * sunDistance,
        sunDirection.z * sunDistance,
      ]}
      intensity={sunLightIntensity}
      color={sunLightColor}
    />
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
      <meshBasicMaterial color={sunDiscColor} toneMapped={false} />
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
