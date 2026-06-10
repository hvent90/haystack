import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { chromium, type Browser, type CDPSession, type Page } from "playwright";

import { webgpuLaunchOptions } from "./helpers";
import type { Pilot } from "../../src/shared/types";

// Touch flight e2e: a real client in a phone-shaped, touch-emulating browser proves
// that synthesized stick gestures fly the ship through the SAME input-command +
// prediction path the keyboard uses:
//   (1) the touch UI renders (sticks spawn where the touch lands, buttons present),
//   (2) a left-stick throttle gesture produces sustained forward motion with NO
//       prediction snap-backs while the (predicted) ship moves,
//   (3) a right-stick gesture rotates the ship (orientation quaternion moves),
//   (4) the camera button flips to third person, where a one-finger drag orbits and
//       a two-finger pinch zooms — and the flight sticks are gone.
//
// Touch input is dispatched via CDP Input.dispatchTouchEvent so the page sees TRUSTED
// touch-derived pointer events (pointerType "touch", valid pointer ids for capture) —
// page.dispatchEvent would synthesize untrusted events that setPointerCapture rejects.

const serverPort = 8815;
const clientPort = 5215;
const dbPath = resolve(tmpdir(), `haystack-touch-${Date.now()}.sqlite`);
const serverUrl = `http://127.0.0.1:${serverPort}`;
const clientUrl = `http://127.0.0.1:${clientPort}`;

// Landscape phone (iPhone 14-ish in landscape).
const VIEW = { width: 844, height: 390 };

const server = Bun.spawn(["bun", "src/server/main.ts"], {
  env: {
    ...process.env,
    PORT: String(serverPort),
    HAYSTACK_DB: dbPath,
    // Input-path test, not a render-scale test (see prediction.ts).
    HAYSTACK_RENDERED_LIMIT: "2000",
  },
  stdout: "pipe",
  stderr: "pipe",
});

const client = Bun.spawn(
  ["bunx", "vite", "--host", "127.0.0.1", "--port", String(clientPort), "--strictPort"],
  {
    env: { ...process.env, VITE_API_URL: serverUrl },
    stdout: "pipe",
    stderr: "pipe",
  },
);

let browser: Browser | null = null;

try {
  await waitFor(`${serverUrl}/api/health`);
  await waitFor(clientUrl);

  const pilot = (
    await api<{ pilot: Pilot }>("/api/pilots", {
      method: "POST",
      body: JSON.stringify({
        callsign: `Touch-Probe-${Date.now()}`,
        organization: "Needle Testers",
      }),
    })
  ).pilot;

  const url = new URL(clientUrl);
  url.searchParams.set("pilotId", pilot.id);
  // Deterministic touch-UI activation: headless capability emulation of
  // (any-pointer: fine) is inconsistent across Chromium builds.
  url.searchParams.set("touch", "1");

  // Headless Chromium intermittently comes up with synthesized-touch dispatch DEAD for
  // the lifetime of the page (Input.dispatchTouchEvent accepted but no events reach the
  // renderer — observed on ~half of launches regardless of settle time or retries).
  // Validate dispatch with a probe gesture right after boot and relaunch the browser
  // until we get a working one; everything downstream then runs on real touch events.
  let session: { page: Page; cdp: CDPSession } | null = null;
  for (let attempt = 1; attempt <= 5 && session === null; attempt += 1) {
    if (browser !== null) {
      await browser.close();
    }
    browser = await chromium.launch(webgpuLaunchOptions);
    const candidate = await bootTouchPage(browser, url.toString());
    if (candidate !== null) {
      session = candidate;
    } else {
      console.error(`touch dispatch dead in browser launch ${attempt}; relaunching`);
    }
  }
  if (session === null) {
    throw new Error("Synthesized touch dispatch never came up across 5 browser launches.");
  }
  const { page, cdp } = session;

  await verifyTouchUiRenders(page);
  const throttleResult = await verifyThrottleGesture(page, cdp);
  const rotationResult = await verifyRotationGesture(page, cdp);
  const cameraResult = await verifyThirdPersonGestures(page, cdp);

  console.log(
    JSON.stringify(
      {
        appUrl: clientUrl,
        pilotId: pilot.id,
        touchUi: "rendered",
        throttle: throttleResult,
        rotation: rotationResult,
        camera: cameraResult,
      },
      null,
      2,
    ),
  );
} finally {
  if (browser !== null) {
    await browser.close();
  }
  server.kill();
  client.kill();
  if (existsSync(dbPath)) {
    rmSync(dbPath);
  }
}

