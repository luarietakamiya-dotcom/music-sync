import type { AudioData } from '@music-sync/shared';
import { createBiquad, peakingCoefficients } from './index.js';

function wetCurve(curve: Float32Array, depthDb: number): Float32Array {
  if (!(curve instanceof Float32Array) || curve.some(db => !Number.isFinite(db) || db < depthDb || db > 0))
    throw new Error('STEMの帯域調整量が対応範囲外です。');
  const depth = 1 - 10 ** (depthDb / 20);
  return Float32Array.from(curve, db => (1 - 10 ** (db / 20)) / depth);
}

/** Band attenuation for an owned track. Curves describe consecutive time windows.
 * Dry windows stay dry; ramps occupy at most 15 ms inside an active window.
 * A boundary uses the smaller neighbouring attenuation, retaining short attacks.
 */
export function createStemDuck(sampleRate: number, channels: number, windowFrames: number,
  presenceDb: Float32Array, lowDb?: Float32Array) {
  if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000 ||
    ![1, 2].includes(channels) || !Number.isSafeInteger(windowFrames) || windowFrames < 1)
    throw new Error('STEMの帯域調整形式が不正です。');
  // Own the curves so subsequent planning/UI edits cannot change a running pass.
  const presence = wetCurve(presenceDb, -2);
  const low = wetCurve(lowDb ?? new Float32Array(0), -1.5);
  const hasPresence = presence.some(value => value > 0), hasLow = low.some(value => value > 0);
  const presenceCoefficients = peakingCoefficients(sampleRate, Math.min(2600, sampleRate * 0.4), -2, 0.7);
  const lowCoefficients = peakingCoefficients(sampleRate, 110, -1.5, 0.8);
  const presenceFilters = hasPresence ? Array.from({ length: channels }, () => createBiquad(presenceCoefficients)) : [];
  const lowFilters = hasLow ? Array.from({ length: channels }, () => createBiquad(lowCoefficients)) : [];
  const ramp = Math.min(windowFrames / 2, sampleRate * 0.015);
  let offset = 0;

  function weight(curve: Float32Array, index: number, position: number): number {
    const value = curve[index] ?? 0;
    if (!value) return 0;
    const distance = Math.min(position, windowFrames - position);
    if (distance >= ramp) return value;
    const neighbour = curve[position < windowFrames / 2 ? index - 1 : index + 1] ?? 0;
    const boundary = Math.min(value, neighbour);
    const t = distance / ramp;
    const smooth = t * t * (3 - 2 * t);
    return boundary + (value - boundary) * smooth;
  }

  return {
    applied: hasPresence || hasLow,
    processOwned(audio: AudioData): void {
      const frames = audio.channels[0]?.length ?? 0;
      if (audio.sampleRate !== sampleRate || audio.channels.length !== channels || !frames ||
        audio.channels.some(channel => !(channel instanceof Float32Array) || channel.length !== frames))
        throw new Error('STEMの帯域調整中に音声形式が変わりました。');
      for (const channel of audio.channels) for (const value of channel)
        if (!Number.isFinite(value) || Math.abs(value) > 32) throw new Error('STEMに不正なサンプル値があります。');
      if (!hasPresence && !hasLow) { offset += frames; return; }
      for (let i = 0; i < frames; i++, offset++) {
        const index = Math.floor(offset / windowFrames), position = offset % windowFrames + 0.5;
        const presenceWet = hasPresence ? weight(presence, index, position) : 0;
        const lowWet = hasLow ? weight(low, index, position) : 0;
        for (let c = 0; c < channels; c++) {
          let value = audio.channels[c][i];
          if (hasPresence) {
            const filtered = presenceFilters[c](value);
            if (presenceWet) value += presenceWet * (filtered - value);
          }
          if (hasLow) {
            const filtered = lowFilters[c](value);
            if (lowWet) value += lowWet * (filtered - value);
          }
          if (presenceWet || lowWet) audio.channels[c][i] = value;
        }
      }
    },
  };
}
