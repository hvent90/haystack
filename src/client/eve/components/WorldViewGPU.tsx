// ISOLATED beachhead, UNVERIFIED on GPU (no WebGPU in build env). Not wired into App; mount
// manually for a real-GPU smoke test.
//
// docs/gpu-asteroids-architecture.md §7 step 1 + §8. This is the WebGPU renderer beachhead as a
// standalone R3F mount: one <Canvas gl={makeWebGPUFactory()}> with ONE InstancedMesh of
// MAX_RESIDENT rocks drawing zero-copy from the GPU `pos` buffer via makeAsteroidMaterial().
//
// It deliberately has NO WebGL fallback (§1.1, §5): assertWebGPU() refuses a non-WebGPU
// browser. On mount it seeds `base` from the CPU derive (deriveBase + seedBaseFromCPU, §3.2);
// per frame it bumps frameCounter, sets originMeters, runs the overlay compute in ONE
// submission (§3.3 — NOT computeAsync-awaited), then renders.
//
// GPU-UNVERIFIED end-to-end: it compiles and bundles, but boot/draw/screenshot cannot be
// exercised here (no navigator.gpu). The pure logic it depends on (capability detection, the
// bounded overlay) is unit-tested; everything requiring a live GPU is unverified.

import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import * as THREE from "three/webgpu";

import type { FieldSummary, Vector3 } from "../../../shared/types";
import { base as baseBuffer, MAX_RESIDENT } from "../gpu/buffers";
import { deriveBase, seedBaseFromCPU } from "../gpu/base-derive";
import { assertWebGPU } from "../gpu/capability";
import { frameCounter, genFieldOverlay } from "../gpu/kernels/overlay";
import { makeAsteroidMaterial, originMeters } from "../gpu/kernels/render-node";
import { makeWebGPUFactory } from "../gpu/renderer-factory";

// The canonical server-matched field (§2.6). Used when the host does not pass one.
const DEFAULT_FIELD: FieldSummary = {
  totalAsteroids: 1_000_000,
  seed: 424_242,
  cellSize: 1130,
  indexKind: "cubicCellHierarchy",
  renderedLimit: 50_000,
};

type WorldViewGPUProps = {
  // Field descriptor to derive `base` from; defaults to the canonical server field.
  field?: FieldSummary;
  // Ship position (world meters) used as the floating origin AND the derive center.
  ownShipMeters?: Vector3;
};

// The single instanced field, mounted INSIDE the Canvas so it can use the R3F renderer.
function GPUField({ field, ownShipMeters }: Required<WorldViewGPUProps>): ReactNode {
  // useThree returns the R3F store's gl; for this beachhead it is the WebGPURenderer the async
  // factory produced. R3F's gl type is the union of renderers, so we narrow to WebGPURenderer.
  const gl = useThree((state) => state.gl) as unknown as InstanceType<typeof THREE.WebGPURenderer>;
  const scene = useThree((state) => state.scene);
  const camera = useThree((state) => state.camera);

  const materialRef = useRef(makeAsteroidMaterial());
  // Low-poly shared geometry: a unit-radius icosahedron (the material scales it by radius/1000).
  const geometryRef = useRef(new THREE.IcosahedronGeometry(1, 1));

  // Seed `base` (and the cosmetic packAttr phase) from the CPU derive once on mount (§3.2).
  useEffect(() => {
    const { base } = deriveBase(ownShipMeters, field, MAX_RESIDENT);
    seedBaseFromCPU(baseBuffer, base);
    // packAttr's phase column is seeded by deriveBase into its own backing store via the same
    // path; the overlay reads packAttr.z. (Phase seeding is cosmetic, not parity-gated.)
  }, [field, ownShipMeters]);

  // Per-frame: bump the cosmetic ticker, recentre the floating origin, run the overlay compute
  // in ONE submission (§3.3 — never computeAsync-awaited in the hot loop), then render.
  useFrame(() => {
    frameCounter.value += 1;
    originMeters.value.set(ownShipMeters.x, ownShipMeters.y, ownShipMeters.z);
    gl.compute(genFieldOverlay);
    gl.render(scene, camera);
  }, 1); // priority 1 = take over the render loop (we drive render() ourselves)

  return (
    <instancedMesh
      args={[geometryRef.current, materialRef.current, MAX_RESIDENT]}
      frustumCulled={false}
    />
  );
}

// The standalone WebGPU mount. Refuses non-WebGPU browsers before showing the Canvas.
export function WorldViewGPU({ field, ownShipMeters }: WorldViewGPUProps = {}): ReactNode {
  const resolvedField = field ?? DEFAULT_FIELD;
  const resolvedShip = ownShipMeters ?? { x: 0, y: 0, z: 0 };

  const [status, setStatus] = useState<"checking" | "ok" | "unsupported">("checking");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    assertWebGPU().then(
      () => {
        if (!cancelled) setStatus("ok");
      },
      (err: unknown) => {
        if (cancelled) return;
        setStatus("unsupported");
        setError(err instanceof Error ? err.message : String(err));
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  if (status === "unsupported") {
    return (
      <div role="alert">
        {error ?? "This application requires WebGPU; your browser does not support it."}
      </div>
    );
  }
  if (status === "checking") {
    return <div>Checking WebGPU support…</div>;
  }

  return (
    <Canvas gl={makeWebGPUFactory()} camera={{ position: [0, 0, 60], near: 0.1, far: 5000 }}>
      <ambientLight intensity={0.4} />
      <directionalLight position={[1, 1, 1]} intensity={1.2} />
      <GPUField field={resolvedField} ownShipMeters={resolvedShip} />
    </Canvas>
  );
}
