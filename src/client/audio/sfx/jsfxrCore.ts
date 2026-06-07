import { sfxr } from "jsfxr";

/**
 * jsfxr fixed-def schema (confirmed v1.4.1, 2026-06-07):
 * `sfxr.toWave(def)` constructs `new SoundEffect(def)` which reads the params
 * object directly (`ps.wave_type`, `ps.p_lpf_freq`, ...). A "fixed def" is therefore
 * a plain object with these fields (all numbers unless noted):
 *   wave_type        // 0 SQUARE, 1 SAWTOOTH, 2 SINE, 3 NOISE
 *   p_env_attack, p_env_sustain, p_env_punch, p_env_decay
 *   p_base_freq, p_freq_limit, p_freq_ramp, p_freq_dramp
 *   p_vib_strength, p_vib_speed
 *   p_arp_mod, p_arp_speed
 *   p_duty, p_duty_ramp
 *   p_repeat_speed
 *   p_pha_offset, p_pha_ramp
 *   p_lpf_freq (1 = filter off), p_lpf_ramp, p_lpf_resonance
 *   p_hpf_freq, p_hpf_ramp
 *   sound_vol, sample_rate (44100), sample_size (8)
 * Use a concrete object (NOT sfxr.generate, which randomizes) for stable durations.
 * Note: `wave.buffer` floats are "normalized" but can exceed [-1..1] (clipping),
 * so layered cores should pass through a gain < 1 before summing.
 */

/**
 * Build an AudioBuffer from a fixed jsfxr sound definition.
 * Uses sfxr.toWave(def).buffer (normalized floats at 44100 Hz) so the core can be
 * layered/filtered in an OfflineAudioContext graph. `def` MUST be a concrete params
 * object (not sfxr.generate, which randomizes) for stable output.
 */
export function jsfxrCoreToBuffer(ctx: BaseAudioContext, def: object): AudioBuffer {
  const wave = sfxr.toWave(def);
  const floats = wave.buffer;
  const length = Math.max(1, floats.length);
  const buffer = ctx.createBuffer(1, length, 44100);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i += 1) {
    data[i] = floats[i] ?? 0;
  }
  return buffer;
}
