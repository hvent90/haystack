import { renderToBuffer } from "../synth/render";
import type { OneShotRender } from "./catalog";

/** Render a one-shot recipe to a cached AudioBuffer (offline, faster than realtime). */
export function renderOneShot(spec: OneShotRender): Promise<AudioBuffer> {
  return renderToBuffer(spec.durationSeconds, (ctx) => {
    spec.build(ctx, ctx.destination, 0);
  });
}
