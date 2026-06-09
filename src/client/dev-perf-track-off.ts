// Dev-only: disable react-dom's Component/Scheduler performance tracks BEFORE react-dom
// evaluates (this module must stay the FIRST import of main.tsx — ESM evaluates imports
// depth-first in order, and this module imports nothing).
//
// WHY: react-dom 19.2's dev build serializes a props DIFF for every component whose props
// identity changed each commit (logComponentRender → addObjectDiffToProperties →
// addValueToProperties, recursing 3 levels into arrays/objects). Our cell-cross commits
// hand a ~50k-element asteroid array (and the overview scaffold built from it) to ~8
// components, so every field cell crossing stalled the dev main thread ~1.1 s
// (bench:gpu-cross dev profile: 1463 ms addValueToProperties + 1078 ms
// addObjectDiffToProperties + 1256 ms GC per 12 s drift; prod max frame was 16.8 ms).
//
// react-dom gates the entire feature on `supportsUserTiming = typeof console.timeStamp ===
// "function" && typeof performance.measure === "function"`, evaluated once at module load.
// There is no runtime flag, so the sanctioned-shape escape hatch is making that gate false.
// Unsetting console.timeStamp (a DevTools-only no-op nicety nothing else uses) is the
// least-destructive of the two; performance.measure stays intact for real user timing.
if (import.meta.env.DEV) {
  (console as { timeStamp?: unknown }).timeStamp = undefined;
}

export {};
