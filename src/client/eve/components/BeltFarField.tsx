import { type ReactElement, useEffect, useMemo, useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three/webgpu";
import {
  cameraPosition,
  positionLocal,
  clamp,
  float,
  mix,
  positionWorld,
  smoothstep,
  sub,
  texture,
  uv,
  vec3,
  vec4,
} from "three/tsl";

import type { Vector3 } from "../../../shared/types";
import type { BeltField } from "../../../shared/belt/field";
import { activeBeltField } from "../field-core";
import { flightRenderStore } from "../renderStore";
import { toScene } from "../vector";

// Far-field belt view (purely visual; reads NO gameplay state and needs no parity).
//
// The player can look across the belt — bands, resonance gaps, family clumps — far
// beyond where individual rocks are derived. This renders that structure straight from
// the baked density (the sim's own macro-structure), three layers:
//   1. a density-haze annulus in the belt plane (x–z), textured from the z-summed bake,
//   2. a speckle point cloud sampled from the same density (the "grainy" belt at range),
//   3. the gas giant + moons as simple anchor meshes at the world origin.
// Everything fades out near the camera so it never doubles the real derived rocks.

const SCENE = 1000; // metersPerSceneUnit

function originGroupPosition(fallback: Vector3): Vector3 {
  const origin = flightRenderStore.hasOwned() ? flightRenderStore.ownedRenderPosition() : fallback;
  return toScene({ x: 0, y: 0, z: 0 }, origin);
}

// Deterministic small PRNG (mulberry32) so the speckle layer is stable across mounts.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type FarFieldAssets = {
  haze: THREE.Mesh;
  speckles: THREE.Points;
  planet: THREE.Mesh;
  moons: THREE.Mesh[];
};

