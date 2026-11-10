import type { AudioData } from '@music-sync/shared';
import { createBiquad, peakingCoefficients } from './index.js';

/** Stereo-linked wet weights. History and window phase persist across chunk boundaries. */
export function createTrebleFilter(rate: number, channelCount: number, size: number, cut: Float32Array, lift: Float32Array, depthDb: number, center = 9000, clarityDb = 1) {
  const filters = Array.from({ length: channelCount }, () => ({
    cut: createBiquad(peakingCoefficients(rate, center, -depthDb, 1.05)),
    lift: createBiquad(peakingCoefficients(rate, 4750, clarityDb, 1.1)),
  }));
  let offset = 0;
  function edge(weights: Float32Array, index: number, fraction: number) {
    // Adjacent windows meet at their smaller weight. Protected windows stay exactly dry.
    const value = weights[index] ?? 0;
    const neighbor = weights[fraction < 0.5 ? index - 1 : index + 1] ?? 0;
    return value - Math.max(0, value - neighbor) * Math.max(0, 1 - 4 * Math.min(fraction, 1 - fraction));
  }
  return (owned: AudioData) => {
    for (let i = 0; i < owned.channels[0].length; i++, offset++) {
      const index = Math.floor(offset / size), phase = (offset % size) / size;
      const wet = edge(cut, index, phase), clarity = edge(lift, index, phase);
      for (const [c, f] of filters.entries()) {
        const dry = owned.channels[c][i], cleaned = dry + wet * (f.cut(dry) - dry);
        owned.channels[c][i] = cleaned + clarity * (f.lift(cleaned) - cleaned);
      }
    }
  };
}
