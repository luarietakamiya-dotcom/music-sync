import type { AudioData } from '@music-sync/shared';
import { applyVenueToOwned, type LiveVenueId } from './live-venue.js';

export interface LiveParameters {
  venue: 'intimate-room' | 'small-hall' | LiveVenueId; wet: number; highpassHz: number; decaySeconds: number; preDelayMs: number;
}
/** Independent venue processor. Dry timing/length/channel count are preserved.
 * Owned candidate buffers only; public caller is renderMix, which clones input.
 */
export function applyLiveToOwned(audio: AudioData, params: LiveParameters): void {
  if (params.venue === 'live-house' || params.venue === 'concert-hall' || params.venue === 'arena') {
    applyVenueToOwned(audio, { ...params, venue: params.venue }); return;
  }
  const hall = params.venue === 'small-hall';
  if ((!hall && params.venue !== 'intimate-room') || !Number.isFinite(params.wet) || params.wet < 0 || params.wet > (hall ? 0.3 : 0.18) ||
    !Number.isFinite(params.highpassHz) || params.highpassHz < 120 || params.highpassHz > 600 ||
    !Number.isFinite(params.decaySeconds) || params.decaySeconds < 0.2 || params.decaySeconds > (hall ? 1.4 : 1) ||
    !Number.isFinite(params.preDelayMs) || params.preDelayMs < 10 || params.preDelayMs > 40) throw new Error('Invalid live parameters');
  if (params.wet === 0) return;
  const sr = audio.sampleRate, frames = audio.channels[0].length;
  const hp = 1 - Math.exp(-2 * Math.PI * params.highpassHz / sr), lp = 1 - Math.exp(-2 * Math.PI * Math.min(4500, sr * 0.4) / sr);
  for (let c = 0; c < audio.channels.length; c++) {
    const channel = audio.channels[c];
    const predelay = Math.round(sr * params.preDelayMs / 1000);
    const early = (hall ? [0.018, 0.036, 0.062, 0.089] : [0.013, 0.027, 0.041])
      .map((s, j) => Math.round(sr * (s + c * 0.0017 * (j + 1))));
    const earlyWeights = hall ? [0.42, 0.28, 0.18, 0.12] : [0.55, 0.3, 0.15];
    const history = new Float32Array(predelay + Math.max(...early) + 1);
    const lines = (hall ? [0.0431, 0.0539, 0.0677, 0.0793] : [0.0311, 0.0379, 0.0433, 0.0539]).map((s, j) => {
      const delay = Math.round(sr * (s + c * 0.0011 * (j + 1)));
      const feedback = 10 ** (-3 * delay / sr / params.decaySeconds);
      return { ring: new Float32Array(delay), index: 0, damping: 0, feedback,
        injection: hall ? Math.sqrt(1 - feedback * feedback) : 1 - feedback };
    });
    const diffusers = hall ? [0.0071, 0.0117].map((s, j) => ({
      ring: new Float32Array(Math.round(sr * (s + c * 0.0009 * (j + 1)))), index: 0,
    })) : [];
    let low = 0, secondLow = 0, high = 0, envelope = 0;
    const attack = Math.exp(-1 / (sr * 0.005)), release = Math.exp(-1 / (sr * 0.12));
    for (let i = 0; i < frames; i++) {
      const dry = channel[i]; low += hp * (dry - low);
      const firstHigh = dry - low;
      if (hall) secondLow += hp * (firstHigh - secondLow);
      high += lp * (firstHigh - secondLow - high);
      const pos = i % history.length; history[pos] = high;
      const delayed = history[(pos - predelay + history.length) % history.length];
      let reflections = 0;
      for (let j = 0; j < early.length; j++) reflections += history[(pos - predelay - early[j] + history.length) % history.length] * earlyWeights[j];
      let late = 0;
      for (const line of lines) {
        const value = line.ring[line.index]; line.damping += 0.35 * (value - line.damping);
        // Normalize injected tail energy instead of suppressing it as decay grows.
        // Preserve the previous room response for external callers.
        line.ring[line.index] = delayed * line.injection + line.damping * line.feedback;
        line.index = (line.index + 1) % line.ring.length; late += value * (hall ? 0.5 : 0.25);
      }
      // Short all-pass diffusion increases echo density, without filtering Dry.
      for (const diffuser of diffusers) {
        const value = diffuser.ring[diffuser.index] - 0.6 * late;
        diffuser.ring[diffuser.index] = late + 0.6 * value;
        diffuser.index = (diffuser.index + 1) % diffuser.ring.length; late = value;
      }
      const coefficient = Math.abs(dry) > envelope ? attack : release;
      envelope = coefficient * envelope + (1 - coefficient) * Math.abs(dry);
      // Prefer foreground clarity: less wet while a strong direct sound is active.
      const duck = 1 / (1 + envelope * 3);
      const endFade = Math.min(1, (frames - 1 - i) / Math.max(1, sr * 0.08));
      channel[i] = dry + params.wet * duck * endFade * (hall ? 0.45 * reflections + 0.55 * late : 0.65 * reflections + 0.35 * late);
    }
  }
}
