// App-exposed render telemetry for the client-render benchmark
// (scripts/bench/client-render.ts) and ad-hoc profiling.
//
// The headless WebGL frame clock under swiftshader is noisy, so the PRIMARY,
// robust pass/fail signals the benchmark relies on are the deterministic
// app-exposed COUNTS — how many asteroid instances were actually submitted to
// the GPU after culling, how many draw calls the asteroid field issued, and how
// many triangles that represents — NOT wall-clock FPS. Those counts are produced
// here, from the render loop, and published to `window.__HAYSTACK_RENDER_STATS__`.
//
// submittedInstanceCount is accumulated from each asteroid mesh's onAfterRender,
// which three invokes ONLY for objects that survive frustum culling in a pass.
// The asteroid material is used solely in the main color pass (the shadow pass
// swaps in a depth material, the post-processing NormalPass swaps in a normal
// material), so gating the accumulation on material identity counts each visible
// instance exactly once per frame and naturally sums across many per-cell
// sub-meshes once the field is chunked for real per-instance culling.

export type RenderStatsSnapshot = {
  frame: number;
  // Total asteroids the client derived for the current cell (seeded + virtual).
  derivedAsteroidCount: number;
  // Instances actually submitted to the GPU this frame, after frustum culling.
  submittedInstanceCount: number;
  // Asteroid-field draw calls this frame (1 today; one per visible chunk later).
  asteroidDrawCalls: number;
  // Triangles the asteroid field submitted this frame (submitted * tris/instance).
  asteroidTriangles: number;
  // Whole-frame renderer.info totals across every pass (shadow + normal + color +
  // post). Bounded, but coarser than the asteroid-specific counts above.
  drawCalls: number;
  renderedTriangles: number;
  // Main-thread cost of the last field derive (ms): the worker-path reconstruct, or the
  // synchronous deriveVirtualField on the fallback path. NOT the worker's off-thread scan.
  fieldDeriveMs: number;
  // Total main-thread FIELD work (derive/reconstruct + chunk partition + instance build)
  // attributed to the most recently completed frame. ~0 in steady state.
  lastFieldWorkMs: number;
  // Most recent frame interval (ms), and the median across the sample window. NOTE: under
  // headless swiftshader this is dominated by synchronous software rasterization (the test
  // renderer), NOT by our JS — it is a harness artifact, not a main-thread cost. The
  // robust cell-cross signal is worstCellCrossFrameMs (main-thread field work), below.
  lastFrameMs: number;
  medianFrameMs: number;
  // Worst single frame's total MAIN-THREAD field work (ms) within the sample window — the
  // real "does a cell cross block a frame" signal. Hardware/renderer independent: it sums
  // only our own timed work (derive/reconstruct + partition + instance build) per frame,
  // never the GPU/raster time. This is what C4's budget gates.
  worstCellCrossFrameMs: number;
  // Cell crossings (derive events) observed within the sample window.
  cellCrossCount: number;
  // Monotonic count of React snapshot commits (one per coalesced setSnapshot flush).
  // Before the 30Hz->React decoupling this tracked the delta rate (~30/s); after
  // coalescing it should sit near the flush cadence (~10/s). A deterministic,
  // hardware-independent signal that the every-delta->full-reconcile loop is broken.
  reactCommitCount: number;
  // Monotonic count of buildOverviewRows evaluations (one per overview rebuild).
  overviewBuildCount: number;
};

const FRAME_WINDOW = 240;

class RenderStats {
  private frame = 0;
  private derivedAsteroidCount = 0;
  private fieldDeriveMs = 0;

  // Per-frame accumulators, drained at the top of each frame.
  private pendingSubmitted = 0;
  private pendingDrawCalls = 0;
  private pendingTriangles = 0;

  private submittedInstanceCount = 0;
  private asteroidDrawCalls = 0;
  private asteroidTriangles = 0;
  private drawCalls = 0;
  private renderedTriangles = 0;

  private frameTimes: number[] = [];
  private lastFrameMs = 0;
  private worstCellCrossFrameMs = 0;
  private cellCrossCount = 0;
  private reactCommitCount = 0;
  private overviewBuildCount = 0;