// Boot the app in a fresh touch-emulating context and PROVE synthesized touch dispatch
// works (a probe touch on the left zone must spawn the stick). Returns null when this
// browser launch came up with dead touch dispatch.
async function bootTouchPage(
  browserInstance: Browser,
  url: string,
): Promise<{ page: Page; cdp: CDPSession } | null> {
  const context = await browserInstance.newContext({
    viewport: VIEW,
    deviceScaleFactor: 3,
    hasTouch: true,
    isMobile: true,
  });
  const page = await context.newPage();
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForSelector("[data-testid='haystack-app']", { timeout: 15000 });
  // First frames rendered (the __probe writer runs in WorldView's useFrame) — gestures
  // dispatched mid-boot race the overlay mount + SwiftShader pipeline warmup.
  await page.waitForFunction(
    () => (window as unknown as { __probe?: { owned?: unknown } }).__probe?.owned !== undefined,
    undefined,
    { timeout: 30000 },
  );
  // The in-world target brackets are pointer-events:auto islands that track moving
  // rocks — under Chrome's touch-target adjustment they magnetize synthesized touches
  // away from the stick zones nondeterministically (the nearest-32 set densely covers
  // a phone viewport). They are not under test here; make them inert so stick/orbit
  // gestures hit the surfaces this suite is actually about.
  await page.addStyleTag({
    content: ".bracket-layer, .bracket-layer * { pointer-events: none !important; }",
  });
  const cdp = await context.newCDPSession(page);
  try {
    await touchUntilStickSpawns(
      page,
      cdp,
      (avoid) => canvasPoint(page, 220, Math.floor(VIEW.width * 0.42), avoid),
      "touch-stick-left",
    );
  } catch {
    await context.close();
    return null;
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.waitForSelector("[data-testid='touch-stick-left']", {
    state: "detached",
    timeout: 3000,
  });
  return { page, cdp };
}

async function verifyTouchUiRenders(page: Page): Promise<void> {
  for (const testId of [
    "touch-controls",
    "touch-zone-left",
    "touch-zone-right",
    "touch-btn-boost",
    "touch-btn-stabilize",
    "touch-btn-cruise",
    "touch-btn-scan",
    "touch-btn-flashlight",
    "touch-btn-camera",
    "touch-btn-roll-left",
    "touch-btn-roll-right",
  ]) {
    const count = await page.getByTestId(testId).count();
    if (count !== 1) {
      throw new Error(`Expected exactly one ${testId}, found ${count}.`);
    }
  }
  // Touch targets must be thumb-sized (≥44px in either dimension).
  const box = await page.getByTestId("touch-btn-boost").boundingBox();
  if (box === null || (box.width < 44 && box.height < 44)) {
    throw new Error(`Boost button too small for touch: ${JSON.stringify(box)}.`);
  }
}

// Hold a full-deflection upward left-stick drag and prove sustained forward motion
// through prediction with no snap-backs (the prediction.ts tolerance pattern).
async function verifyThrottleGesture(page: Page, cdp: CDPSession): Promise<unknown> {
  const initialZ = await ownedZ(page);
  const correctionsBefore = await predictionCorrections(page);

  // Probe for a clean point inside the LEFT stick zone (44% of width, minus the edge
  // button column) on every attempt — brackets/HUD islands move as the world streams.
  const start = await touchUntilStickSpawns(
    page,
    cdp,
    (avoid) => canvasPoint(page, 220, Math.floor(VIEW.width * 0.42), avoid),
    "touch-stick-left",
  );
  const stickBox = await page.getByTestId("touch-stick-left").boundingBox();
  if (stickBox === null) {
    throw new Error("Left stick did not render a bounding box.");
  }
  const centerX = stickBox.x + stickBox.width / 2;
  const centerY = stickBox.y + stickBox.height / 2;
  if (Math.hypot(centerX - start.x, centerY - start.y) > 8) {
    throw new Error(
      `Stick spawned at (${centerX.toFixed(0)}, ${centerY.toFixed(0)}), not at the touch point (${start.x}, ${start.y}).`,
    );
  }
  // Full upward deflection (80px > 60px radius → throttle +1).
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{ x: start.x, y: start.y - 80, id: 1 }],
  });

  // Forward motion: default orientation flies toward -z (same direction the keyboard
  // W test asserts in prediction.ts).
  await page.waitForFunction(
    (z) => {
      const probe = (window as unknown as { __probe?: { owned?: { z: number } } }).__probe?.owned;
      return probe !== undefined && probe.z < z - 0.02;
    },
    initialZ,
    { timeout: 8000 },
  );

  // Tolerance window: the predicted position must never snap backwards while acks
  // reconcile the touch-driven commands.
  const samples: number[] = [];
  const deadline = Date.now() + 1200;
  while (Date.now() < deadline) {
    samples.push(await ownedZ(page));
    await Bun.sleep(50);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });

  const maxPositiveJump = samples.reduce(
    (maxJump, sample, index) =>
      index === 0 ? maxJump : Math.max(maxJump, sample - samples[index - 1]!),
    0,
  );
  if (maxPositiveJump > 0.5) {
    throw new Error(
      `Predicted position snapped back during touch throttle: ${JSON.stringify({ maxPositiveJump, samples })}`,
    );
  }
  if (samples.at(-1)! >= initialZ - 0.02) {
    throw new Error(`No sustained forward motion: ${JSON.stringify({ initialZ, samples })}`);
  }
  // Stick released → visual gone, throttle back to the persistent (zero) HUD value.
  await page.waitForSelector("[data-testid='touch-stick-left']", {
    state: "detached",
    timeout: 3000,
  });
  const correctionsDuring = (await predictionCorrections(page)) - correctionsBefore;
  return {
    movedMeters: Number((initialZ - samples.at(-1)!).toFixed(2)),
    maxPositiveJump,
    // Reported, not asserted — headless SwiftShader throttles the input timer, which
    // makes ANY moving ship correct on acks (see the rationale in prediction.ts).
    correctionsDuring,
  };
}

