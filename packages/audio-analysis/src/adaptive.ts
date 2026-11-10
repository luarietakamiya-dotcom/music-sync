import { validateAudio, type AudioData } from '@music-sync/shared';

/** Broad, overlapping-filter energy descriptors, not source/stem identification. */
export interface AdaptiveFeatures {
  bandEnergy: { bass: number; lowMid: number; presence: number; highMid: number; air: number };
  dynamicRangeDb: number;
  sustainRatio: number;
  channelBalanceDb: number;
  negativeCorrelationFraction: number;
}
export function analyzeAdaptiveFeatures(audio: AudioData): AdaptiveFeatures {
  validateAudio(audio);
  const sr = audio.sampleRate, frames = audio.channels[0].length;
  const coeff = [180, 700, 2500, Math.min(6000, sr * 0.4)].map(f => 1 - Math.exp(-2 * Math.PI * f / sr));
  const bands = [0, 0, 0, 0, 0], energies = [0, 0];
  const states = audio.channels.map(() => [0, 0, 0, 0]);
  const block = Math.max(1, Math.round(sr * 0.05)), blocks: number[] = [];
  let blockEnergy = 0, cross = 0, l2 = 0, r2 = 0, negative = 0, stereoBlocks = 0;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < audio.channels.length; c++) {
      const x = audio.channels[c][i], state = states[c];
      for (let k = 0; k < 4; k++) state[k] += coeff[k] * (x - state[k]);
      bands[0] += state[0] * state[0];
      for (let k = 1; k < 4; k++) { const part = state[k] - state[k - 1]; bands[k] += part * part; }
      bands[4] += (x - state[3]) ** 2;
      energies[c] += x * x; blockEnergy += x * x;
    }
    if (audio.channels.length === 2) {
      const l = audio.channels[0][i], r = audio.channels[1][i]; cross += l * r; l2 += l * l; r2 += r * r;
    }
    if ((i + 1) % block === 0 || i === frames - 1) {
      blocks.push(blockEnergy / (((i % block) + 1) * audio.channels.length)); blockEnergy = 0;
      if (l2 * r2 > 1e-16) { stereoBlocks++; if (cross / Math.sqrt(l2 * r2) < -0.1) negative++; }
      cross = 0; l2 = 0; r2 = 0;
    }
  }
  const total = bands.reduce((a, b) => a + b, 0);
  const ratios = bands.map(x => total > 1e-20 ? x / total : 0);
  const maximum = blocks.reduce((a, b) => Math.max(a, b), 0);
  const active = blocks.filter(x => x > Math.max(1e-12, maximum * 0.001)).sort((a, b) => a - b);
  const percentile = (p: number) => active[Math.floor((active.length - 1) * p)];
  return { bandEnergy: { bass: ratios[0], lowMid: ratios[1], presence: ratios[2], highMid: ratios[3], air: ratios[4] },
    dynamicRangeDb: active.length > 1 ? 10 * Math.log10(percentile(0.9) / percentile(0.1)) : 0,
    sustainRatio: maximum > 1e-12 ? blocks.filter(x => x > maximum * 0.35).length / blocks.length : 0,
    channelBalanceDb: audio.channels.length === 2 ? 10 * Math.log10((energies[0] + 1e-20) / (energies[1] + 1e-20)) : 0,
    negativeCorrelationFraction: stereoBlocks ? negative / stereoBlocks : 0 };
}
