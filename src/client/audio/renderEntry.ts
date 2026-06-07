import { EngineDrone } from "./drone";
import { boost, brake, chime, comms, scanHonk, targetLock, uiClick, uiHover } from "./sfx/catalog";
import { renderOneShot } from "./sfx/renderOneShot";

export interface RenderedSample {
  name: string;
  sampleRate: number;
  pcm: number[];
}

const SAMPLE_RATE = 44100;

const RECIPES = { uiClick, uiHover, targetLock, comms, chime, boost, brake, scanHonk };

/** Scripted offline drone capture: idle -> full throttle -> overheat whine -> cruise. */
async function renderDroneCapture(): Promise<RenderedSample> {
  const seconds = 6;
  const ctx = new OfflineAudioContext(1, Math.ceil(seconds * SAMPLE_RATE), SAMPLE_RATE);
  const drone = new EngineDrone(ctx, ctx.destination);
  drone.start(0);
  drone.setState({ throttle: 0, boost: false, heat: 10, cruiseLock: false, speed: 0 }, 0);
  drone.setState({ throttle: 1, boost: false, heat: 20, cruiseLock: false, speed: 80 }, 1.5);
  drone.boost(2.5);
  drone.setState({ throttle: 1, boost: false, heat: 95, cruiseLock: false, speed: 90 }, 3);
  drone.setState({ throttle: 0.3, boost: false, heat: 60, cruiseLock: true, speed: 30 }, 4.5);
  const buffer = await ctx.startRendering();
  return {
    name: "engineDrone",
    sampleRate: SAMPLE_RATE,
    pcm: Array.from(buffer.getChannelData(0)),
  };
}

/** Render every implemented sound to PCM. Plan 2/3 add entries here. */
export async function renderSamples(): Promise<RenderedSample[]> {
  const out: RenderedSample[] = [];
  for (const [name, spec] of Object.entries(RECIPES)) {
    const buffer = await renderOneShot(spec);
    out.push({ name, sampleRate: SAMPLE_RATE, pcm: Array.from(buffer.getChannelData(0)) });
  }
  out.push(await renderDroneCapture());
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