// Hold a leftward right-stick drag and prove the ship's orientation quaternion moves.
async function verifyRotationGesture(page: Page, cdp: CDPSession): Promise<unknown> {
  const before = await ownedQuat(page);

  // Clean point inside the RIGHT stick zone (clear of the right button column and the
  // bottom-right audio pill), re-probed per attempt.
  const start = await touchUntilStickSpawns(
    page,
    cdp,
    (avoid) => canvasPoint(page, Math.ceil(VIEW.width * 0.6), VIEW.width - 120, avoid),
    "touch-stick-right",
  );
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{ x: start.x - 70, y: start.y, id: 1 }],
  });

  // Wait for a clear orientation change (|dot| < threshold ⇔ a few degrees of yaw).
  await page.waitForFunction(
    (initial) => {
      const probe = (
        window as unknown as {
          __probe?: { ownedQuat?: { x: number; y: number; z: number; w: number } };
        }
      ).__probe?.ownedQuat;
      if (probe === undefined) {
        return false;
      }
      const dot =
        probe.x * initial.x + probe.y * initial.y + probe.z * initial.z + probe.w * initial.w;
      return Math.abs(dot) < 0.9995;
    },
    before,
    { timeout: 8000 },
  );
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  const after = await ownedQuat(page);
  const dot = before.x * after.x + before.y * after.y + before.z * after.z + before.w * after.w;
  return { quatDot: Number(dot.toFixed(6)) };
}

