// Real on-GPU verification runner for the committed WebGPU asteroid work.
//
// Discovered via the webgpu-verification-paths workflow: WebGPU needs a SECURE CONTEXT, so the
// page MUST be served from localhost/127.0.0.1 (about:blank/data: have no navigator.gpu). Served
// from 127.0.0.1, the bundled Playwright Chromium exposes a SwiftShader WebGPU device HEADLESS
// with zero installs (system Chrome via CHROME_PATH gives real Metal as a higher-fidelity check).
//
// It boots the repo's OWN harness (gpu-verify.html -> verify-entry.ts -> verify-gpu.ts), which
// runs the two END-STATE gates on a live device: base round-trip (§8.6 #3) and binner scan (§2.3).
//
// Usage:  node scripts/bench/gpu-verify-run.mjs        (bundled Chromium / SwiftShader)
//         CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" node scripts/bench/gpu-verify-run.mjs
// Exits 0 iff every gate prints PASS.
import { chromium } from "playwright";
import { spawn } from "node:child_process";

const PORT = Number(process.env.GPU_VERIFY_PORT ?? "5174");
const URL = `http://127.0.0.1:${PORT}/gpu-verify.html`;

async function waitForServer(url, timeoutMs = 30000) {
  const start = Date.now();
  for (;;) {
    try {
      const r = await fetch(url);
      if (r.ok || r.status === 200) return;
    } catch {}
    if (Date.now() - start > timeoutMs)
      throw new Error(`vite not ready at ${url} after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

const vite = spawn(
  "./node_modules/.bin/vite",
  ["--host", "127.0.0.1", "--port", String(PORT), "--strictPort"],
  {
    stdio: ["ignore", "pipe", "pipe"],
  },
);
vite.stdout.on("data", () => {});
vite.stderr.on("data", () => {});

let exitCode = 1;
try {
  await waitForServer(`http://127.0.0.1:${PORT}/`);

  const args = [
    "--enable-unsafe-webgpu",
    "--enable-unsafe-swiftshader",
    "--use-mock-keychain",
    "--password-store=basic",
  ];
  const launchOpts = { headless: true, args };
  if (process.env.CHROME_PATH) launchOpts.executablePath = process.env.CHROME_PATH;

  const browser = await chromium.launch(launchOpts);
  const page = await browser.newPage();
  const consoleLines = [];
  page.on("console", (m) => consoleLines.push(m.text()));
  page.on("pageerror", (e) => consoleLines.push(`[pageerror] ${e.message}`));

  await page.goto(URL, { waitUntil: "networkidle" });
  // The harness runs async gates after device init; give it time, then read the report.
  await page
    .waitForFunction(
      () =>
        /ALL PASS|FAILURES|requires WebGPU/.test(document.getElementById("root")?.innerText ?? ""),
      { timeout: 20000 },
    )
    .catch(() => {});
  await page.waitForTimeout(1500);

  const adapterInfo = await page.evaluate(async () => {
    if (!navigator.gpu) return "navigator.gpu ABSENT";
    const a = await navigator.gpu.requestAdapter();
    const i = a?.info ?? {};
    return `${i.vendor ?? "?"}/${i.architecture ?? "?"}/${i.description ?? "?"}`;
  });
  const rootText = await page.evaluate(
    () => document.getElementById("root")?.innerText ?? "(no #root)",
  );

  console.log(`=== adapter: ${adapterInfo} ===`);
  console.log("=== console ===");
  for (const l of consoleLines) console.log(l);
  console.log("=== #root ===");
  console.log(rootText);

  await browser.close();
  exitCode = /ALL PASS/.test(rootText) ? 0 : 1;
  console.log(exitCode === 0 ? "GPU_VERIFY_RESULT=PASS" : "GPU_VERIFY_RESULT=FAIL");
} catch (e) {
  console.log("RUNNER_ERROR:", e?.message ?? String(e));
} finally {
  vite.kill("SIGTERM");
}
process.exit(exitCode);
