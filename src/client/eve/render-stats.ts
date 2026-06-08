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
  // Time the last deriveVirtualField took (ms) — the cell-cross rebuild cost.
  fieldDeriveMs: number;
  // Most recent frame interval (ms), and the median across the sample window.
  lastFrameMs: number;
  medianFrameMs: number;
  // Worst single frame (ms) on a cell-cross frame within the sample window.
  worstCellCrossFrameMs: number;
  // Cell crossings (derive events) observed within the sample window.
  cellCrossCount: number;
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

  // A derive happened; the FOLLOWING rendered frame carries its upload/build cost,
  // so attribute that frame's interval to the worst cell-cross time.
  private crossPending = false;
  private attributeNextFrame = false;

  // Called from a visible asteroid mesh's (material-gated) onAfterRender.
  noteSubmitted(instanceCount: number, trianglesPerInstance: number): void {
    this.pendingSubmitted += instanceCount;
    this.pendingDrawCalls += 1;
    this.pendingTriangles += instanceCount * trianglesPerInstance;
  }

  // Called when the client re-derives the virtual field on a cell crossing.
  recordDerive(ms: number, derivedCount: number): void {
    this.fieldDeriveMs = ms;
    this.derivedAsteroidCount = derivedCount;
    this.crossPending = true;
    this.cellCrossCount += 1;
  }

  // Lets a derived count be recorded even when no re-derive ran (e.g. first paint
  // or a seeded-only change) so the benchmark always sees the real field size.
  setDerivedCount(derivedCount: number): void {
    this.derivedAsteroidCount = derivedCount;
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
    if (this.attributeNextFrame) {
      this.worstCellCrossFrameMs = Math.max(this.worstCellCrossFrameMs, frameMs);
      this.attributeNextFrame = false;
    }
    if (this.crossPending) {
      this.attributeNextFrame = true;
      this.crossPending = false;
    }

    this.frame += 1;
    this.publish();
  }

  // Clears the rolling window so a benchmark phase measures from a clean slate.
  reset(): void {
    this.frameTimes = [];
    this.worstCellCrossFrameMs = 0;
    this.cellCrossCount = 0;
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
      lastFrameMs: this.lastFrameMs,
      medianFrameMs: this.median(),
      worstCellCrossFrameMs: this.worstCellCrossFrameMs,
      cellCrossCount: this.cellCrossCount,
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
};

const debugControls: RenderDebugControls = { faceAway: false };

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
      };
    }
  ).__HAYSTACK_RENDER_DEBUG__ = {
    controls: debugControls,
    reset: () => renderStats.reset(),
    faceAway: (on: boolean) => {
      debugControls.faceAway = on;
    },
  };
}
