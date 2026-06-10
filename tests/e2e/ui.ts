import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { chromium, type Browser, type Page } from "playwright";

import type { Pilot, WorldSnapshot } from "../../src/shared/types";
import {
  assert,
  captureTraffic,
  count,
  pollUntil,
  webgpuLaunchOptions,
  openWindow,
} from "./helpers";

const serverPort = 8801;
const clientPort = 5201;
const dbPath = resolve(tmpdir(), `haystack-ui-${Date.now()}.sqlite`);
const serverUrl = `http://127.0.0.1:${serverPort}`;
const clientUrl = `http://127.0.0.1:${clientPort}`;

const server = Bun.spawn(["bun", "src/server/main.ts"], {
  env: { ...process.env, PORT: String(serverPort), HAYSTACK_DB: dbPath },
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
      body: JSON.stringify({ callsign: `UI-Probe-${Date.now()}`, organization: "Needle Testers" }),
    })
  ).pilot;
  await api(`/api/ships/${encodeURIComponent(pilot.id)}/scan`, {
    method: "POST",
    body: JSON.stringify({ mode: "pocket" }),
  });

  browser = await chromium.launch(webgpuLaunchOptions);
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  const traffic = captureTraffic(page);
  const url = new URL(clientUrl);
  url.searchParams.set("pilotId", pilot.id);
  await page.goto(url.toString(), { waitUntil: "networkidle" });
  await page.waitForSelector("[data-testid='haystack-app']", { timeout: 15000 });

  await verifyChrome(page, pilot.id);
  await verifyOverviewAndSelection(page, traffic);
  await verifyHudAndFlight(page, pilot.id);
  await verifyCoreWindows(page);

  console.log(JSON.stringify({ appUrl: clientUrl, pilotId: pilot.id, ui: "ok" }, null, 2));
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

