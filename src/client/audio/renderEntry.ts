import { boost, brake, chime, comms, scanHonk, targetLock, uiClick, uiHover } from "./sfx/catalog";
import { renderOneShot } from "./sfx/renderOneShot";

export interface RenderedSample {
  name: string;
  sampleRate: number;
  pcm: number[];
}

const SAMPLE_RATE = 44100;

const RECIPES = { uiClick, uiHover, targetLock, comms, chime, boost, brake, scanHonk };

/** Render every implemented sound to PCM. Plan 2/3 add entries here. */
export async function renderSamples(): Promise<RenderedSample[]> {
  const out: RenderedSample[] = [];
  for (const [name, spec] of Object.entries(RECIPES)) {
    const buffer = await renderOneShot(spec);
    out.push({ name, sampleRate: SAMPLE_RATE, pcm: Array.from(buffer.getChannelData(0)) });
  }
  return out;
}

declare global {
  interface Window {
    renderSamples?: () => Promise<RenderedSample[]>;
  }
}

if (typeof window !== "undefined") {
  window.renderSamples = renderSamples;
}
