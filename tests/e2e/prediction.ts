import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { chromium, type Browser, type Page } from "playwright";

import type { Pilot } from "../../src/shared/types";

const serverPort = 8802;
const clientPort = 5202;
const dbPath = resolve(tmpdir(), `haystack-prediction-${Date.now()}.sqlite`);
const serverUrl = `http://127.0.0.1:${serverPort}`;
const clientUrl = `http://127.0.0.1:${clientPort}`;

const server = Bun.spawn(["bun", "src/server/main.ts"], {
  env: {
    ...process.env,
    PORT: String(serverPort),
    HAYSTACK_DB: dbPath,
    HAYSTACK_STREAM_DELAY_MS: "550",
    HAYSTACK_STREAM_JITTER_MS: "90",
  },
  stdout: "pipe",
  stderr: "pipe",
});

const client = Bun.spawn(
  ["bunx", "vite", "--host", "127.0.0.1", "--port", String(clientPort), "--strictPort"],
  {
    env: {
      ...process.env,
      VITE_API_URL: serverUrl,
    },
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
        callsign: `Prediction-Probe-${Date.now()}`,
        organization: "Needle Testers",
      }),
    })
  ).pilot;

  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const url = new URL(clientUrl);
  url.searchParams.set("pilotId", pilot.id);
  await page.goto(url.toString(), { waitUntil: "networkidle" });
  await page.waitForSelector("[data-testid='haystack-app']", { timeout: 15000 });

  await verifyOwnedPredictionUnderDelayedAck(page);

  console.log(
    JSON.stringify(
      {
        appUrl: clientUrl,
        pilotId: pilot.id,
        prediction: "delayed-ack-ok",
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

async function verifyOwnedPredictionUnderDelayedAck(page: Page): Promise<void> {
  const initialZ = await ownedZ(page);
  await page.getByTestId("flight-mode-toggle").click();
  await page.waitForFunction(
    () =>
      document.querySelector("[data-testid='haystack-app']")?.getAttribute("data-flight-mode") ===
      "flight",
  );

  await page.keyboard.down("w");
  await page.waitForFunction(
    (z) => {
      const app = document.querySelector("[data-testid='haystack-app']");
      return (
        Number(app?.getAttribute("data-prediction-tick") ?? "0") >= 8 &&
        Number(app?.getAttribute("data-owned-z") ?? "0") < z - 0.02
      );
    },
    initialZ,
    { timeout: 5000 },
  );
  const beforeAckZ = await ownedZ(page);
  const beforeAckTick = await ackTick(page);
  if (beforeAckTick !== 0) {
    throw new Error(`Expected delayed ACKs to be pending, got ack tick ${beforeAckTick}.`);
  }

  await page.waitForFunction(
    () =>
      Number(
        document.querySelector("[data-testid='haystack-app']")?.getAttribute("data-ack-tick"),
      ) > 0,
    undefined,
    { timeout: 7000 },
  );

  const samples: number[] = [];
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    samples.push(await ownedZ(page));
    await Bun.sleep(50);
  }
  await page.keyboard.up("w");

  if (samples.length < 5) {
    throw new Error("Expected multiple owned-position samples during delayed ACK playback.");
  }
  const maxPositiveJump = samples.reduce((maxJump, sample, index) => {
    if (index === 0) {
      return maxJump;
    }
    return Math.max(maxJump, sample - samples[index - 1]!);
  }, 0);
  if (maxPositiveJump > 0.5) {
    throw new Error(
      `Owned predicted position snapped back during ACK replay: ${JSON.stringify({
        beforeAckZ,
        maxPositiveJump,
        samples,
      })}`,
    );
  }
  if (samples.at(-1)! >= beforeAckZ) {
    throw new Error(
      `Owned predicted ship did not continue moving after delayed ACKs: ${JSON.stringify({
        beforeAckZ,
        samples,
      })}`,
    );
  }
}

async function ownedZ(page: Page): Promise<number> {
  return Number(await page.getByTestId("haystack-app").getAttribute("data-owned-z"));
}

async function ackTick(page: Page): Promise<number> {
  return Number(await page.getByTestId("haystack-app").getAttribute("data-ack-tick"));
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
