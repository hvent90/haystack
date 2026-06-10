import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { chromium, type Page } from "playwright";
import { PNG } from "pngjs";

import { openWindow, webgpuLaunchOptions } from "./helpers";

const serverPort = 8798;
const clientPort = 5198;
const statePath = resolve(tmpdir(), `haystack-cli-${Date.now()}.json`);
const desktopScreenshotPath = resolve("screenshots", "haystack-e2e.png");
const mobileScreenshotPath = resolve("screenshots", "haystack-e2e-mobile.png");
const dbPath = resolve(tmpdir(), `haystack-e2e-${Date.now()}.sqlite`);

const server = Bun.spawn(["bun", "src/server/main.ts"], {
  env: {
    ...process.env,
    PORT: String(serverPort),
    HAYSTACK_DB: dbPath,
  },
  stdout: "pipe",
  stderr: "pipe",
});

const client = Bun.spawn(["bunx", "vite", "--host", "127.0.0.1", "--port", String(clientPort)], {
  env: {
    ...process.env,
    VITE_API_URL: `http://127.0.0.1:${serverPort}`,
  },
  stdout: "pipe",
  stderr: "pipe",
});

try {
  await waitFor(`http://127.0.0.1:${serverPort}/api/health`);
  await waitFor(`http://127.0.0.1:${clientPort}`);

  await run(
    [
      "bun",
      "src/cli/main.ts",
      "join",
      "E2E-Prospector",
      "--server",
      `http://127.0.0.1:${serverPort}`,
    ],
    {
      HAYSTACK_CLI_STATE: statePath,
    },
  );
  await run(
    [
      "bun",
      "src/cli/main.ts",
      "scan",
      "pocket",
      "--server",
      `http://127.0.0.1:${serverPort}`,
      "--state",
      statePath,
    ],
    {},
  );

  await cliScreenshot(desktopScreenshotPath, ["--width", "1920", "--height", "1080"]);
  await cliScreenshot(mobileScreenshotPath, [
    "--mobile",
    "--width",
    "390",
    "--height",
    "844",
    "--device-scale",
    "3",
  ]);

  const desktopDimensions = readPngDimensions(desktopScreenshotPath);
  const mobileDimensions = readPngDimensions(mobileScreenshotPath);
  assertMinimum1080p(desktopDimensions);
  assertMinimum1080p(mobileDimensions);

  const appUrl = new URL(`http://127.0.0.1:${clientPort}`);
  const state = JSON.parse(readFileSync(statePath, "utf8")) as { pilotId: string };
  appUrl.searchParams.set("pilotId", state.pilotId);
  const desktopCanvas = await inspectCanvas(appUrl.toString(), { width: 1920, height: 1080 });
  const mobileCanvas = await inspectCanvas(appUrl.toString(), {
    width: 390,
    height: 844,
    deviceScaleFactor: 3,
    isMobile: true,
  });

  if (desktopCanvas.uniqueColors < 2 || desktopCanvas.nonZeroSamples < 4) {
    throw new Error(`Desktop canvas appears blank: ${JSON.stringify(desktopCanvas)}`);
  }
  if (mobileCanvas.uniqueColors < 2 || mobileCanvas.nonZeroSamples < 4) {
    throw new Error(`Mobile canvas appears blank: ${JSON.stringify(mobileCanvas)}`);
  }

  const touchUi = await inspectTouchUi(appUrl.toString());

  console.log(
    JSON.stringify(
      {
        screenshots: [
          { path: desktopScreenshotPath, dimensions: desktopDimensions },
          { path: mobileScreenshotPath, dimensions: mobileDimensions },
        ],
        canvas: {
          desktop: desktopCanvas,
          mobile: mobileCanvas,
        },
        touchUi,
      },
      null,
      2,
    ),
  );
} finally {
  server.kill();
  client.kill();
  if (existsSync(statePath)) {
    rmSync(statePath);
  }
  if (existsSync(dbPath)) {
    rmSync(dbPath);
  }
}

