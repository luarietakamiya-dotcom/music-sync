import { validateAudio, type AudioData } from '@music-sync/shared';
import { createBiquad, estimateTruePeak, type BiquadCoefficients } from './index.js';

export interface ProcessingChain {
  version: 1;
  bypass: boolean;
  gainDb: number;
  eq: { enabled: boolean; frequencyHz: number; gainDb: number; q: number };
  limiter: { enabled: boolean; ceilingDb: number; releaseMs: number };
}
export interface ProcessingResult {
  audio: AudioData;
  chain: ProcessingChain;
  maxReductionDb: number;
  peakGuardDb: number;
}
export function defaultProcessingChain(): ProcessingChain {
  return { version: 1, bypass: false, gainDb: 0,
    eq: { enabled: false, frequencyHz: 1000, gainDb: 0, q: 0.707 },
    limiter: { enabled: true, ceilingDb: -1, releaseMs: 80 } };
}
function bounded(value: number, min: number, max: number): void {
  if (!Number.isFinite(value) || value < min || value > max) throw new Error('DSPパラメーターが対応範囲外です。');
}
export function validateProcessingChain(chain: ProcessingChain, sampleRate: number): void {
  if (!chain || chain.version !== 1 || typeof chain.bypass !== 'boolean' ||
    !chain.eq || typeof chain.eq.enabled !== 'boolean' || !chain.limiter || typeof chain.limiter.enabled !== 'boolean')
    throw new Error('DSPチェーンの形式が不正です。');
  bounded(sampleRate, 8000, 192000); bounded(chain.gainDb, -24, 12);
  bounded(chain.eq.frequencyHz, 20, Math.min(20000, sampleRate * 0.45));
  bounded(chain.eq.gainDb, -12, 12); bounded(chain.eq.q, 0.1, 10);
  bounded(chain.limiter.ceilingDb, -12, -0.1); bounded(chain.limiter.releaseMs, 10, 500);
}
/** RBJ peaking EQ, W3C Audio EQ Cookbook. Normalized a0, no shared filter state. */
export function peakingCoefficients(sampleRate: number, frequencyHz: number, gainDb: number, q: number): BiquadCoefficients {
  const validation = defaultProcessingChain(); validation.eq = { enabled: true, frequencyHz, gainDb, q };
  validateProcessingChain(validation, sampleRate);
  const a = 10 ** (gainDb / 40), w = 2 * Math.PI * frequencyHz / sampleRate;
  const alpha = Math.sin(w) / (2 * q), c = Math.cos(w), d = 1 + alpha / a;
  return [(1 + alpha * a) / d, -2 * c / d, (1 - alpha * a) / d, -2 * c / d, (1 - alpha / a) / d];
}

/** Offline, synchronous and host-independent. Caller should use a Worker for long input. */
export function processAudio(input: AudioData, settings: ProcessingChain, onProgress?: (fraction: number) => void): ProcessingResult {
  validateAudio(input); validateProcessingChain(settings, input.sampleRate);
  const chain: ProcessingChain = { ...settings, eq: { ...settings.eq }, limiter: { ...settings.limiter } };
  const channels = input.channels.map(c => c.slice()), frames = channels[0].length;
  const audio = { sampleRate: input.sampleRate, channels };
  let maxReductionDb = 0, peakGuardDb = 0;
  if (chain.bypass) { onProgress?.(1); return { audio, chain, maxReductionDb, peakGuardDb }; }
  const gain = 10 ** (chain.gainDb / 20);
  channels.forEach((channel, index) => {
    const eq = chain.eq.enabled && chain.eq.gainDb !== 0
      ? createBiquad(peakingCoefficients(input.sampleRate, chain.eq.frequencyHz, chain.eq.gainDb, chain.eq.q)) : (x: number) => x;
    for (let i = 0; i < frames; i++) channel[i] = eq(channel[i] * gain);
    onProgress?.(0.25 * (index + 1) / channels.length);
  });
  if (chain.limiter.enabled) {
    // Linked 5 ms future-peak detector, monotonic ring deque: O(n), bounded scratch.
    // No output delay or appended tail; release is exponential, attack immediate.
    const ahead = Math.ceil(input.sampleRate * 0.005), size = ahead + 2;
    const indices = new Int32Array(size), peaks = new Float64Array(size);
    let head = 0, count = 0, next = 0, envelope = 1, minimum = 1;
    const ceiling = 10 ** (chain.limiter.ceilingDb / 20);
    const release = Math.exp(-1 / (input.sampleRate * chain.limiter.releaseMs / 1000));
    for (let i = 0; i < frames; i++) {
      while (count && indices[head] < i) { head = (head + 1) % size; count--; }
      while (next <= Math.min(frames - 1, i + ahead)) {
        let peak = 0;
        for (const channel of channels) peak = Math.max(peak, Math.abs(channel[next]));
        while (count && peaks[(head + count - 1) % size] <= peak) count--;
        const tail = (head + count) % size;
        indices[tail] = next++; peaks[tail] = peak; count++;
      }
      const target = peaks[head] > ceiling ? ceiling / peaks[head] : 1;
      envelope = Math.min(target, 1 - (1 - envelope) * release);
      minimum = Math.min(minimum, envelope);
      for (const channel of channels) channel[i] *= envelope;
      if (i % 65536 === 0) onProgress?.(0.25 + 0.4 * i / frames);
    }
    maxReductionDb = -20 * Math.log10(minimum);
    let estimated = 0;
    for (const channel of channels) estimated = Math.max(estimated, estimateTruePeak(channel));
    if (estimated > ceiling) {
      // Global attenuation after limiting protects the same estimated TP metric,
      // with a small rounding margin. This is not a certified true-peak limiter.
      const guard = ceiling / estimated * (1 - 1e-6);
      peakGuardDb = 20 * Math.log10(guard);
      for (const channel of channels) for (let i = 0; i < frames; i++) channel[i] *= guard;
    }
  }
  validateAudio(audio); onProgress?.(1);
  return { audio, chain, maxReductionDb, peakGuardDb };
}