async function verifyChrome(page: Page, pilotId: string): Promise<void> {
  assert((await count(page, "[data-testid='neocom']")) === 1, "neocom present");
  const neocomButtons = await page.$$eval("[data-testid^='neocom-']", (nodes) =>
    nodes.map((node) => node.getAttribute("data-testid")),
  );
  assert(neocomButtons.length === 7, `expected seven neocom buttons, got ${neocomButtons.length}`);
  assert(
    !neocomButtons.some((id) => /upgrade|market|fitting|industry|fleet|drones|pi/.test(id ?? "")),
    "no forbidden neocom buttons",
  );

  // The default layout boots with every window CLOSED (2e43cf2) — this suite predates
  // that and used to find them already open. Open each through the neocom (the user
  // path) before asserting its chrome.
  for (const key of ["flight", "scanner", "cargo", "comms", "character", "bases", "settings"]) {
    await page.getByTestId(`neocom-${key}`).click();
    await page.waitForSelector(`[data-testid='window-${key}']`);
    await page.waitForSelector(`[data-testid='window-${key}-close']`);
    await page.waitForSelector(`[data-testid='window-${key}-resize-se']`);
  }

  const canvasBox = await page.locator("[data-testid='world-canvas']").boundingBox();
  assert(canvasBox !== null, "world canvas has bbox");
  assert(canvasBox.width >= 1900 && canvasBox.height >= 1070, "canvas is full viewport");

  const reticleEvents = await page
    .getByTestId("hud-reticle")
    .evaluate((node) => getComputedStyle(node).pointerEvents);
  assert(reticleEvents === "none", "reticle is non-interactive");

  const badBodies = await page.$$eval("[data-testid^='window-'][data-testid$='-body']", (nodes) =>
    nodes
      .filter((node) => {
        const parts = (getComputedStyle(node).backgroundColor.match(/[\d.]+/g) ?? []).map(Number);
        const [r = 0, g = 0, b = 0] = parts;
        const alpha = parts[3] ?? 1;
        const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
        return alpha >= 0.95 || luminance > 0.18;
      })
      .map((node) => node.getAttribute("data-testid")),
  );
  assert(badBodies.length === 0, `window bodies are dark/translucent: ${badBodies.join(",")}`);

  const scannerBefore = await page.getByTestId("window-scanner").boundingBox();
  assert(scannerBefore !== null, "scanner bbox before drag");
  const scannerTitle = await page.getByTestId("window-scanner-titlebar").boundingBox();
  assert(scannerTitle !== null, "scanner titlebar bbox");
  await page.mouse.move(scannerTitle.x + 20, scannerTitle.y + 12);
  await page.mouse.down();
  await page.mouse.move(scannerTitle.x + 120, scannerTitle.y + 84, { steps: 6 });
  await page.mouse.up();
  const scannerAfter = await page.getByTestId("window-scanner").boundingBox();
  assert(
    scannerAfter !== null && scannerAfter.x > scannerBefore.x + 60,
    "scanner moved by title drag",
  );

  await page.getByTestId("window-cargo-titlebar").click();
  assert(
    (await page.getByTestId("window-cargo").getAttribute("data-focused")) === "true",
    "cargo receives z focus",
  );
  assert(
    (await page.getByTestId("window-scanner").getAttribute("data-focused")) === "false",
    "scanner yields z focus",
  );

  const cargoBefore = await page.getByTestId("window-cargo").boundingBox();
  assert(cargoBefore !== null, "cargo bbox before resize");
  const cargoResize = await page.getByTestId("window-cargo-resize-se").boundingBox();
  assert(cargoResize !== null, "cargo resize handle bbox");
  await page.mouse.move(
    cargoResize.x + cargoResize.width / 2,
    cargoResize.y + cargoResize.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    cargoResize.x + cargoResize.width / 2 + 90,
    cargoResize.y + cargoResize.height / 2 + 60,
    {
      steps: 6,
    },
  );
  await page.mouse.up();
  const cargoAfter = await page.getByTestId("window-cargo").boundingBox();
  assert(
    cargoAfter !== null && cargoAfter.width > cargoBefore.width + 40,
    "cargo width grows by resize",
  );
  assert(cargoAfter.height > cargoBefore.height + 30, "cargo height grows by resize");

  await page.getByTestId("window-cargo-close").click();
  assert((await count(page, "[data-testid='window-cargo']")) === 0, "cargo closes");
  assert(
    (await page.getByTestId("neocom-cargo").getAttribute("data-open")) === "false",
    "neocom reflects closed cargo",
  );
  await page.getByTestId("neocom-cargo").click();
  await page.waitForSelector("[data-testid='window-cargo']");

  await page.getByTestId("window-flight-minimize").click();
  assert(
    (await page.getByTestId("window-flight").getAttribute("data-minimized")) === "true",
    "flight minimizes",
  );
  await page.getByTestId("window-flight-minimize").click();
  assert(
    (await page.getByTestId("window-flight").getAttribute("data-minimized")) === "false",
    "flight restores",
  );

  const layoutBlob = await page.evaluate(
    (id) => localStorage.getItem(`haystack.layout.${id}`),
    pilotId,
  );
  assert(layoutBlob !== null && layoutBlob.includes("scanner"), "layout persisted under pilot key");
  await page.getByTestId("layout-reset").click();
  // Reset restores the default layout, which closes every window (2e43cf2). The
  // overview/selection phase below reads scanner rows — reopen it.
  await page.getByTestId("neocom-scanner").click();
  await page.waitForSelector("[data-testid='window-scanner']");
}