async function cliScreenshot(path: string, args: string[]): Promise<void> {
  await run(
    [
      "bun",
      "src/cli/main.ts",
      "screenshot",
      "--server",
      `http://127.0.0.1:${serverPort}`,
      "--state",
      statePath,
      "--app-url",
      `http://127.0.0.1:${clientPort}`,
      "--out",
      path,
      ...args,
    ],
    {},
  );
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

async function run(command: string[], env: Record<string, string>): Promise<void> {
  const proc = Bun.spawn(command, {
    env: {
      ...process.env,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    const stdout = await new Response(proc.stdout).text();
    throw new Error(`Command failed: ${command.join(" ")}\n${stdout}\n${stderr}`);
  }
}

function readPngDimensions(path: string): { width: number; height: number } {
  const bytes = readFileSync(path);
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  };
}

function assertMinimum1080p(dimensions: { width: number; height: number }): void {
  if (
    dimensions.width < 1080 ||
    dimensions.height < 1080 ||
    dimensions.width * dimensions.height < 1920 * 1080
  ) {
    throw new Error(
      `Screenshot was ${dimensions.width}x${dimensions.height}, expected at least 1080p pixel area.`,
    );
  }
}

async function inspectCanvas(
  url: string,
  viewport: { width: number; height: number; deviceScaleFactor?: number; isMobile?: boolean },
): Promise<{
  canvasWidth: number;
  canvasHeight: number;
  uniqueColors: number;
  nonZeroSamples: number;
}> {
  const browser = await chromium.launch(webgpuLaunchOptions);
  const page = await browser.newPage({
    viewport: {
      width: viewport.width,
      height: viewport.height,
    },
    deviceScaleFactor: viewport.deviceScaleFactor ?? 1,
    isMobile: viewport.isMobile ?? false,
  });
  try {
    await page.goto(url, { waitUntil: "networkidle" });
    await page.waitForSelector("[data-testid='haystack-app']", { timeout: 15000 });
    const canvas = page.locator("canvas").first();
    await canvas.waitFor({ timeout: 15000 });
    await page.waitForTimeout(700);
    if (viewport.isMobile === true) {
      await assertMobileChromeSpacing(page);
    }
    const screenshot = await canvas.screenshot();
    const stats = inspectPng(screenshot);
    return {
      canvasWidth: stats.width,
      canvasHeight: stats.height,
      uniqueColors: stats.uniqueColors,
      nonZeroSamples: stats.nonZeroSamples,
    };
  } finally {
    await browser.close();
  }
}

async function assertMobileChromeSpacing(page: Page): Promise<void> {
  // Windows boot closed (2e43cf2) — open the one whose bounds this check measures.
  await openWindow(page, "flight");
  const topRail = await page.getByTestId("top-rail").boundingBox();
  const flightWindow = await page.getByTestId("window-flight").boundingBox();
  const firstNeocomButton = await page.locator("[data-testid^='neocom-']").first().boundingBox();
  const windowLayer = await page.locator(".window-layer").boundingBox();
  const hud = await page.getByTestId("hud-cluster").boundingBox();
  if (
    topRail === null ||
    flightWindow === null ||
    firstNeocomButton === null ||
    windowLayer === null ||
    hud === null
  ) {
    throw new Error("Mobile chrome spacing check could not find required UI bounds.");
  }

  const reservedBottom = topRail.y + topRail.height + 6;
  if (flightWindow.y < reservedBottom) {
    throw new Error(
      `Mobile flight window overlaps top rail: ${JSON.stringify({ topRail, flightWindow })}`,
    );
  }
  if (firstNeocomButton.y < reservedBottom) {
    throw new Error(
      `Mobile Neocom overlaps top rail: ${JSON.stringify({ topRail, firstNeocomButton })}`,
    );
  }
  if (windowLayer.y + windowLayer.height > hud.y - 6) {
    throw new Error(`Mobile window layer overlaps HUD: ${JSON.stringify({ windowLayer, hud })}`);
  }
}

// Touch-device layout assertions (the capability-gated .touch-ui scheme, distinct from
// the width-driven mobile pass above): the stick zones/buttons render in landscape,
// safe-area offsets hold under a simulated notch, windows open as full-screen sheets,
// and portrait shows the rotate prompt.
async function inspectTouchUi(url: string): Promise<Record<string, unknown>> {
  const browser = await chromium.launch(webgpuLaunchOptions);
  try {
    const landscape = await browser.newContext({
      viewport: { width: 844, height: 390 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
    });
    const page = await landscape.newPage();
    const touchUrl = new URL(url);
    touchUrl.searchParams.set("touch", "1");
    await page.goto(touchUrl.toString(), { waitUntil: "networkidle" });
    await page.waitForSelector("[data-testid='haystack-app']", { timeout: 15000 });
    // Simulated landscape-iPhone notch (left 47px) + home indicator (bottom 21px);
    // headless Chromium has no real env(safe-area-inset-*) source.
    await page.addStyleTag({ content: ":root { --safe-left: 47px; --safe-bottom: 21px; }" });
    await page.waitForTimeout(400);

    for (const id of [
      "touch-controls",
      "touch-zone-left",
      "touch-zone-right",
      "touch-btn-boost",
      "touch-btn-stabilize",
      "touch-btn-cruise",
      "touch-btn-camera",
    ]) {
      if ((await page.getByTestId(id).count()) !== 1) {
        throw new Error(`Touch UI missing ${id} in landscape.`);
      }
    }
    if ((await page.getByTestId("rotate-prompt").count()) !== 0) {
      throw new Error("Rotate prompt must not render in landscape.");
    }
    const boost = await page.getByTestId("touch-btn-boost").boundingBox();
    if (boost === null || (boost.width < 44 && boost.height < 44)) {
      throw new Error(`Touch target under 44px: ${JSON.stringify(boost)}`);
    }

    // Safe areas: the neocom buttons clear the simulated notch; the HUD cluster clears
    // the home indicator.
    const neocomButton = await page.locator("[data-testid^='neocom-']").first().boundingBox();
    if (neocomButton === null || neocomButton.x < 47) {
      throw new Error(`Neocom does not clear the notch: ${JSON.stringify(neocomButton)}`);
    }
    const hud = await page.getByTestId("hud-cluster").boundingBox();
    if (hud === null || hud.y + hud.height > 390 - 21 + 1) {
      throw new Error(`HUD cluster under the home indicator: ${JSON.stringify(hud)}`);
    }

    // Windows open as full-screen sheets: at least 90% of the width between the rails,
    // top below the top rail.
    await page.getByTestId("neocom-scanner").tap();
    await page.waitForSelector("[data-testid='window-scanner']");
    const sheet = await page.getByTestId("window-scanner").boundingBox();
    const topRail = await page.getByTestId("top-rail").boundingBox();
    if (sheet === null || topRail === null) {
      throw new Error("Sheet/top-rail bounds missing.");
    }
    if (sheet.width < 0.8 * 844 || sheet.y < topRail.y + topRail.height - 8) {
      throw new Error(`Scanner is not a sane sheet: ${JSON.stringify({ sheet, topRail })}`);
    }
    const landscapeShot = resolve("screenshots", "haystack-e2e-touch-landscape.png");
    await page.screenshot({ path: landscapeShot });
    await landscape.close();

    // Portrait: the rotate prompt covers the screen (windows/HUD stay mounted under it).
    const portrait = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
    });
    const portraitPage = await portrait.newPage();
    await portraitPage.goto(touchUrl.toString(), { waitUntil: "networkidle" });
    await portraitPage.waitForSelector("[data-testid='haystack-app']", { timeout: 15000 });
    await portraitPage.waitForSelector("[data-testid='rotate-prompt']", { timeout: 5000 });
    const prompt = await portraitPage.getByTestId("rotate-prompt").boundingBox();
    if (prompt === null || prompt.width < 380 || prompt.height < 800) {
      throw new Error(`Rotate prompt does not cover portrait: ${JSON.stringify(prompt)}`);
    }
    const portraitShot = resolve("screenshots", "haystack-e2e-touch-portrait.png");
    await portraitPage.screenshot({ path: portraitShot });
    await portrait.close();

    return {
      landscape: { sticks: true, safeAreas: true, sheet: true, screenshot: landscapeShot },
      portrait: { rotatePrompt: true, screenshot: portraitShot },
    };
  } finally {
    await browser.close();
  }
}

function inspectPng(buffer: Buffer): {
  width: number;
  height: number;
  uniqueColors: number;
  nonZeroSamples: number;
} {
  const png = PNG.sync.read(buffer);
  const colors = new Set<string>();
  let nonZeroSamples = 0;

  for (let yIndex = 0; yIndex < 17; yIndex += 1) {
    for (let xIndex = 0; xIndex < 17; xIndex += 1) {
      const x = Math.max(0, Math.min(png.width - 1, Math.floor((png.width * xIndex) / 16)));
      const y = Math.max(0, Math.min(png.height - 1, Math.floor((png.height * yIndex) / 16)));
      const offset = (y * png.width + x) * 4;
      const red = png.data[offset] ?? 0;
      const green = png.data[offset + 1] ?? 0;
      const blue = png.data[offset + 2] ?? 0;
      const alpha = png.data[offset + 3] ?? 0;
      colors.add(`${red},${green},${blue},${alpha}`);
      if (red + green + blue + alpha > 0) {
        nonZeroSamples += 1;
      }
    }
  }

  return {
    width: png.width,
    height: png.height,
    uniqueColors: colors.size,
    nonZeroSamples,
  };
}