  // Per-CROSS main-thread field work. A cell cross does: reconstruct (recordDerive) then,
  // in the React commit it triggers, the chunk partition + reconcile + per-chunk build
  // (noteFieldWork). We accumulate those into one cross bucket and finalize the bucket's
  // total when the NEXT cross starts — so the worst is a single crossing's true main-thread
  // stall, NOT a per-frame sum (under headless swiftshader's ~1.5 s frames several crossings
  // batch into one frame, which would inflate a per-frame metric far above any real hitch).
  private currentCrossWorkMs = 0;
  private lastFieldWorkMs = 0;

  // Called from a visible asteroid mesh's (material-gated) onAfterRender.
  noteSubmitted(instanceCount: number, trianglesPerInstance: number): void {
    this.pendingSubmitted += instanceCount;
    this.pendingDrawCalls += 1;
    this.pendingTriangles += instanceCount * trianglesPerInstance;
  }

  // Main-thread time (ms) spent on field work after a derive — the chunk partition/reconcile
  // and the per-chunk instance-matrix build. Added to the in-progress cross's bucket.
  noteFieldWork(ms: number): void {
    this.currentCrossWorkMs += ms;
  }

  // Called when the client (re)derives the virtual field: the worker-path reconstruct, or
  // the synchronous fallback derive. The ms is the MAIN-THREAD cost. Finalizes the previous
  // cross's bucket into the worst, then opens a new bucket seeded with this reconstruct.
  recordDerive(ms: number, derivedCount: number): void {
    this.fieldDeriveMs = ms;
    this.derivedAsteroidCount = derivedCount;
    this.lastFieldWorkMs = this.currentCrossWorkMs;
    if (this.currentCrossWorkMs > this.worstCellCrossFrameMs) {
      this.worstCellCrossFrameMs = this.currentCrossWorkMs;
    }
    this.currentCrossWorkMs = ms;
    this.cellCrossCount += 1;
  }

  // Lets a derived count be recorded even when no re-derive ran (e.g. first paint
  // or a seeded-only change) so the benchmark always sees the real field size.
  setDerivedCount(derivedCount: number): void {
    this.derivedAsteroidCount = derivedCount;
  }

  // Called once per coalesced React snapshot commit (the throttled flush + hard resets).
  noteReactCommit(): void {
    this.reactCommitCount += 1;
  }

  // Called once per buildOverviewRows evaluation (the overview useMemo).
  noteOverviewBuild(): void {
    this.overviewBuildCount += 1;
  }

  // Called once per frame from the render driver, BEFORE the upcoming render, with
  // the previous frame's fully-accumulated renderer.info totals. `frameMs` is the
  // r3f frame delta. Drains the previous frame's accumulators into the snapshot.
  frameTick(frameMs: number, infoCalls: number, infoTriangles: number): void {
    this.submittedInstanceCount = this.pendingSubmitted;
    this.asteroidDrawCalls = this.pendingDrawCalls;
    this.asteroidTriangles = this.pendingTriangles;
    this.pendingSubmitted = 0;
    this.pendingDrawCalls = 0;
    this.pendingTriangles = 0;

    this.drawCalls = infoCalls;
    this.renderedTriangles = infoTriangles;

    this.lastFrameMs = frameMs;
    this.frameTimes.push(frameMs);
    if (this.frameTimes.length > FRAME_WINDOW) {
      this.frameTimes.shift();
    }

    this.frame += 1;
    this.publish();
  }

  // Clears the rolling window so a benchmark phase measures from a clean slate.
  reset(): void {
    this.frameTimes = [];
    this.worstCellCrossFrameMs = 0;
    this.cellCrossCount = 0;
    this.currentCrossWorkMs = 0;
    this.lastFieldWorkMs = 0;
    this.publish();
  }

