export function createBandpass(ctx: BaseAudioContext, frequency: number, q = 1): BiquadFilterNode {
  const filter = ctx.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.value = frequency;
  filter.Q.value = q;
  return filter;
}

export function createLowpass(ctx: BaseAudioContext, frequency: number, q = 0.7): BiquadFilterNode {
  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = frequency;
  filter.Q.value = q;
  return filter;
}

export function createHighpass(
  ctx: BaseAudioContext,
  frequency: number,
  q = 0.7,
): BiquadFilterNode {
  const filter = ctx.createBiquadFilter();
  filter.type = "highpass";
  filter.frequency.value = frequency;
  filter.Q.value = q;
  return filter;
}
