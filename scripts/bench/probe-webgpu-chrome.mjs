import { chromium } from "playwright";
for (const channel of ["chrome", "msedge", "chrome-beta"]) {
  let browser;
  try {
    browser = await chromium.launch({
      channel,
      headless: true,
      args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan,WebGPU"],
    });
    const page = await browser.newPage();
    await page.goto("about:blank");
    const r = await page.evaluate(async () => {
      if (!navigator.gpu) return { gpu: false };
      const a = await navigator.gpu.requestAdapter();
      if (!a) return { gpu: true, adapter: false };
      return {
        gpu: true,
        adapter: true,
        info: a.info
          ? { vendor: a.info.vendor, arch: a.info.architecture, desc: a.info.description }
          : "no-info",
      };
    });
    console.log(`[channel=${channel} headless]`, JSON.stringify(r));
    await browser.close();
    if (r.adapter) {
      console.log("FOUND_WEBGPU_CHANNEL=" + channel);
      break;
    }
  } catch (e) {
    console.log(`[channel=${channel}] ERR:`, String((e && e.message) || e).split("\n")[0]);
    try {
      await browser?.close();
    } catch {}
  }
}
