// Jitter measurement harness.
//
// Spins up the worktree server + client on isolated ports (never the dev
// defaults 8787/5173), flies the owned ship straight ahead, and samples the
// rendered owned-ship origin once per animation frame. Everything in the scene
// is drawn relative to myShip.position (the world origin) and the camera rotates
// with myShip.orientation, so the smoothness of this signal IS the smoothness of
// the whole rendered world.
//
// Prefers an in-page render probe (window.__probe.owned, written each useFrame)
// when present; otherwise falls back to the data-owned-* attributes (which exist
// on the original, pre-refactor client). Both represent the per-frame rendered
// origin, so the metric is comparable before and after the refactor.
//
// Usage: JITTER_LABEL=baseline bun tests/e2e/jitter.ts

import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { chromium, type Browser, type Page } from "playwright";

import type { Pilot } from "../../src/shared/types";
import { webgpuLaunchOptions, openWindow } from "./helpers";

const serverPort = Number(process.env["JITTER_SERVER_PORT"] ?? "8830");
const clientPort = Number(process.env["JITTER_CLIENT_PORT"] ?? "5230");
const durationMs = Number(process.env["JITTER_DURATION_MS"] ?? "3000");
const label = process.env["JITTER_LABEL"] ?? "run";
const turn = process.env["JITTER_TURN"] === "1";
const dbPath = resolve(tmpdir(), `haystack-jitter-${Date.now()}.sqlite`);
const serverUrl = `http://127.0.0.1:${serverPort}`;
const clientUrl = `http://127.0.0.1:${clientPort}`;

type Sample = { t: number; x: number; y: number; z: number; src: string };

const server = Bun.spawn(["bun", "src/server/main.ts"], {
  env: {
    ...process.env,
    PORT: String(serverPort),
    HAYSTACK_DB: dbPath,
    HAYSTACK_STREAM_DELAY_MS: "0",
    HAYSTACK_STREAM_JITTER_MS: "0",
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
        callsign: `Jitter-Probe-${Date.now()}`,
        organization: "Needle Testers",
      }),
    })
  ).pilot;

  browser = await chromium.launch(webgpuLaunchOptions);
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const url = new URL(clientUrl);
  url.searchParams.set("pilotId", pilot.id);
  await page.goto(url.toString(), { waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-testid='haystack-app']", { timeout: 15000 });

  await openWindow(page, "flight");
  await page.getByTestId("flight-mode-toggle").click();
  await page.waitForFunction(
    () =>
      document.querySelector("[data-testid='haystack-app']")?.getAttribute("data-flight-mode") ===
      "flight",
  );

  await page.keyboard.down("w");
  if (turn) {
    await page.keyboard.down("d");
  }
  // Warm up well past the acceleration phase so we sample steady cruise, where
  // per-frame steps are ~constant and jitter shows cleanly.
  await page.waitForFunction(
    () =>
      Number(
        document
          .querySelector("[data-testid='haystack-app']")
          ?.getAttribute("data-prediction-tick"),
      ) > 45,
    undefined,
    { timeout: 12000 },
  );
  // Hold a moment longer so velocity settles toward cruise before sampling.
  await page.waitForTimeout(900);

  const samples = await collectSamples(page, durationMs);
  await page.keyboard.up("w");
  if (turn) {
    await page.keyboard.up("d");
  }

  console.log(JSON.stringify({ label, durationMs, ...analyze(samples) }, null, 2));
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

async function collectSamples(page: Page, ms: number): Promise<Sample[]> {
  return page.evaluate(
    (durationMs) =>
      new Promise<Sample[]>((resolveSamples) => {
        const out: Sample[] = [];
        const app = document.querySelector("[data-testid='haystack-app']");
        const start = performance.now();
        const read = (): void => {
          const probe = (window as unknown as { __probe?: { owned?: Sample } }).__probe?.owned;
          const now = performance.now() - start;
          if (probe) {
            out.push({ t: now, x: probe.x, y: probe.y, z: probe.z, src: "probe" });
          } else {
            out.push({
              t: now,
              x: Number(app?.getAttribute("data-owned-x")),
              y: Number(app?.getAttribute("data-owned-y")),
              z: Number(app?.getAttribute("data-owned-z")),
              src: "attr",
            });
          }
          if (now < durationMs) {
            requestAnimationFrame(read);
          } else {
            resolveSamples(out);
          }
        };
        requestAnimationFrame(read);
      }),
    ms,
  );
}

function analyze(samples: Sample[]): Record<string, number | string> {
  if (samples.length < 8) {
    return { error: "not enough samples", samples: samples.length };
  }
  const src = samples[0]!.src;
  // Dominant motion axis = largest net displacement over the window.
  const axes = ["x", "y", "z"] as const;
  const net = axes.map((a) => Math.abs(samples.at(-1)![a] - samples[0]![a]));
  const axis = axes[net.indexOf(Math.max(...net))]!;
  const series = samples.map((s) => s[axis]);
  const direction = Math.sign(series.at(-1)! - series[0]!) || 1;

  const steps: number[] = [];
  const dts: number[] = [];
  for (let i = 1; i < samples.length; i += 1) {
    steps.push(series[i]! - series[i - 1]!);
    dts.push(samples[i]!.t - samples[i - 1]!.t);
  }
  const forwardSteps = steps.map((s) => s * direction); // >0 = expected direction
  const meanStep = mean(forwardSteps.map(Math.abs));
  const epsilon = meanStep * 0.25;

  // Rubber-banding: frames where the ship jumps AGAINST its travel direction.
  const reversals = forwardSteps.filter((s) => s < -epsilon).length;
  const maxBackStep = Math.max(0, ...forwardSteps.map((s) => -s));

  // Stalls: frames with ~no progress (data held, then a jump) — choppiness.
  const stalls = forwardSteps.filter((s) => Math.abs(s) < epsilon * 0.1).length;

  // Jerk: RMS of the second difference of position (smooth motion -> low).
  const jerks: number[] = [];
  for (let i = 2; i < series.length; i += 1) {
    jerks.push(series[i]! - 2 * series[i - 1]! + series[i - 2]!);
  }
  const jerkRms = Math.sqrt(mean(jerks.map((j) => j * j)));

  // Normalize jerk by mean step so it is comparable across speeds.
  const jerkRatio = meanStep > 0 ? jerkRms / meanStep : 0;
  const stepCv = meanStep > 0 ? stddev(forwardSteps) / meanStep : 0;
  const fps = samples.length / (samples.at(-1)!.t / 1000) || 0;

  return {
    source: src,
    axis,
    samples: samples.length,
    fps: round(fps, 1),
    meanStepM: round(meanStep, 4),
    reversals,
    reversalPct: round((100 * reversals) / forwardSteps.length, 1),
    maxBackStepM: round(maxBackStep, 4),
    stalls,
    stepCv: round(stepCv, 3),
    jerkRms: round(jerkRms, 4),
    jerkRatio: round(jerkRatio, 3),
  };
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

function stddev(values: number[]): number {
  const m = mean(values);
  return Math.sqrt(mean(values.map((v) => (v - m) * (v - m))));
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

async function waitFor(target: string): Promise<void> {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(target);
      if (response.ok) {
        return;
      }
    } catch {
      await Bun.sleep(250);
    }
    await Bun.sleep(250);
  }
  throw new Error(`Timed out waiting for ${target}.`);
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