async function verifyOverviewAndSelection(
  page: Page,
  traffic: ReturnType<typeof captureTraffic>,
): Promise<void> {
  await page.waitForSelector("[data-testid='overview-row']", { timeout: 15000 });
  assert(
    (await count(page, "[data-testid='overview-col-distance']")) === 1,
    "distance column present",
  );

  const distances = await page.$$eval("[data-testid='overview-cell-distance']", (nodes) =>
    nodes.map((node) => Number(node.getAttribute("data-distance-m"))),
  );
  assert(
    distances.every((value, index) => index === 0 || (distances[index - 1] ?? -Infinity) <= value),
    "default distance sort ascending",
  );

  const beforeFrames = traffic.inputFrames().length;
  await page.getByTestId("overview-row").first().click();
  await page.getByTestId("overview-row").first().dblclick();
  assert(
    traffic.inputFrames().length === beforeFrames,
    "selection and double-click emit no input frames",
  );
  assert(
    (await count(page, "[data-testid='overview-row'][data-selected='true']")) === 1,
    "single selected overview row",
  );
  assert(
    (await page.getByTestId("selected-item-name").innerText()).trim().length > 0,
    "selected item populated",
  );

  await page.getByTestId("overview-filter-asteroids").click();
  const kinds = await page.$$eval("[data-testid='overview-row']", (nodes) =>
    nodes.map((node) => node.getAttribute("data-object-kind")),
  );
  assert(
    kinds.every((kind) => kind === "asteroid"),
    "asteroid filter only shows asteroids",
  );
  await page.getByTestId("overview-filter-all").click();

  await page.getByTestId("overview-row").first().click({ button: "right" });
  await page.waitForSelector("[data-testid='context-menu']");
  const contextText = (await page.getByTestId("context-menu").innerText()).toLowerCase();
  for (const banned of [
    "orbit",
    "approach",
    "warp",
    "align",
    "keep at range",
    "lock target",
    "autopilot",
  ]) {
    assert(!contextText.includes(banned), `context menu excludes ${banned}`);
  }
  assert(
    (await count(page, "[data-testid='context-item-show-info']")) === 1,
    "context show info present",
  );
  await page.keyboard.press("Escape");
}

async function verifyHudAndFlight(page: Page, pilotId: string): Promise<void> {
  await page.waitForSelector("[data-testid='hud-cluster']");
  assert(
    (await count(page, "[data-testid='hud-thrust-fwd']")) === 1,
    "forward thrust button present",
  );
  assert((await count(page, "[data-testid='hud-stabilize']")) === 1, "stabilize present");
  assert((await count(page, "[data-testid='hud-throttle']")) === 1, "throttle readout present");

  await verifyFlightVectorPips(page, pilotId);
  await verifyAimDeltaAlignment(page, pilotId);

  const before = await world(pilotId);
  await page.getByTestId("hud-thrust-fwd").click();
  const after = await pollUntil(
    () => world(pilotId),
    (snapshot) => {
      const ship = snapshot.ships.find((candidate) => candidate.pilotId === pilotId);
      const oldShip = before.ships.find((candidate) => candidate.pilotId === pilotId);
      return ship !== undefined && oldShip !== undefined && ship.velocity.z < oldShip.velocity.z;
    },
    10000,
  );
  assert(after.me !== null, "world still returns pilot scoped me");
}

async function verifyFlightVectorPips(page: Page, pilotId: string): Promise<void> {
  await api(`/api/ships/${encodeURIComponent(pilotId)}/thrust`, {
    method: "POST",
    body: JSON.stringify({ impulse: { x: 0, y: 0, z: -8 }, frame: "world" }),
  });
  await page.waitForSelector("[data-testid='velocity-vector']");
  assert(
    (await page.getByTestId("velocity-vector").boundingBox()) !== null,
    "velocity vector pip visible",
  );

  await api(`/api/ships/${encodeURIComponent(pilotId)}/thrust`, {
    method: "POST",
    body: JSON.stringify({ impulse: { x: 0, y: 0, z: 12 }, frame: "world" }),
  });
  await page.waitForSelector("[data-testid='reverse-velocity-vector']");
  assert(
    (await page.getByTestId("reverse-velocity-vector").boundingBox()) !== null,
    "reverse velocity vector pip visible",
  );
}

