// Offline field preview harness — the asteroid-field design sketchbook.
//
// Bundles field-preview-entry.ts for the browser, injects it into headless
// Chromium with WebGPU enabled, renders one preset as color-coded instanced
// spheres, and writes PNGs to screenshots/field/.
//
// Usage:
//   bun src/cli/render-field-preview.ts --preset solo-pocket               # contact sheet (2/10/50 km)
//   bun src/cli/render-field-preview.ts --preset belt-v1 --zooms 10000,30000,56000
//   bun src/cli/render-field-preview.ts --preset belt-v1 --cam 0,4000,28000 --look 0,0,0 --fov 60
//   bun src/cli/render-field-preview.ts --preset solo-filament --no-stitch # one PNG per zoom
//
// --cam/--look give a single custom shot; otherwise a contact sheet is built
// from --zooms (default 2km/10km/50km), framed on the nearest cluster center
// so close-ups actually contain a cluster. CHROME_PATH (or auto-detected
// Chrome) gets a real Metal adapter; falls back to SwiftShader.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { chromium } from "playwright";

import { clustersNear, DEFAULT_GEOMETRY } from "../shared/field-factory";
import { PRESETS } from "../shared/field-presets";
import type { PreviewOpts, PreviewPanel, PreviewShot } from "./field-preview-entry";

const ENTRY = resolve(import.meta.dir, "field-preview-entry.ts");

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function vec(text: string): { x: number; y: number; z: number } {
  const [x = 0, y = 0, z = 0] = text.split(",").map(Number);
  return { x, y, z };
}