  private median(): number {
    if (this.frameTimes.length === 0) {
      return 0;
    }
    const sorted = [...this.frameTimes].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 0) {
      return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
    }
    return sorted[mid] ?? 0;
  }

  snapshot(): RenderStatsSnapshot {
    return {
      frame: this.frame,
      derivedAsteroidCount: this.derivedAsteroidCount,
      submittedInstanceCount: this.submittedInstanceCount,
      asteroidDrawCalls: this.asteroidDrawCalls,
      asteroidTriangles: this.asteroidTriangles,
      drawCalls: this.drawCalls,
      renderedTriangles: this.renderedTriangles,
      fieldDeriveMs: this.fieldDeriveMs,
      lastFieldWorkMs: this.lastFieldWorkMs,
      lastFrameMs: this.lastFrameMs,
      medianFrameMs: this.median(),
      // Include the in-progress cross so the most recent crossing is reflected even before
      // the next one finalizes its bucket.
      worstCellCrossFrameMs: Math.max(this.worstCellCrossFrameMs, this.currentCrossWorkMs),
      cellCrossCount: this.cellCrossCount,
      reactCommitCount: this.reactCommitCount,
      overviewBuildCount: this.overviewBuildCount,
    };
  }

  private publish(): void {
    if (typeof window === "undefined") {
      return;
    }
    (
      window as unknown as { __HAYSTACK_RENDER_STATS__?: RenderStatsSnapshot }
    ).__HAYSTACK_RENDER_STATS__ = this.snapshot();
  }
}

export const renderStats = new RenderStats();

// Benchmark/debug camera control. When `faceAway` is true the render driver lifts the
// camera far above the whole field and looks up into empty space (a 180° yaw from the
// field-center spawn would still stare into the surrounding derived ball) — used to
// measure that an empty view submits ~0 instances now that per-chunk frustum culling
// is real. No effect in normal play (nothing sets it). Kept on its own global so the
// stats object stays pure data.
export type RenderDebugControls = {
  faceAway: boolean;
  // Benchmark-only deterministic flight: meters to advance the owned ship along +x per
  // applied world delta, so the field deriver re-pages cells at a controlled rate through
  // the exact production pipeline. 0 = off (normal play). Used because real thrust-driven
  // flight is uncontrollable at 100k under headless swiftshader — the starved client
  // prediction either stalls or runs away clear past the field.
  drift: number;
  // Benchmark-only camera orientation override: when non-null, the camera looks along this
  // world direction instead of the ship orientation (e.g. down-sun, so every visible rock
  // face is sun-facing and brightness variation isolates the shadow terms). Position is
  // untouched. No effect in normal play (nothing sets it).
  lookDir: { x: number; y: number; z: number } | null;
  // Benchmark-only A/B switches for the two-tier asteroid shadow blend: tier1 = the
  // near-camera shadow map, tier2 = the per-instance aSunlit occlusion scalar. Forcing a
  // tier off replaces its term with 1.0 (fully lit) so screenshot diffs isolate what each
  // tier contributes. Both true in normal play.
  shadowTier1: boolean;
  shadowTier2: boolean;
};

const debugControls: RenderDebugControls = {
  faceAway: false,
  drift: 0,
  lookDir: null,
  shadowTier1: true,
  shadowTier2: true,
};

export function getRenderDebugControls(): RenderDebugControls {
  return debugControls;
}

if (typeof window !== "undefined") {
  (
    window as unknown as {
      __HAYSTACK_RENDER_DEBUG__?: {
        controls: RenderDebugControls;
        reset: () => void;
        faceAway: (on: boolean) => void;
        drift: (metersPerDelta: number) => void;
        lookDir: (dir: { x: number; y: number; z: number } | null) => void;
        shadowTiers: (tier1: boolean, tier2: boolean) => void;
      };
    }
  ).__HAYSTACK_RENDER_DEBUG__ = {
    controls: debugControls,
    reset: () => renderStats.reset(),
    faceAway: (on: boolean) => {
      debugControls.faceAway = on;
    },
    drift: (metersPerDelta: number) => {
      debugControls.drift = metersPerDelta;
    },
    lookDir: (dir: { x: number; y: number; z: number } | null) => {
      debugControls.lookDir = dir;
    },
    shadowTiers: (tier1: boolean, tier2: boolean) => {
      debugControls.shadowTier1 = tier1;
      debugControls.shadowTier2 = tier2;
    },
  };
}
