import { uiClick } from "./sfx/catalog";
import { renderOneShot } from "./sfx/renderOneShot";

export interface RenderedSample {
  name: string;
  sampleRate: number;
  pcm: number[];
}

const SAMPLE_RATE = 44100;

/** Render every implemented sound to PCM. Plan 2/3 add entries here. */
export async function renderSamples(): Promise<RenderedSample[]> {
  const buffer = await renderOneShot(uiClick);
  return [{ name: "uiClick", sampleRate: SAMPLE_RATE, pcm: Array.from(buffer.getChannelData(0)) }];
}

declare global {
  interface Window {
    renderSamples?: () => Promise<RenderedSample[]>;
  }
}

if (typeof window !== "undefined") {
  window.renderSamples = renderSamples;
}
