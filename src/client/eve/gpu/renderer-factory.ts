// Async R3F gl factory for the WebGPU renderer (docs/gpu-asteroids-architecture.md §8.2,
// §7 step 1).
//
// GPU-UNVERIFIED: this constructs and `init()`s a real `WebGPURenderer`, which cannot run in
// this build env (no `navigator.gpu` in node, Playwright Chromium, or system Chrome). The
// module COMPILES and BUNDLES (three/webgpu resolves); booting an actual renderer is an
// on-GPU smoke test only.
//
// `extend(THREE)` registers the three/webgpu node objects (NodeMaterials etc.) with the R3F
// reconciler so they can appear as JSX. The `as any` is the documented escape hatch (§8.2):
// R3F's `extend` is typed for the catalogue of three core objects, not the webgpu namespace.

import * as THREE from "three/webgpu";
import { extend } from "@react-three/fiber";
import type { GLProps } from "@react-three/fiber";

extend(THREE as any); // register three/webgpu node objects with the R3F reconciler (§8.2)

// ── StrictMode double-init guard ────────────────────────────────────────────────────────
// Under React StrictMode the async gl factory can run TWICE for the same canvas (mount →
// unmount → remount). Two `WebGPURenderer`s on one canvas is a hard fault. We memoize the
// renderer PROMISE per canvas in a WeakMap (auto-released when the canvas is GC'd) so both
// factory invocations await the SAME renderer; the discarded StrictMode mount is disposed.
//
// R3F awaits the promise this factory returns before it starts rendering, so "do not start
// rendering until the awaited renderer is the live one" is satisfied by handing every caller
// the one memoized live renderer.
type Renderer = InstanceType<typeof THREE.WebGPURenderer>;

const rendererByCanvas = new WeakMap<HTMLCanvasElement, Promise<Renderer>>();

function getOrCreateRenderer(canvas: HTMLCanvasElement): Promise<Renderer> {
  const existing = rendererByCanvas.get(canvas);
  if (existing) {
    return existing;
  }
  const created = (async () => {
    const renderer = new THREE.WebGPURenderer({ canvas, antialias: true });
    await renderer.init(); // MUST await before the first render
    return renderer;
  })();
  rendererByCanvas.set(canvas, created);
  return created;
}

// Returns the async gl factory R3F expects (`gl={makeWebGPUFactory()}`). It resolves to the
// initialized, memoized renderer for the canvas R3F provides. The return type is annotated as
// R3F's `GLProps` so it slots straight into `<Canvas gl={...}>` (R3F's GLProps union includes
// the async-factory form `(p: DefaultGLProps) => Promise<Renderer>`). R3F passes a `canvas`
// that is `HTMLCanvasElement | OffscreenCanvas`; WebGPURenderer needs a real HTMLCanvasElement
// (this beachhead mounts in the DOM, not an OffscreenCanvas worker).
export function makeWebGPUFactory(): GLProps {
  return async (props): Promise<Renderer> => {
    return getOrCreateRenderer(props.canvas as HTMLCanvasElement);
  };
}

// Dispose the memoized renderer for a canvas (call when a StrictMode mount is being discarded
// or on real unmount). Idempotent; safe if no renderer was created for the canvas.
export async function disposeWebGPURenderer(canvas: HTMLCanvasElement): Promise<void> {
  const existing = rendererByCanvas.get(canvas);
  if (!existing) {
    return;
  }
  rendererByCanvas.delete(canvas);
  const renderer = await existing;
  renderer.dispose();
}
