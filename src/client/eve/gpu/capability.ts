// WebGPU capability detection (docs/gpu-asteroids-architecture.md §5, §8.2).
//
// There is NO second rendering path: a browser without WebGPU is REFUSED. App.tsx gates
// startup on `hasWebGPU`; `assertWebGPU` throws the exact unsupported-browser message
// (used by the gpu-verify harness boot).
//
// Pure and unit-testable with a mocked `navigator` (tests/integration/gpu-capability.test.ts)
// — no live GPU device is required to exercise the detection logic. The detection ITSELF
// (does this real browser have WebGPU?) is GPU-UNVERIFIED in this headless build env, which
// has no `navigator.gpu`.

// `navigator.gpu` is the WebGPU entry point. The DOM lib types it as `GPU | undefined` only
// when the WebGPU types are present; we read it defensively so this compiles without the
// @webgpu/types dependency and so a mocked navigator (tests) is accepted.
type MaybeGPU = {
  requestAdapter?: () => Promise<unknown>;
};

function gpuOf(nav: unknown): MaybeGPU | undefined {
  return (nav as { gpu?: MaybeGPU } | undefined)?.gpu;
}

// True iff this environment exposes WebGPU AND an adapter can be acquired. `requestAdapter`
// can resolve `null` even when `navigator.gpu` exists (no compatible adapter) — that is a
// non-WebGPU outcome here.
export async function hasWebGPU(): Promise<boolean> {
  const gpu = gpuOf(typeof navigator === "undefined" ? undefined : navigator);
  const adapter = await gpu?.requestAdapter?.();
  return !!adapter;
}

// Refuse to start without WebGPU. The message text is part of the contract (§8.2) and is
// asserted verbatim in the capability test.
export async function assertWebGPU(): Promise<void> {
  if (!(await hasWebGPU())) {
    throw new Error("This application requires WebGPU; your browser does not support it.");
  }
}
