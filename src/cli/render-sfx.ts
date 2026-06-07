import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { chromium } from "playwright";

import { encodeWav } from "../client/audio/wav";
import type { RenderedSample } from "../client/audio/renderEntry";

const ENTRY = resolve(import.meta.dir, "../client/audio/renderEntry.ts");

/** Bundle the render entry, run it in a real browser, return rendered PCM. */
export async function renderSamples(): Promise<RenderedSample[]> {
  const built = await Bun.build({ entrypoints: [ENTRY], target: "browser", minify: false });
  if (!built.success) {
    throw new Error(`render entry build failed: ${built.logs.map(String).join("\n")}`);
  }
  const bundle = await built.outputs[0]!.text();

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto("about:blank");
    // Inject as a module so ESM export syntax is accepted; window.renderSamples is set on load.
    await page.addScriptTag({ content: bundle, type: "module" });
    await page.waitForFunction(() => typeof window.renderSamples === "function");
    return (await page.evaluate(() => window.renderSamples!())) as RenderedSample[];
  } finally {
    await browser.close();
  }
}

async function main(): Promise<void> {
  const outDir = resolve("samples");
  mkdirSync(outDir, { recursive: true });
  const samples = await renderSamples();
  for (const sample of samples) {
    const wav = encodeWav(sample.pcm, sample.sampleRate);
    const path = resolve(outDir, `${sample.name}.wav`);
    writeFileSync(path, wav);
    const peak = sample.pcm.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
    console.log(`wrote ${path} (${sample.pcm.length} frames, peak ${peak.toFixed(3)})`);
  }
}

if (import.meta.main) {
  await main();
}
