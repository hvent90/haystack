// Scratch: capture third-person camera milestone screenshots (not part of verify).
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { chromium, type Browser, type Page } from "playwright";

import type { Pilot } from "../../src/shared/types";
import { webgpuLaunchOptions } from "./helpers";

const serverPort = 8811;
const clientPort = 5211;
const dbPath = resolve(tmpdir(), `haystack-camshots-${Date.now()}.sqlite`);
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
      body: JSON.stringify({ callsign: `CamShots-${Date.now()}` }),
    })
  ).pilot;
  // Discover the home pocket so rocks render around the ship.
  await api(`/api/ships/${encodeURIComponent(pilot.id)}/scan`, {
    method: "POST",
    body: JSON.stringify({ mode: "pocket" }),
  });

  browser = await chromium.launch(webgpuLaunchOptions);
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  const url = new URL(clientUrl);
  url.searchParams.set("pilotId", pilot.id);
  await page.goto(url.toString(), { waitUntil: "networkidle" });
  await page.waitForSelector("[data-testid='haystack-app']", { timeout: 15000 });
  await Bun.sleep(4000); // let the field stream in and the first frames settle

  mkdirSync("screenshots", { recursive: true });

  // Lights on so the ship reads against the void.
  await page.keyboard.press("l");
  await page.keyboard.press("f");
  await Bun.sleep(800);
  await page.screenshot({ path: "screenshots/camera-first-person.png" });

  await page.keyboard.press("c");
  await Bun.sleep(2500); // blend + settle
  await page.screenshot({ path: "screenshots/camera-third-person.png" });

  // Orbit to a side angle.
  await page.mouse.move(300, 760);
  await page.mouse.down();
  await page.mouse.move(560, 700, { steps: 12 });
  await page.mouse.up();
  await Bun.sleep(1200);
  await page.screenshot({ path: "screenshots/camera-orbit-side.png" });

  // Zoom to a close-up.
  await page.mouse.move(1500, 250);
  await page.mouse.wheel(0, -700);
  await Bun.sleep(1200);
  await page.screenshot({ path: "screenshots/camera-orbit-close.png" });

  // Max zoom: ship as a speck against the belt.
  for (let i = 0; i < 14; i += 1) {
    await page.mouse.wheel(0, 480);
    await Bun.sleep(120);
  }
  await Bun.sleep(1500);
  await page.screenshot({ path: "screenshots/camera-orbit-max-zoom.png" });

  console.log("screenshots written");
  console.log(JSON.stringify(await probeDump(page), null, 2));
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

async function probeDump(page: Page): Promise<unknown> {
  return page.evaluate(() => (window as unknown as { __probe?: unknown }).__probe ?? null);
}