function buildAssets(belt: BeltField): FarFieldAssets {
  const { meta, density, worldScale } = belt.bake;
  const { nr, ntheta, nz, rMin, rMax, zMax } = meta.density;

  // --- z-summed density texture (theta = U, r = V) --------------------------------
  const img = new Uint8Array(nr * ntheta);
  let peak = 1;
  const sums = new Float32Array(nr * ntheta);
  for (let ir = 0; ir < nr; ir += 1) {
    for (let it = 0; it < ntheta; it += 1) {
      let s = 0;
      const base = (ir * ntheta + it) * nz;
      for (let iz = 0; iz < nz; iz += 1) {
        s += density[base + iz]!;
      }
      sums[ir * ntheta + it] = s;
      if (s > peak) peak = s;
    }
  }
  for (let i = 0; i < sums.length; i += 1) {
    // sqrt tonemap: keeps faint outer structure visible without blowing out bands.
    img[i] = Math.min(255, Math.round(Math.sqrt(sums[i]! / peak) * 255));
  }
  const tex = new THREE.DataTexture(img, ntheta, nr, THREE.RedFormat, THREE.UnsignedByteType);
  tex.needsUpdate = true;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.wrapS = THREE.RepeatWrapping; // theta wraps
  tex.wrapT = THREE.ClampToEdgeWrapping;

  // --- haze annulus in the x–z plane, UV-mapped (u = theta, v = r) ------------------
  const rMinS = (rMin * worldScale) / SCENE;
  const rMaxS = (rMax * worldScale) / SCENE;
  const SEG_T = 512;
  const SEG_R = 96;
  const positions = new Float32Array((SEG_T + 1) * (SEG_R + 1) * 3);
  const uvs = new Float32Array((SEG_T + 1) * (SEG_R + 1) * 2);
  const indices: number[] = [];
  for (let jr = 0; jr <= SEG_R; jr += 1) {
    const fv = jr / SEG_R;
    const r = rMinS + fv * (rMaxS - rMinS);
    for (let jt = 0; jt <= SEG_T; jt += 1) {
      const fu = jt / SEG_T;
      const thetaWorld = fu * Math.PI * 2 - Math.PI; // matches atan2(z, x) in [-pi, pi)
      const k = jr * (SEG_T + 1) + jt;
      positions[k * 3] = r * Math.cos(thetaWorld);
      positions[k * 3 + 1] = 0;
      positions[k * 3 + 2] = r * Math.sin(thetaWorld);
      uvs[k * 2] = fu;
      uvs[k * 2 + 1] = fv;
    }
  }
  for (let jr = 0; jr < SEG_R; jr += 1) {
    for (let jt = 0; jt < SEG_T; jt += 1) {
      const a = jr * (SEG_T + 1) + jt;
      const b = a + SEG_T + 1;
      indices.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  const hazeGeo = new THREE.BufferGeometry();
  hazeGeo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  hazeGeo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  hazeGeo.setIndex(indices);

  const hazeMat = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
  hazeMat.fog = false;
  const d = texture(tex, uv()).r;
  const camDist = sub(positionWorld, cameraPosition).length();
  // Fade in past the derive bubble (~25 km) and slightly with extreme distance.
  const nearFade = smoothstep(float(22), float(95), camDist);
  const hazeColor = mix(vec3(0.32, 0.36, 0.45), vec3(0.78, 0.72, 0.6), clamp(d.mul(1.6), 0, 1));
  hazeMat.colorNode = vec4(hazeColor, d.mul(0.38).mul(nearFade));
  const haze = new THREE.Mesh(hazeGeo, hazeMat);
  haze.frustumCulled = false;
  haze.renderOrder = -10;

  // --- speckle impostor cloud ----------------------------------------------------------
  const rng = mulberry32(belt.seed >>> 0);
  const COUNT = 60_000;
  const pts = new Float32Array(COUNT * 3);
  let placed = 0;
  let guard = 0;
  while (placed < COUNT && guard < COUNT * 60) {
    guard += 1;
    const ir = Math.floor(rng() * nr);
    const it = Math.floor(rng() * ntheta);
    const value = sums[ir * ntheta + it]! / peak;
    if (rng() >= value) {
      continue;
    }
    const r = rMin + ((ir + rng()) / nr) * (rMax - rMin);
    const theta = ((it + rng()) / ntheta) * Math.PI * 2 - Math.PI;
    // Vertical: triangular-ish distribution inside ±zMax, denser at the midplane.
    const zv = (rng() + rng() - 1) * zMax * 0.8;
    const o = placed * 3;
    pts[o] = (r * Math.cos(theta) * worldScale) / SCENE;
    pts[o + 1] = (zv * worldScale) / SCENE;
    pts[o + 2] = (r * Math.sin(theta) * worldScale) / SCENE;
    placed += 1;
  }
  const speckGeo = new THREE.BufferGeometry();
  speckGeo.setAttribute("position", new THREE.BufferAttribute(pts.subarray(0, placed * 3), 3));
  const speckMat = new THREE.PointsNodeMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  speckMat.fog = false;
  const speckDist = sub(positionWorld, cameraPosition).length();
  const speckFade = smoothstep(float(28), float(120), speckDist);
  speckMat.colorNode = vec4(vec3(0.55, 0.55, 0.58), speckFade.mul(0.55));
  speckMat.sizeNode = clamp(speckDist.mul(0.004), float(1.0), float(3.2));
  const speckles = new THREE.Points(speckGeo, speckMat);
  speckles.frustumCulled = false;
  speckles.renderOrder = -9;

  // --- gas giant + moons -----------------------------------------------------------------
  const planetRadiusS = (0.34 * worldScale) / SCENE;
  const planetMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.85, metalness: 0 });
  planetMat.fog = false;
  // Procedural latitude banding: layered sines of the LOCAL y (stable under the
  // floating-origin group translation), warm giant palette.
  const lat = positionLocal.y.div(float(planetRadiusS)).clamp(-1, 1);
  const bands = lat.mul(14).sin().mul(0.5).add(lat.mul(31).sin().mul(0.25)).add(0.5);
  planetMat.colorNode = mix(vec3(0.42, 0.3, 0.22), vec3(0.66, 0.52, 0.38), clamp(bands, 0, 1));
  const planet = new THREE.Mesh(new THREE.SphereGeometry(planetRadiusS, 96, 64), planetMat);
  planet.renderOrder = -11;

  const moons: THREE.Mesh[] = [];
  const moonDefs = (belt.bake.meta as { moons?: Array<{ name: string; a: number }> }).moons ?? [];
  for (let i = 0; i < moonDefs.length; i += 1) {
    const def = moonDefs[i]!;
    const mat = new THREE.MeshStandardNodeMaterial({ color: "#9a948c", roughness: 0.95 });
    mat.fog = false;
    const moon = new THREE.Mesh(
      new THREE.SphereGeometry((0.018 * worldScale) / SCENE, 32, 24),
      mat,
    );
    const theta = (i * Math.PI * 2) / Math.max(1, moonDefs.length) + 0.7;
    moon.position.set(
      (def.a * worldScale * Math.cos(theta)) / SCENE,
      0,
      (def.a * worldScale * Math.sin(theta)) / SCENE,
    );
    moons.push(moon);
  }

  return { haze, speckles, planet, moons };
}

export function BeltFarField({ fallbackOrigin }: { fallbackOrigin: Vector3 }): ReactElement | null {
  const [belt, setBelt] = useState<BeltField | null>(() => activeBeltField());
  const groupRef = useRef<THREE.Group>(null);

  useEffect(() => {
    if (belt !== null) {
      return;
    }
    const timer = setInterval(() => {
      const active = activeBeltField();
      if (active !== null) {
        setBelt(active);
        clearInterval(timer);
      }
    }, 300);
    return () => clearInterval(timer);
  }, [belt]);

  const assets = useMemo(() => (belt === null ? null : buildAssets(belt)), [belt]);

  useEffect(() => {
    return () => {
      if (assets === null) {
        return;
      }
      assets.haze.geometry.dispose();
      (assets.haze.material as THREE.Material).dispose();
      assets.speckles.geometry.dispose();
      (assets.speckles.material as THREE.Material).dispose();
      assets.planet.geometry.dispose();
      (assets.planet.material as THREE.Material).dispose();
      for (const moon of assets.moons) {
        moon.geometry.dispose();
        (moon.material as THREE.Material).dispose();
      }
    };
  }, [assets]);

  useFrame(() => {
    const group = groupRef.current;
    if (group === null) {
      return;
    }
    const p = originGroupPosition(fallbackOrigin);
    group.position.set(p.x, p.y, p.z);
  });

  if (assets === null) {
    return null;
  }
  return (
    <group ref={groupRef}>
      <primitive object={assets.haze} />
      <primitive object={assets.speckles} />
      <primitive object={assets.planet} />
      {assets.moons.map((moon, i) => (
        <primitive key={i} object={moon} />
      ))}
    </group>
  );
}
