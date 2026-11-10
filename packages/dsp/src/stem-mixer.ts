import { validateAudio, LIMITS, type AudioData } from '@music-sync/shared';
import { createBiquad, estimateTruePeak } from './index.js';
import { peakingCoefficients } from './processing.js';

export interface StemPresenceDip { frequencyHz: number; gainDb: number; q: number }
export function validateStemPresenceDip(dip: StemPresenceDip, sampleRate: number): void {
  if (!dip || !Number.isFinite(dip.frequencyHz) || dip.frequencyHz < 1000 || dip.frequencyHz > Math.min(5000, sampleRate * 0.4) ||
    !Number.isFinite(dip.gainDb) || dip.gainDb < -2.5 || dip.gainDb > -0.2 ||
    !Number.isFinite(dip.q) || dip.q < 0.5 || dip.q > 1.4) throw new Error('素材別の帯域補正が対応範囲外です。');
}

/** Measure a proposed dip in bounded chunks without changing or retaining source PCM. */
export function streamStemPresenceDip(audio: AudioData, dip: StemPresenceDip,
  onChunk: (filtered: readonly Float32Array[], offset: number) => void, signal?: AbortSignal) {
  validateAudio(audio); validateStemPresenceDip(dip, audio.sampleRate);
  const filters = audio.channels.map(() => createBiquad(peakingCoefficients(audio.sampleRate, dip.frequencyHz, dip.gainDb, dip.q)));
  const size = 16384, scratch = audio.channels.map(() => new Float32Array(size));
  let peak = 0, clippedSamples = 0;
  for (let offset = 0; offset < audio.channels[0].length; offset += size) {
    if (signal?.aborted) throw new Error('Processing cancelled');
    const length = Math.min(size, audio.channels[0].length - offset);
    for (let c = 0; c < audio.channels.length; c++) for (let i = 0; i < length; i++) {
      const value = filters[c](audio.channels[c][offset + i]);
      if (!Number.isFinite(value)) throw new Error('素材別の帯域補正が不正な値を生成しました。');
      scratch[c][i] = value; peak = Math.max(peak, Math.abs(value));
      if (Math.abs(value) >= 1) clippedSamples++;
    }
    onChunk(scratch.map(channel => channel.subarray(0, length)), offset);
  }
  return { samplePeak: peak, clippedSamples };
}

export function createStemAccumulator(sampleRate: number, channelCount: number, gainDb: number, pan: number, presenceDip?: StemPresenceDip) {
  const gain = 10 ** (gainDb / 20), mono = channelCount === 1;
  const left = gain * (mono ? Math.cos((pan + 1) * Math.PI / 4) * Math.SQRT2 : Math.min(1, 1 - pan));
  const right = gain * (mono ? Math.sin((pan + 1) * Math.PI / 4) * Math.SQRT2 : Math.min(1, 1 + pan));
  const filters = presenceDip ? Array.from({ length: channelCount }, () => createBiquad(peakingCoefficients(sampleRate, presenceDip.frequencyHz, presenceDip.gainDb, presenceDip.q))) : undefined;
  return (audio: AudioData, bus: Float32Array[]) => {
    if (!filters) for (let i = 0; i < audio.channels[0].length; i++) {
      bus[0][i] += audio.channels[0][i] * left;
      bus[1][i] += audio.channels[mono ? 0 : 1][i] * right;
    }
    else {
      for (let i = 0; i < audio.channels[0].length; i++) {
        const l = filters[0](audio.channels[0][i]);
        const r = mono ? l : filters[1](audio.channels[1][i]);
        bus[0][i] += l * left;
        bus[1][i] += r * right;
      }
    }
  };
}

/** Streaming, aligned summation. Owns one stereo bus, never writes source PCM. */
export class AlignedStemMixer {
  private channels: Float32Array[];
  private closed = false;
  constructor(readonly sampleRate: number, readonly frames: number) {
    if (!Number.isInteger(sampleRate) || sampleRate < LIMITS.minSampleRate || sampleRate > LIMITS.maxSampleRate ||
      !Number.isInteger(frames) || frames < 1 || frames / sampleRate > LIMITS.maxSeconds || frames * 8 > LIMITS.maxDecodedBytes)
      throw new Error('Invalid stem bus dimensions');
    this.channels = [new Float32Array(frames), new Float32Array(frames)];
  }
  add(audio: AudioData, gainDb = 0, pan = 0, muted = false, presenceDip?: StemPresenceDip): void {
    if (this.closed) throw new Error('Stem bus already finalized');
    validateAudio(audio);
    if (audio.sampleRate !== this.sampleRate || audio.channels[0].length > this.frames ||
      !Number.isFinite(gainDb) || gainDb < -24 || gainDb > 6 || !Number.isFinite(pan) || Math.abs(pan) > 1 || typeof muted !== 'boolean')
      throw new Error('Invalid stem dimensions/gain/pan');
    if (presenceDip) validateStemPresenceDip(presenceDip, this.sampleRate);
    if (muted) return;
    createStemAccumulator(this.sampleRate, audio.channels.length, gainDb, pan, presenceDip)(audio, this.channels);
  }
  finish(ceilingDb = -3): { audio: AudioData; attenuationDb: number } {
    if (this.closed) throw new Error('Stem bus already finalized');
    if (!Number.isFinite(ceilingDb) || ceilingDb < -12 || ceilingDb > -1) throw new Error('Invalid stem headroom');
    let peak = 0;
    for (const c of this.channels) peak = Math.max(peak, estimateTruePeak(c));
    const ceiling = 10 ** (ceilingDb / 20), gain = peak > ceiling ? ceiling / peak * (1 - 1e-6) : 1;
    if (gain !== 1) for (const c of this.channels) for (let i = 0; i < c.length; i++) c[i] *= gain;
    const audio: AudioData = { sampleRate: this.sampleRate, channels: this.channels };
    validateAudio(audio); this.closed = true;
    return { audio, attenuationDb: 20 * Math.log10(gain) };
  }
}