// Camera button flips to third person; there the sticks yield the screen to orbit
// (one-finger drag) and pinch zoom (two fingers).
async function verifyThirdPersonGestures(page: Page, cdp: CDPSession): Promise<unknown> {
  await page.getByTestId("touch-btn-camera").tap();
  await page.waitForFunction(
    () =>
      document.querySelector("[data-testid='haystack-app']")?.getAttribute("data-view-mode") ===
      "third",
    undefined,
    { timeout: 5000 },
  );
  const zoneCount = await page.getByTestId("touch-zone-left").count();
  if (zoneCount !== 0) {
    throw new Error("Flight stick zones must not render in third person.");
  }

  const orbitBefore = await orbitState(page);
  // HUD overlays (target brackets, clusters) are pointer-events:auto islands; probe for
  // a point where the CANVAS is the actual hit target so the gesture reaches the stage.
  const point = await canvasPoint(page);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: point.x, y: point.y, id: 1 }],
  });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{ x: point.x + 100, y: point.y, id: 1 }],
  });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  // __probe.orbit is written per rendered frame; under SwiftShader frames are hundreds
  // of ms apart, so wait for the post-drag value rather than sampling immediately.
  await page.waitForFunction(
    (initialYaw) => {
      const probe = (window as unknown as { __probe?: { orbit?: { yawRad: number } } }).__probe
        ?.orbit;
      return probe !== undefined && Math.abs(probe.yawRad - initialYaw) >= 0.02;
    },
    orbitBefore.yawRad,
    { timeout: 5000 },
  );
  const orbitAfterDrag = await orbitState(page);

  // Pinch out (fingers spread) → zoom in (distance shrinks). Both fingers must land on
  // canvas (each pointerdown routes through the stage handler independently).
  const pinchA = await canvasPoint(page);
  const pinchB = { x: pinchA.x + 80, y: pinchA.y };
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [
      { x: pinchA.x, y: pinchA.y, id: 1 },
      { x: pinchB.x, y: pinchB.y, id: 2 },
    ],
  });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [
      { x: pinchA.x - 60, y: pinchA.y, id: 1 },
      { x: pinchB.x + 60, y: pinchB.y, id: 2 },
    ],
  });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.waitForFunction(
    (distanceBefore) => {
      const probe = (window as unknown as { __probe?: { orbit?: { distance: number } } }).__probe
        ?.orbit;
      return probe !== undefined && probe.distance < distanceBefore;
    },
    orbitAfterDrag.distance,
    { timeout: 5000 },
  );
  const orbitAfterPinch = await orbitState(page);

  // Back to first person for a clean final state.
  await page.getByTestId("touch-btn-camera").tap();
  return {
    yawDeltaRad: Number((orbitAfterDrag.yawRad - orbitBefore.yawRad).toFixed(4)),
    pinchDistanceDelta: Number((orbitAfterPinch.distance - orbitAfterDrag.distance).toFixed(3)),
  };
}

// Touch down until the stick visual appears, lifting and re-placing on a FRESHLY
// PROBED point each attempt: target brackets track world objects, so a point that was
// clean a second ago can have a touch-adjustment magnet under it once the ship drifts
// (each bracket is an interactive island Chrome snaps touches onto). Returns the point
// that worked, with the touch still held.
async function touchUntilStickSpawns(
  page: Page,
  cdp: CDPSession,
  pickPoint: (avoid: { x: number; y: number }[]) => Promise<{ x: number; y: number }>,
  stickTestId: string,
): Promise<{ x: number; y: number }> {
  const failed: { x: number; y: number }[] = [];
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const point = await pickPoint(failed);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: point.x, y: point.y, id: 1 }],
    });
    try {
      await page.waitForSelector(`[data-testid='${stickTestId}']`, { timeout: 3000 });
      return point;
    } catch {
      failed.push(point);
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await Bun.sleep(500);
    }
  }
  throw new Error(`${stickTestId} never spawned after 5 touch attempts.`);
}

