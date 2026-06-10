// Scratch debug for the camera e2e: enter flight in third person, hold Q, dump state.
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { chromium, type Browser } from "playwright";

import type { Pilot } from "../../src/shared/types";
import { captureTraffic, webgpuLaunchOptions } from "./helpers";

const serverPort = 8809;
const clientPort = 5209;
const dbPath = resolve(tmpdir(), `haystack-camdbg-${Date.now()}.sqlite`);
const serverUrl = `http://127.0.0.1:${serverPort}`;
const clientUrl = `http://127.0.0.1:${clientPort}`;

const server = Bun.spawn(["bun", "src/server/main.ts"], {
  env: { ...process.env, PORT: String(serverPort), HAYSTACK_DB: dbPath },
  stdout: "pipe",
  stderr: "pipe",
});
const client = Bun.spawn(
  ["bunx", "vite", "--host", "127.0.0.1", "--port", String(clientPort), "--strictPort"],
  { env: { ...process.env, VITE_API_URL: serverUrl }, stdout: "pipe", stderr: "pipe" },
);

let browser: Browser | null = null;
try {
  await waitFor(`${serverUrl}/api/health`);
  await waitFor(clientUrl);
  const pilot = (
    await api<{ pilot: Pilot }>("/api/pilots", {
      method: "POST",
      body: JSON.stringify({ callsign: `CamDbg-${Date.now()}` }),
    })
  ).pilot;
  browser = await chromium.launch(webgpuLaunchOptions);
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  const traffic = captureTraffic(page);
  const url = new URL(clientUrl);
  url.searchParams.set("pilotId", pilot.id);
  await page.goto(url.toString(), { waitUntil: "networkidle" });
  await page.waitForSelector("[data-testid='haystack-app']", { timeout: 15000 });
  await Bun.sleep(1500);

  await page.keyboard.press("c");
  await Bun.sleep(800);
  console.log("after C:", JSON.stringify(await dump(page)));

  await page.getByTestId("flight-mode-toggle").click();
  await Bun.sleep(800);
  console.log("after lock:", JSON.stringify(await dump(page)));

  await page.keyboard.down("q");
  await Bun.sleep(2000);
  await page.keyboard.up("q");
  console.log("after Q 2s:", JSON.stringify(await dump(page)));
  const frames = traffic.inputFrames() as Array<{ command?: { rotation?: unknown } }>;
  console.log("input frames:", frames.length);
  console.log("last frame:", JSON.stringify(frames[frames.length - 1] ?? null));
  const rotating = frames.filter(
    (frame) =>
      frame.command !== undefined &&
      (frame.command as { rotation?: { z?: number } }).rotation?.z !== 0,
  );
  console.log("frames with rotation.z != 0:", rotating.length);
  console.log("sample rotating frame:", JSON.stringify(rotating[0] ?? null));
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

async function dump(page: import("playwright").Page): Promise<unknown> {
  return page.evaluate(() => {
    const app = document.querySelector("[data-testid='haystack-app']");
    return {
      probe: (window as unknown as { __probe?: unknown }).__probe ?? null,
      flightMode: app?.getAttribute("data-flight-mode"),
      pointerLocked: document.pointerLockElement !== null,
    };
  });
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
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
  if (!response.ok) {
    throw new Error(`${path} failed: ${response.status}`);
  }
  return (await response.json()) as T;
}
