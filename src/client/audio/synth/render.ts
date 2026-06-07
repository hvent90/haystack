/**
 * Render a built graph to an AudioBuffer via OfflineAudioContext.
 * `build` wires sources into `ctx.destination`; rendering runs faster than realtime.
 * Browser-only (OfflineAudioContext is not available under Bun/Node).
 */
export function renderToBuffer(
  durationSeconds: number,
  build: (ctx: OfflineAudioContext) => void,
  sampleRate = 44100,
): Promise<AudioBuffer> {
  const frames = Math.max(1, Math.ceil(durationSeconds * sampleRate));
  const ctx = new OfflineAudioContext(1, frames, sampleRate);
  build(ctx);
  return ctx.startRendering();
}
