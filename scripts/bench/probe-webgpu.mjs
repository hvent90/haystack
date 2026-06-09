// Probe: can Playwright Chromium obtain a WebGPU adapter in THIS environment?
// This is the gating fact for whether we can run real GPU parity gates headless.
import { chromium } from "playwright";

const flagSets = [
  { name: "headless-new + unsafe-webgpu", headless: true, args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan,WebGPU"] },
  { name: "headless default + unsafe-webgpu", headless: true, args: ["--enable-unsafe-webgpu"] },
  { name: "headed + unsafe-webgpu", headless: false, args: ["--enable-unsafe-webgpu"] },
];

for (const fs of flagSets) {
  let browser;
  try {
    browser = await chromium.launch({ headless: fs.headless, args: fs.args });
    const page = await browser.newPage();
    await page.goto("about:blank");
    const result = await page.evaluate(async () => {
      if (!navigator.gpu) return { gpu: false };
      try {
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) return { gpu: true, adapter: false };
        const info = adapter.info || (adapter.requestAdapterInfo ? await adapter.requestAdapterInfo() : {});
        const device = await adapter.requestDevice();
        // tiny compute smoke test: write 0..63 into a buffer, read back
        const N = 64;
        const out = device.createBuffer({ size: N * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
        const read = device.createBuffer({ size: N * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        const mod = device.createShaderModule({ code: `
          @group(0) @binding(0) var<storage, read_write> o: array<u32>;
          @compute @workgroup_size(64) fn main(@builtin(global_invocation_id) gid: vec3<u32>) { o[gid.x] = gid.x * 2u; }
        `});
        const pipe = device.createComputePipeline({ layout: "auto", compute: { module: mod, entryPoint: "main" } });
        const bg = device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: out } }] });
        const enc = device.createCommandEncoder();
        const pass = enc.beginComputePass();
        pass.setPipeline(pipe); pass.setBindGroup(0, bg); pass.dispatchWorkgroups(1); pass.end();
        enc.copyBufferToBuffer(out, 0, read, 0, N * 4);
        device.queue.submit([enc.finish()]);
        await read.mapAsync(GPUMapMode.READ);
        const arr = Array.from(new Uint32Array(read.getMappedRange().slice(0)));
        read.unmap();
        const ok = arr.every((v, i) => v === i * 2);
        return { gpu: true, adapter: true, vendor: info.vendor, architecture: info.architecture, description: info.description, computeOK: ok, sample: arr.slice(0, 4) };
      } catch (e) {
        return { gpu: true, error: String(e && e.message || e) };
      }
    });
    console.log(`[${fs.name}]`, JSON.stringify(result));
    await browser.close();
    if (result.computeOK) { console.log("WEBGPU_COMPUTE_AVAILABLE=true"); break; }
  } catch (e) {
    console.log(`[${fs.name}] LAUNCH/ERR:`, String(e && e.message || e));
    try { await browser?.close(); } catch {}
  }
}
