/** Minimal TypeScript declarations for jsfxr v1.4.1 (no official @types package). */
declare module "jsfxr" {
  /** Sound parameters returned by sfxr.generate() and used as input to rendering methods. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type SoundParams = Record<string, any>;

  /** RIFFWAVE object returned by sfxr.toWave(). */
  export interface RiffWave {
    /** "data:audio/wav;base64,..." WAV data URI. */
    dataURI: string;
    /** Normalized float samples in [-1..1] range. */
    buffer: number[];
    /** Number of clipped samples. */
    clipping: number;
  }

  export interface SfxrNamespace {
    /**
     * Generate sound parameters using a named preset algorithm.
     * Available presets: "pickupCoin", "laserShoot", "explosion", "powerUp",
     * "hitHurt", "jump", "blipSelect", "synth", "tone", "click", "random".
     */
    generate(
      preset: string,
      options?: { sound_vol?: number; sample_rate?: number; sample_size?: number },
    ): SoundParams;

    /**
     * Render to raw 16-bit PCM byte array.
     * Returns pairs of (low byte, high byte) as plain integers (0-255), NOT floats.
     */
    toBuffer(synthdef: SoundParams): number[];

    /**
     * Render to a RIFFWAVE object with a WAV data URI and normalized float buffer.
     */
    toWave(synthdef: SoundParams): RiffWave;

    /**
     * Render to an AudioBufferSourceNode (browser only).
     */
    toWebAudio(synthdef: SoundParams, audiocontext: BaseAudioContext): AudioBufferSourceNode;

    /**
     * Play the sound via the Web Audio API (browser only).
     */
    play(synthdef: SoundParams): void;
  }

  export const sfxr: SfxrNamespace;
  const jsfxr: { sfxr: SfxrNamespace };
  export default jsfxr;
}
