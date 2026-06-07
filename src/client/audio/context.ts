export function createAudioContext(): AudioContext {
  return new AudioContext();
}

/** Resume a suspended context. Must be called from within a user gesture. */
export async function unlock(ctx: AudioContext): Promise<void> {
  if (ctx.state === "suspended") {
    await ctx.resume();
  }
}
