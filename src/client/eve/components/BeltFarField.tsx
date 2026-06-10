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
  step,
  sub,
  texture,
  uv,
  vec3,
  vec4,
} from "three/tsl";

import type { Vector3 } from "../../../shared/types";
import { sampleDensity, type BeltField } from "../../../shared/belt/field";
import { BELT_VERTICAL_SQUASH } from "../../../shared/belt/format";
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
  shell: THREE.Points;
  planet: THREE.Mesh;
  moons: THREE.Mesh[];
};

// --- camera-local impostor shell -------------------------------------------------------
//
// ED renders detailed rocks in a small bubble and fills the middle distance with point
// impostors (research doc §3: detail to ~5-10 km, sprite shell to ~20-25 km). The global
// speckle cloud above is far too sparse to read at that range (60k points over a
// 2,750 km annulus), so this layer scatters deterministic per-world-tile points around
// the camera, density-gated by the SAME baked density the real rocks derive from. Tiles
// are keyed to absolute world coordinates, so points never swim as the camera moves;
// the cloud is rebuilt (cheap, ~20k points) only when the camera strays far from the
// last build center.
const SHELL_TILE_M = 8000;
const SHELL_RADIUS_M = 52000;
const SHELL_REBUILD_M = 12000;
const SHELL_TRIES_PER_TILE = 220;

