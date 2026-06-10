import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { chromium, type Browser, type BrowserContext } from "playwright";

import { webgpuLaunchOptions } from "../tests/e2e/helpers";
import type { Pilot } from "../src/shared/types";

// Design-review screenshots of the mobile layout: landscape with a live stick, the
// scanner sheet, third person, and the portrait rotate prompt — with a simulated
// notch (the safe-area CSS vars are overridden directly; headless Chromium has no
// real env(safe-area-inset-*) source).

const serverPort = 8809;
const clientPort = 5209;
const dbPath = resolve(tmpdir(), `haystack-shots-${Date.now()}.sqlite`);
const serverUrl = `http://127.0.0.1:${serverPort}`;
const clientUrl = `http://127.0.0.1:${clientPort}`;
const outDir = resolve(import.meta.dir, "..", "screenshots", "mobile");

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
  mkdirSync(outDir, { recursive: true });
  await waitFor(`${serverUrl}/api/health`);
  await waitFor(clientUrl);
  const pilot = (
    await api<{ pilot: Pilot }>("/api/pilots", {
      method: "POST",
      body: JSON.stringify({ callsign: `Shot-Probe-${Date.now()}`, organization: "Design" }),
    })
  ).pilot;

  browser = await chromium.launch(webgpuLaunchOptions);

  // Landscape with a simulated left-edge notch (landscape iPhone: safe-left 47px,
  // safe-bottom 21px).
  const landscape = await touchContext(browser, 844, 390);
  const page = await openApp(landscape, pilot.id, {
    "--safe-left": "47px",
    "--safe-bottom": "21px",
    "--safe-right": "0px",
    "--safe-top": "0px",
  });
  // Give the field + first frames a moment.
  await Bun.sleep(4000);
  await page.screenshot({ path: resolve(outDir, "landscape-idle.png") });

  // Hold both sticks mid-gesture for the layout shot.
  const cdp = await landscape.newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [
      { x: 270, y: 300, id: 1 },
      { x: 580, y: 250, id: 2 },
    ],
  });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [
      { x: 270, y: 250, id: 1 },
      { x: 620, y: 250, id: 2 },
    ],
  });
  await Bun.sleep(600);
  await page.screenshot({ path: resolve(outDir, "landscape-sticks-held.png") });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });

  // Scanner window as a full-screen sheet.
  await page.getByTestId("neocom-scanner").tap();
  await Bun.sleep(800);
  await page.screenshot({ path: resolve(outDir, "landscape-scanner-sheet.png") });
  await page.getByTestId("window-scanner-close").tap();

  // Third person: orbit gestures own the screen, sticks gone.
  await page.getByTestId("touch-btn-camera").tap();
  await Bun.sleep(1500);
  await page.screenshot({ path: resolve(outDir, "landscape-third-person.png") });

  // Portrait: rotate prompt.
  const portrait = await touchContext(browser, 390, 844);
  const portraitPage = await openApp(portrait, pilot.id, {
    "--safe-top": "47px",
    "--safe-bottom": "34px",
    "--safe-left": "0px",
    "--safe-right": "0px",
  });
  await Bun.sleep(2500);
  await portraitPage.screenshot({ path: resolve(outDir, "portrait-rotate-prompt.png") });

  console.log(`Screenshots written to ${outDir}`);
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

async function touchContext(
  browserInstance: Browser,
  width: number,
  height: number,
): Promise<BrowserContext> {
  return browserInstance.newContext({
    viewport: { width, height },
    deviceScaleFactor: 3,
    hasTouch: true,
    isMobile: true,
  });
}

async function openApp(context: BrowserContext, pilotId: string, safeVars: Record<string, string>) {
  const page = await context.newPage();
  const url = new URL(clientUrl);
  url.searchParams.set("pilotId", pilotId);
  url.searchParams.set("touch", "1");
  await page.goto(url.toString(), { waitUntil: "networkidle" });
  await page.waitForSelector("[data-testid='haystack-app']", { timeout: 15000 });
  await page.addStyleTag({
    content: `:root { ${Object.entries(safeVars)
      .map(([key, value]) => `${key}: ${value};`)
      .join(" ")} }`,
  });
  return page;
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
      /* retry */
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
