import { chromium } from "playwright";
let browser;
try {
  browser = await chromium.launch({
    channel: "chrome",
    headless: false,
    args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan,WebGPU", "--use-angle=metal"],
  });
  const page = await browser.newPage();
  await page.goto("about:blank");
  const r = await page.evaluate(async () => {
    if (!navigator.gpu) return { gpu: false };
    const a = await navigator.gpu.requestAdapter();
    if (!a) return { gpu: true, adapter: false };
    const d = await a.requestDevice();
    return {
      gpu: true,
      adapter: true,
      hasDevice: !!d,
      info: a.info
        ? { vendor: a.info.vendor, arch: a.info.architecture, desc: a.info.description }
        : "no-info",
    };
  });
  console.log("[channel=chrome HEADED]", JSON.stringify(r));
  await browser.close();
  if (r.adapter) console.log("FOUND_WEBGPU_HEADED=chrome");
} catch (e) {
  console.log("[headed chrome] ERR:", String((e && e.message) || e).split("\n")[0]);
  try {
    await browser?.close();
  } catch {}
}
