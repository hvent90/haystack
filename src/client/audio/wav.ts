/** Encode mono Float32 PCM into a 16-bit PCM WAV byte array. */
export function encodeWav(
  pcm: ReadonlyArray<number> | Float32Array,
  sampleRate: number,
): Uint8Array {
  const frames = pcm.length;
  const bytes = new Uint8Array(44 + frames * 2);
  const view = new DataView(bytes.buffer);
  const writeString = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) {
      view.setUint8(offset + i, text.charCodeAt(i));
    }
  };
  writeString(0, "RIFF");
  view.setUint32(4, 36 + frames * 2, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, frames * 2, true);
  let offset = 44;
  for (let i = 0; i < frames; i += 1) {
    const sample = pcm[i] ?? 0;
    const clamped = sample < -1 ? -1 : sample > 1 ? 1 : sample;
    view.setInt16(offset, Math.round(clamped * 32767), true);
    offset += 2;
  }
  return bytes;
}
