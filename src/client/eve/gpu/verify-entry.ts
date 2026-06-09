// DOM entry for the on-GPU verification harness. Loaded by /gpu-verify.html.
//
// Run on a REAL GPU: `bun run dev:client`, then open http://localhost:5173/gpu-verify.html in a
// Chrome where chrome://gpu shows "WebGPU: Hardware accelerated". It boots a WebGPURenderer and
// runs the END-STATE base round-trip + binner scan gates, printing PASS/FAIL to the page.
//
// NOT executed in the build env (no navigator.gpu). Authored + typechecked only.

import * as THREE from "three/webgpu";

import { assertWebGPU } from "./capability";
import { runGpuVerification, type GateResult } from "./verify-gpu";

function render(lines: { title: string; results: GateResult[] } | { error: string }): void {
  const root = document.getElementById("root") ?? document.body;
  if ("error" in lines) {
    root.innerHTML = `<pre style="color:#f66;font:14px monospace;padding:16px">${lines.error}</pre>`;
    return;
  }
  const rows = lines.results
    .map((r) => {
      const tag = r.pass ? "PASS" : "FAIL";
      const color = r.pass ? "#6f6" : "#f66";
      return `<div style="margin:8px 0"><span style="color:${color};font-weight:bold">[${tag}]</span> ${r.name}<br><span style="color:#999;padding-left:16px">${r.detail}</span></div>`;
    })
    .join("");
  const allPass = lines.results.every((r) => r.pass);
  root.innerHTML =
    `<div style="font:14px monospace;padding:16px;background:#111;color:#ddd;min-height:100vh">` +
    `<h2 style="color:${allPass ? "#6f6" : "#f66"}">${lines.title} — ${allPass ? "ALL PASS" : "FAILURES"}</h2>` +
    rows +
    `</div>`;
}

async function main(): Promise<void> {
  try {
    await assertWebGPU();
  } catch (err) {
    render({ error: err instanceof Error ? err.message : String(err) });
    return;
  }

  const canvas = document.createElement("canvas");
  canvas.width = 16;
  canvas.height = 16; // offscreen-ish; we only need a device, not a visible draw
  document.body.appendChild(canvas);

  const renderer = new THREE.WebGPURenderer({ canvas });
  await renderer.init();

  // eslint-disable-next-line no-console
  console.log("[gpu-verify] WebGPU device initialized; running gates…");
  const results = await runGpuVerification(renderer);
  for (const r of results) {
    // eslint-disable-next-line no-console
    console.log(`[gpu-verify] ${r.pass ? "PASS" : "FAIL"} — ${r.name} :: ${r.detail}`);
  }
  render({ title: "GPU asteroid verification", results });
  renderer.dispose();
}

void main();