// A viewport point whose hit-test target is the WebGPU canvas (not a HUD overlay).
// Scans a coarse grid across the upper-middle of the view, leaving 100px margins for
// edge button columns and rails. The pinch in verifyThirdPersonGestures needs ~140px
// of horizontal clearance around the returned point; canvas hit areas are large, so a
// point chosen here keeps its neighborhood on canvas in practice.
async function canvasPoint(
  page: Page,
  minX = 160,
  maxX = VIEW.width - 160,
  avoid: { x: number; y: number }[] = [],
): Promise<{ x: number; y: number }> {
  const found = await page.evaluate(
    ({ height, minX: lo, maxX: hi, avoid: skip }) => {
      // Stage surfaces: the bare canvas (third person) or a stick zone (first person,
      // where the zones overlay the canvas). Anything else is a HUD island — and
      // Chrome's TOUCH TARGET ADJUSTMENT will snap a touch onto a nearby interactive
      // element (buttons, target brackets, panels), so the WHOLE ±56px neighborhood
      // must be stage surface, not just the point itself. Bracket positions vary per
      // pilot spawn, which is exactly why fixed gesture pixels were flaky.
      const isStage = (x: number, y: number): boolean => {
        const target = document.elementFromPoint(x, y);
        return (
          target instanceof HTMLCanvasElement ||
          (target instanceof HTMLElement && target.classList.contains("touch-zone"))
        );
      };
      for (let y = 130; y <= height - 130; y += 24) {
        for (let x = lo; x <= hi; x += 24) {
          // Points near previously failed attempts are skipped — some views park an
          // unidentifiable touch-eater over parts of the zone.
          if (skip.some((p) => Math.hypot(p.x - x, p.y - y) < 90)) {
            continue;
          }
          if (
            isStage(x, y) &&
            isStage(x - 56, y) &&
            isStage(x + 56, y) &&
            isStage(x, y - 56) &&
            isStage(x, y + 56) &&
            isStage(x - 40, y - 40) &&
            isStage(x + 40, y - 40) &&
            isStage(x - 40, y + 40) &&
            isStage(x + 40, y + 40)
          ) {
            return { x, y };
          }
        }
      }
      return null;
    },
    { height: VIEW.height, minX, maxX, avoid },
  );
  if (found === null) {
    throw new Error("No canvas-targeted point found in the viewport.");
  }
  return found;
}

async function ownedZ(page: Page): Promise<number> {
  return page.evaluate(() => {
    const probe = (window as unknown as { __probe?: { owned?: { z: number } } }).__probe?.owned;
    if (probe !== undefined) {
      return probe.z;
    }
    const app = document.querySelector("[data-testid='haystack-app']");
    return Number(app?.getAttribute("data-owned-z") ?? "0");
  });
}

async function ownedQuat(page: Page): Promise<{ x: number; y: number; z: number; w: number }> {
  return page.evaluate(() => {
    const probe = (
      window as unknown as {
        __probe?: { ownedQuat?: { x: number; y: number; z: number; w: number } };
      }
    ).__probe?.ownedQuat;
    return probe ?? { x: 0, y: 0, z: 0, w: 1 };
  });
}

async function orbitState(
  page: Page,
): Promise<{ yawRad: number; pitchRad: number; distance: number }> {
  return page.evaluate(() => {
    const probe = (
      window as unknown as {
        __probe?: { orbit?: { yawRad: number; pitchRad: number; distance: number } };
      }
    ).__probe?.orbit;
    if (probe === undefined) {
      throw new Error("__probe.orbit missing");
    }
    return probe;
  });
}

async function predictionCorrections(page: Page): Promise<number> {
  return Number(await page.getByTestId("haystack-app").getAttribute("data-prediction-corrections"));
}

async function waitFor(url: string): Promise<void> {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      await Bun.sleep(250);
    }
    await Bun.sleep(250);
  }
  throw new Error(`Timed out waiting for ${url}.`);
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${serverUrl}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init.headers },
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return (await response.json()) as T;
}