async function verifyAimDeltaAlignment(page: Page, pilotId: string): Promise<void> {
  await openWindow(page, "flight");
  await page.getByTestId("flight-mode-toggle").click();
  await page.waitForFunction(
    () =>
      document.querySelector("[data-testid='haystack-app']")?.getAttribute("data-flight-mode") ===
      "flight",
  );
  assert(
    (await page.getByTestId("flight-input-scale-meter").getAttribute("data-scale")) === "1.0000",
    "flight input scale meter starts at full scale",
  );
  await page.evaluate(() => {
    window.dispatchEvent(new WheelEvent("wheel", { deltaY: 960, bubbles: true, cancelable: true }));
  });
  await page.waitForFunction(() => {
    const scale = Number(
      document
        .querySelector("[data-testid='haystack-app']")
        ?.getAttribute("data-flight-input-scale"),
    );
    return Number.isFinite(scale) && scale < 0.5;
  });
  assert(
    (await page.getByTestId("flight-input-scale-pip").boundingBox()) !== null,
    "flight input scale pip visible",
  );
  assert(
    (await page
      .getByTestId("angular-stabilizer-ring")
      .getAttribute("data-threshold-degrees-per-second")) === "0.2",
    "angular stabilizer ring exposes the 0.2 deg/s cutoff",
  );
  assert(
    (await page.getByTestId("hud-reticle").getAttribute("data-angular-stable")) === "true",
    "center reticle exposes angular stable state at rest",
  );
  await api(`/api/ships/${encodeURIComponent(pilotId)}/thrust`, {
    method: "POST",
    body: JSON.stringify({
      impulse: { x: 0, y: 0, z: 0 },
      angularImpulse: { x: 0.2, y: 0, z: 0 },
      frame: "world",
    }),
  });
  const zoomedTorqueLength = await pollUntil(
    () => angularTorqueLineLength(page),
    (length) => length !== null && length > 10,
  );
  assert(zoomedTorqueLength !== null, "zoomed angular torque line length is measurable");
  await page.evaluate(() => {
    window.dispatchEvent(
      new WheelEvent("wheel", { deltaY: -4000, bubbles: true, cancelable: true }),
    );
  });
  await page.waitForFunction(
    () =>
      document
        .querySelector("[data-testid='haystack-app']")
        ?.getAttribute("data-flight-input-scale") === "1.0000",
  );
  const fullScaleTorqueLength = await pollUntil(
    () => angularTorqueLineLength(page),
    (length) => length !== null && length < zoomedTorqueLength * 0.5,
  );
  assert(fullScaleTorqueLength !== null, "full-scale angular torque line length is measurable");
  assert(
    fullScaleTorqueLength < zoomedTorqueLength,
    "angular torque line range shrinks as input scale drops",
  );
  await api(`/api/ships/${encodeURIComponent(pilotId)}/thrust`, {
    method: "POST",
    body: JSON.stringify({
      impulse: { x: 0, y: 0, z: 0 },
      angularImpulse: { x: 0, y: 0, z: 1.55 },
      frame: "world",
    }),
  });
  await page.waitForSelector("[data-testid='angular-roll-cap']", { state: "attached" });
  assert(
    /deg\/s/.test(await page.getByTestId("angular-speed-label").innerText()),
    "angular speed label reports degrees per second",
  );
  await page.evaluate(() => {
    const event = new MouseEvent("mousemove", { bubbles: true });
    Object.defineProperty(event, "movementX", { value: -240 });
    Object.defineProperty(event, "movementY", { value: 180 });
    document.dispatchEvent(event);
  });
  await page.waitForSelector("[data-testid='aim-delta-icon']");
  await page.waitForFunction(() => {
    const line = document.querySelector("[data-testid='angular-torque-line'] line");
    if (!(line instanceof SVGLineElement)) {
      return false;
    }
    const parsePercent = (value: string | null): number | null => {
      if (value === null || !value.endsWith("%")) {
        return null;
      }
      const parsed = Number(value.slice(0, -1));
      return Number.isFinite(parsed) ? parsed : null;
    };
    const x1 = parsePercent(line.getAttribute("x1"));
    const y1 = parsePercent(line.getAttribute("y1"));
    const x2 = parsePercent(line.getAttribute("x2"));
    const y2 = parsePercent(line.getAttribute("y2"));
    return x1 === 50 && y1 === 50 && x2 !== null && y2 !== null && x2 > 50 && y2 < 50;
  });

  const alignment = await page.evaluate(() => {
    const icon = document.querySelector("[data-testid='aim-delta-icon']");
    const svg = document.querySelector("[data-testid='aim-delta-line']");
    const line = svg?.querySelector("line");
    const layer = svg?.closest(".flight-vector-layer");
    if (
      !(icon instanceof HTMLElement) ||
      !(svg instanceof SVGSVGElement) ||
      !(line instanceof SVGLineElement) ||
      !(layer instanceof HTMLElement)
    ) {
      return null;
    }

    const parsePercent = (value: string | null): number | null => {
      if (value === null || !value.endsWith("%")) {
        return null;
      }
      const parsed = Number(value.slice(0, -1));
      return Number.isFinite(parsed) ? parsed : null;
    };
    const x2 = parsePercent(line.getAttribute("x2"));
    const y2 = parsePercent(line.getAttribute("y2"));
    if (x2 === null || y2 === null) {
      return null;
    }

    const iconBox = icon.getBoundingClientRect();
    const layerBox = layer.getBoundingClientRect();
    return {
      dx: Math.abs(
        iconBox.left + iconBox.width / 2 - (layerBox.left + (layerBox.width * x2) / 100),
      ),
      dy: Math.abs(
        iconBox.top + iconBox.height / 2 - (layerBox.top + (layerBox.height * y2) / 100),
      ),
    };
  });

  assert(alignment !== null, "aim delta overlay exposes measurable line and icon geometry");
  assert(alignment.dx <= 1 && alignment.dy <= 1, "aim delta line endpoint aligns with icon center");

  assert(
    (await count(page, "[data-testid='angular-roll-cap']")) === 1,
    "angular roll cap visible at max length",
  );

  await page.keyboard.press("AltLeft");
  await page.waitForFunction(
    () =>
      document.querySelector("[data-testid='haystack-app']")?.getAttribute("data-flight-mode") ===
      "cursor",
  );
}

