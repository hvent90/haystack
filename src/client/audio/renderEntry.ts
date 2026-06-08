import { EngineDrone } from "./drone";
import { RcsNozzle } from "./nozzle";
import { boost, brake, chime, comms, scanHonk, targetLock, uiClick, uiHover } from "./sfx/catalog";
import { renderOneShot } from "./sfx/renderOneShot";

export interface RenderedSample {
  name: string;
  sampleRate: number;
  pcm: number[];
}

const SAMPLE_RATE = 44100;

const RECIPES = { uiClick, uiHover, targetLock, comms, chime, boost, brake, scanHonk };

/** Scripted offline drone capture: idle -> main throttle burn -> small strafe nudge -> strafe burst.
 * Heat kept low so the demo showcases the roar (strafe = "regular thruster"), not the heat whine. */
async function renderDroneCapture(): Promise<RenderedSample> {
  const seconds = 6;
  const ctx = new OfflineAudioContext(1, Math.ceil(seconds * SAMPLE_RATE), SAMPLE_RATE);
  const drone = new EngineDrone(ctx, ctx.destination);
  const idle = { throttle: 0, rcs: 0, rotation: 0, boost: false, heat: 12, cruiseLock: false };
  drone.start(0);
  drone.setState({ ...idle, speed: 0 }, 0);
  drone.setState({ ...idle, throttle: 1, speed: 80 }, 1.0); // main engine burn
  drone.boost(2.0);
  drone.setState({ ...idle, speed: 40 }, 2.6); // cut
  drone.setState({ ...idle, rcs: 0.18, speed: 40 }, 3.2); // minute strafe nudge
  drone.setState({ ...idle, rcs: 0.7, speed: 50 }, 4.2); // firmer strafe burst
  drone.setState({ ...idle, speed: 40 }, 5.2); // cut
  const buffer = await ctx.startRendering();
  return {
    name: "engineDrone",
    sampleRate: SAMPLE_RATE,
    pcm: Array.from(buffer.getChannelData(0)),
  };
}

/** Scripted offline nozzle capture: idle -> small rotation tap -> harder rotation -> sustained roll. */
async function renderNozzleCapture(): Promise<RenderedSample> {
  const seconds = 5;
  const ctx = new OfflineAudioContext(1, Math.ceil(seconds * SAMPLE_RATE), SAMPLE_RATE);
  const nozzle = new RcsNozzle(ctx, ctx.destination);
  const idle = { throttle: 0, rcs: 0, boost: false, heat: 0, cruiseLock: false, speed: 0 };
  nozzle.start(0);
  nozzle.setState({ ...idle, rotation: 0 }, 0);
  nozzle.setState({ ...idle, rotation: 0.2 }, 0.6); // small attitude tap
  nozzle.setState({ ...idle, rotation: 0 }, 1.2);
  nozzle.setState({ ...idle, rotation: 0.55 }, 1.8); // harder pitch/yaw
  nozzle.setState({ ...idle, rotation: 0 }, 2.4);
  nozzle.setState({ ...idle, rotation: 0.8 }, 3.0); // sustained roll
  nozzle.setState({ ...idle, rotation: 0 }, 4.4);
  const buffer = await ctx.startRendering();
  return {
    name: "rcsNozzle",
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
  out.push(await renderNozzleCapture());
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