function detectChrome(): string | undefined {
  const envPath = process.env["CHROME_PATH"];
  if (envPath && existsSync(envPath)) {
    return envPath;
  }
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

function buildPanels(presetName: string): { panels: PreviewPanel[]; framing: string } {
  const camArg = arg("cam");
  const fov = Number(arg("fov") ?? 60);
  if (camArg !== undefined) {
    const cam = vec(camArg);
    const look = vec(arg("look") ?? "0,0,0");
    const dist = Math.hypot(cam.x - look.x, cam.y - look.y, cam.z - look.z);
    return {
      framing: "custom",
      panels: [
        {
          label: `${(dist / 1000).toFixed(1)} km`,
          camPos: cam,
          lookAt: look,
          fov,
          queryRadius: Number(arg("radius") ?? Math.max(4000, dist * 1.4)),
          minWorldRadius: dist * 0.0038,
        },
      ],
    };
  }

  // contact sheet: frame on the nearest cluster center (falls back to field
  // center for cluster-less presets like legacy/belt wide shots)
  const preset = PRESETS[presetName];
  if (preset === undefined) {
    throw new Error(`unknown preset: ${presetName} (have: ${Object.keys(PRESETS).join(", ")})`);
  }
  let target = { x: 0, y: 0, z: 0 };
  let framing = "field center";
  // slightly elevated diagonal view direction (overridden per-cluster below)
  let dir = { x: 0.46, y: 0.36, z: 0.81 };
  if (!preset.legacy && preset.archetypes.length > 0) {
    const clusters = clustersNear(DEFAULT_GEOMETRY, preset, target, 12000);
    const pick = Number(arg("cluster") ?? 0);
    const cluster = clusters[Math.min(pick, clusters.length - 1)];
    if (cluster !== undefined) {
      target = cluster.center;
      framing = `${cluster.name} cluster @ (${target.x.toFixed(0)}, ${target.y.toFixed(0)}, ${target.z.toFixed(0)})`;
      // look perpendicular to the cluster's axis so filaments/sheets/rings
      // present their long side, with a slight elevation off the exact normal
      const a = cluster.axis;
      const helper = Math.abs(a.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
      const perp = {
        x: a.y * helper.z - a.z * helper.y,
        y: a.z * helper.x - a.x * helper.z,
        z: a.x * helper.y - a.y * helper.x,
      };
      const norm = Math.hypot(perp.x, perp.y, perp.z) || 1;
      // rings/sheets read best tilted ~35° off their plane; filaments/pockets
      // straight-on perpendicular with a touch of lift
      const tilt = cluster.kind === "ring" || cluster.kind === "sheet" ? 0.7 : 0.25;
      dir = {
        x: perp.x / norm + a.x * tilt,
        y: perp.y / norm + a.y * tilt,
        z: perp.z / norm + a.z * tilt,
      };
      const dlen = Math.hypot(dir.x, dir.y, dir.z);
      dir = { x: dir.x / dlen, y: dir.y / dlen, z: dir.z / dlen };
    }
  }
  const zooms = (arg("zooms") ?? "2000,10000,50000").split(",").map(Number);
  const panels = zooms.map((dist): PreviewPanel => ({
    label: dist >= 1000 ? `${(dist / 1000).toFixed(0)} km` : `${dist} m`,
    camPos: {
      x: target.x + dir.x * dist,
      y: target.y + dir.y * dist,
      z: target.z + dir.z * dist,
    },
    lookAt: target,
    fov,
    queryRadius: Math.max(4000, dist * 1.4),
    minWorldRadius: dist * 0.0038,
  }));
  return { panels, framing };
}

async function main(): Promise<void> {
  const presetName = arg("preset") ?? "belt-v1";
  const note = arg("note") ?? "";
  const { panels, framing } = buildPanels(presetName);
  const opts: PreviewOpts = {
    preset: presetName,
    caption: note.length > 0 ? `${presetName} — ${note}` : presetName,
    panels,
    panelWidth: Number(arg("width") ?? 1100),
    panelHeight: Number(arg("height") ?? 700),
    stitch: !flag("no-stitch"),
  };

  const built = await Bun.build({ entrypoints: [ENTRY], target: "browser", minify: false });
  if (!built.success) {
    throw new Error(`render entry build failed: ${built.logs.map(String).join("\n")}`);
  }
  const bundle = await built.outputs[0]!.text();

  // WebGPU needs a secure context — about:blank has no navigator.gpu (see
  // gpu-verify-run.mjs). Serve the bundle from 127.0.0.1.
  const server = Bun.serve({
    port: 0,
    fetch(request: Request): Response {
      const path = new URL(request.url).pathname;
      if (path === "/entry.js") {
        return new Response(bundle, { headers: { "content-type": "text/javascript" } });
      }
      return new Response(
        `<!doctype html><html><body><script type="module" src="/entry.js"></script></body></html>`,
        { headers: { "content-type": "text/html" } },
      );
    },
  });

  const chromePath = detectChrome();
  const browser = await chromium.launch({
    ...(chromePath !== undefined ? { executablePath: chromePath } : {}),
    headless: true,
    args: ["--enable-unsafe-webgpu", "--enable-unsafe-swiftshader", "--hide-scrollbars"],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.on("console", (message) => {
      if (message.type() === "error" || message.text().startsWith("[preview]")) {
        console.error(`[page] ${message.text()}`);
      }
    });
    page.on("pageerror", (error) => console.error(`[pageerror] ${error.message}`));
    await page.goto(`http://127.0.0.1:${server.port}/`);
    await page.waitForFunction(() => typeof window.renderFieldPreview === "function");
    const start = performance.now();
    const shots = (await page.evaluate(
      (json) => window.renderFieldPreview!(JSON.parse(json)),
      JSON.stringify(opts),
    )) as PreviewShot[];
    const ms = performance.now() - start;

    const outDir = resolve(arg("out") ?? "screenshots/field");
    mkdirSync(outDir, { recursive: true });
    for (const shot of shots) {
      const path = resolve(outDir, `${shot.name}.png`);
      writeFileSync(path, Buffer.from(shot.dataUrl.split(",")[1]!, "base64"));
      console.log(`wrote ${path} (${shot.rockCount} rocks)`);
    }
    console.log(
      `framing: ${framing}  ·  render ${ms.toFixed(0)}ms  ·  ${chromePath ?? "playwright chromium (SwiftShader)"}`,
    );
  } finally {
    await browser.close();
    server.stop(true);
  }
}

if (import.meta.main) {
  await main();
}