async function angularTorqueLineLength(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const line = document.querySelector("[data-testid='angular-torque-line'] line");
    if (!(line instanceof SVGLineElement)) {
      return null;
    }
    const parsePercent = (value: string | null): number | null => {
      if (value === null || !value.endsWith("%")) {
        return null;
      }
      const parsed = Number(value.slice(0, -1));
      return Number.isFinite(parsed) ? parsed : null;
    };
    const x1 = parsePercent(line.getAttribute("x1"));
    const y1 = parsePercent(line.getAttribute("y1"));
    const x2 = parsePercent(line.getAttribute("x2"));
    const y2 = parsePercent(line.getAttribute("y2"));
    if (x1 === null || y1 === null || x2 === null || y2 === null) {
      return null;
    }
    return Math.hypot(x2 - x1, y2 - y1);
  });
}

async function verifyCoreWindows(page: Page): Promise<void> {
  // Window content only exists while open (the layout reset above closed everything).
  for (const key of ["cargo", "comms", "character", "bases"]) {
    await openWindow(page, key);
  }
  assert((await count(page, "[data-testid='cargo-capacity-bar']")) === 1, "cargo capacity bar");
  assert((await count(page, "[data-testid='cargo-sell']")) === 1, "cargo sell");
  assert((await count(page, "[data-testid='comms-tab-global']")) === 1, "global comms tab");
  assert((await count(page, "[data-testid='comms-local-count']")) === 1, "local count");
  assert((await count(page, ".pilot-card")) > 0, "legacy pilot-card preserved");
  assert((await count(page, "[data-testid='base-deploy-hab']")) === 1, "base deploy");
  assert((await count(page, "[data-testid='base-field-index']")) === 1, "field index");
  for (const system of ["cargo", "scanner", "mining", "stabilizer"]) {
    assert((await count(page, `[data-testid='upgrade-${system}']`)) === 1, `${system} upgrade`);
  }
  assert((await count(page, "[data-testid='window-upgrades']")) === 0, "no upgrades window");
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

async function world(pilotId: string): Promise<WorldSnapshot> {
  return api<WorldSnapshot>(`/api/world?${new URLSearchParams({ pilotId }).toString()}`);
}