function buildShellPositions(belt: BeltField, centerX: number, centerZ: number): Float32Array {
  const zHalfM = (belt.bake.meta.density.zMax * belt.bake.worldScale) / BELT_VERTICAL_SQUASH;
  const half = Math.ceil(SHELL_RADIUS_M / SHELL_TILE_M);
  const tcx = Math.floor(centerX / SHELL_TILE_M);
  const tcz = Math.floor(centerZ / SHELL_TILE_M);
  const out: number[] = [];
  for (let tx = tcx - half; tx <= tcx + half; tx += 1) {
    for (let tz = tcz - half; tz <= tcz + half; tz += 1) {
      const rng = mulberry32((Math.imul(tx, 73856093) ^ Math.imul(tz, 19349663) ^ belt.seed) >>> 0);
      for (let i = 0; i < SHELL_TRIES_PER_TILE; i += 1) {
        const x = (tx + rng()) * SHELL_TILE_M;
        const z = (tz + rng()) * SHELL_TILE_M;
        const y = (rng() * 2 - 1) * zHalfM;
        const p = sampleDensity(belt, x, y, z) / (belt.pPeak || 1);
        if (rng() >= p) {
          continue;
        }
        out.push(x / SCENE, y / SCENE, z / SCENE);
      }
    }
  }
  return new Float32Array(out);
}

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
  // The haze texture is 1024² over a 2,750 km annulus — at mid range it's a flat smear,
  // so hold it back to region scale and let the granular impostor shell (below) carry
  // the 9-50 km band where ED shows its sprite sheet.
  const nearFade = smoothstep(float(9), float(28), camDist);
  // The annulus is a zero-thickness plane: edge-on (camera inside the slab) it renders
  // as a razor-bright line across the eye-line. Fade it out within ~2 km of the plane —
  // in-slab the fog + impostor shell carry the dust feel instead.
  const planeFade = smoothstep(float(1.8), float(5), cameraPosition.y.sub(positionWorld.y).abs());
  const hazeColor = mix(vec3(0.32, 0.36, 0.45), vec3(0.78, 0.72, 0.6), clamp(d.mul(1.6), 0, 1));
  // ED's lit-vs-shadow ring asymmetry (research doc §5): the sun sits up-sun of the
  // plane (+y), so the sheet reads bright from above and dim/backlit from below.
  const litSide = mix(float(0.35), float(1), step(0, cameraPosition.y.sub(positionWorld.y)));
  // Alpha low-ish: the impostor shell supplies the granularity at mid range; the haze
  // lifts the floor so the sheet doesn't read as pure black between points.
  hazeMat.colorNode = vec4(hazeColor, d.mul(0.1).mul(nearFade).mul(planeFade).mul(litSide));
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
    // Vertical: UNIFORM inside the squashed slab — a triangular (midplane-peaked)
    // distribution viewed edge-on integrates into a razor-bright line at the eye-line;
    // uniform reads as the soft band ED's ring makes across the horizon.
    const zv = ((rng() * 2 - 1) * zMax * 0.8) / BELT_VERTICAL_SQUASH;
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
  const speckFade = smoothstep(float(10), float(30), speckDist);
  // In-slab, every far-side point in a 2,750 km annulus collapses onto the same
  // horizon pixel row (each ≥1 px, additive) — a razor-bright line across the eye-line.
  // ED's answer is physical: ring dust limits in-plane visibility. So when the camera
  // is inside the slab, extinguish distant speckles; from above/below the full belt
  // stays visible (that's the legitimate region/belt-scale view).
  const speckCamAbove = smoothstep(
    float(2.5),
    float(7),
    cameraPosition.y.sub(positionWorld.y).abs(),
  );
  const speckFarCut = mix(smoothstep(float(300), float(110), speckDist), float(1), speckCamAbove);
  speckMat.colorNode = vec4(vec3(0.5, 0.5, 0.53), speckFade.mul(speckFarCut).mul(0.2));
  speckMat.sizeNode = clamp(speckDist.mul(0.004), float(1.0), float(3.2));
  const speckles = new THREE.Points(speckGeo, speckMat);
  speckles.frustumCulled = false;
  speckles.renderOrder = -9;

  // --- camera-local impostor shell (positions filled/rebuilt in useFrame) ---------------
  const shellGeo = new THREE.BufferGeometry();
  shellGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(0), 3));
  const shellMat = new THREE.PointsNodeMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  shellMat.fog = false;
  const shellDist = sub(positionWorld, cameraPosition).length();
  // In past the rock draw bubble (11 km), out before the global far-field carries.
  const shellFade = smoothstep(float(9), float(13), shellDist).mul(
    smoothstep(float(52), float(38), shellDist),
  );
  shellMat.colorNode = vec4(vec3(0.55, 0.52, 0.48), shellFade.mul(0.65));
  shellMat.sizeNode = clamp(float(48).div(shellDist), float(1.4), float(3.5));
  const shell = new THREE.Points(shellGeo, shellMat);
  shell.frustumCulled = false;
  shell.renderOrder = -8;

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

  return { haze, speckles, shell, planet, moons };
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
      assets.shell.geometry.dispose();
      (assets.shell.material as THREE.Material).dispose();
      assets.planet.geometry.dispose();
      (assets.planet.material as THREE.Material).dispose();
      for (const moon of assets.moons) {
        moon.geometry.dispose();
        (moon.material as THREE.Material).dispose();
      }
    };
  }, [assets]);

  const shellCenter = useRef<{ x: number; z: number } | null>(null);

  useFrame(() => {
    const group = groupRef.current;
    if (group === null) {
      return;
    }
    const p = originGroupPosition(fallbackOrigin);
    group.position.set(p.x, p.y, p.z);
    // Rebuild the impostor shell when the ship strays from the last build center.
    if (belt !== null && assets !== null) {
      const origin = flightRenderStore.hasOwned()
        ? flightRenderStore.ownedRenderPosition()
        : fallbackOrigin;
      const center = shellCenter.current;
      const moved =
        center === null ? Infinity : Math.hypot(origin.x - center.x, origin.z - center.z);
      if (moved > SHELL_REBUILD_M) {
        shellCenter.current = { x: origin.x, z: origin.z };
        const positions = buildShellPositions(belt, origin.x, origin.z);
        assets.shell.geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      }
    }
  });

  if (assets === null) {
    return null;
  }
  return (
    <group ref={groupRef}>
      <primitive object={assets.haze} />
      <primitive object={assets.speckles} />
      <primitive object={assets.shell} />
      <primitive object={assets.planet} />
      {assets.moons.map((moon, i) => (
        <primitive key={i} object={moon} />
      ))}
    </group>
  );
}
