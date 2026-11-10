import { amplitudeToDb, validateAudio, type AudioData, type AnalysisResult, type WaveformChannel } from '@music-sync/shared';
import { createKWeighting, estimateTruePeak } from '@music-sync/dsp';
export { createStemClarityAnalyzer } from './stem-features.js';
export type { StemClarityFeatures } from './stem-features.js';
export { analyzeAdaptiveFeatures } from './adaptive.js';
export type { AdaptiveFeatures } from './adaptive.js';
export { StreamingAudioAnalyzer } from './streaming.js';

export { TrebleAnalyzer, type TrebleFrame } from './treble.js';

export type AnalysisProgress = (fraction: number) => void;

function integratedLoudness(audio: AudioData): number | null {
  const frames = audio.channels[0].length;
  const block = Math.round(audio.sampleRate * 0.4);
  const hop = Math.round(audio.sampleRate * 0.1);
  if (frames < block) return null;
  const blocks = new Float64Array(1 + Math.floor((frames - block) / hop));
  for (const channel of audio.channels) {
    const filter = createKWeighting(audio.sampleRate);
    const ring = new Float64Array(block);
    let energy = 0, output = 0;
    for (let i = 0; i < frames; i++) {
      const weighted = filter(channel[i]), square = weighted * weighted;
      const position = i % block;
      energy += square - ring[position];
      ring[position] = square;
      if (i + 1 >= block && (i + 1 - block) % hop === 0) blocks[output++] += Math.max(0, energy) / block;
    }
  }
  const absolutePower = 10 ** ((-70 + 0.691) / 10);
  const aboveAbsolute = Array.from(blocks).filter(x => x >= absolutePower);
  if (!aboveAbsolute.length) return null;
  const mean = aboveAbsolute.reduce((a, b) => a + b, 0) / aboveAbsolute.length;
  const gated = aboveAbsolute.filter(x => x >= mean / 10);
  return -0.691 + 10 * Math.log10(gated.reduce((a, b) => a + b, 0) / gated.length);
}

function waveform(channel: Float32Array, bins: number): WaveformChannel {
  const count = Math.min(channel.length, bins);
  const result: WaveformChannel = { min: [], max: [] };
  for (let bin = 0; bin < count; bin++) {
    let min = Infinity, max = -Infinity;
    const start = Math.floor(bin * channel.length / count), end = Math.floor((bin + 1) * channel.length / count);
    for (let i = start; i < end; i++) { min = Math.min(min, channel[i]); max = Math.max(max, channel[i]); }
    result.min.push(min); result.max.push(max);
  }
  return result;
}

/** Deterministic, read-only analysis. Run in a Worker for interactive applications. */
export function analyzeAudio(audio: AudioData, options: { waveformBins?: number; onProgress?: AnalysisProgress } = {}): AnalysisResult {
  validateAudio(audio);
  const bins = options.waveformBins ?? 1000;
  if (!Number.isInteger(bins) || bins < 1 || bins > 4096) throw new Error('waveformBins must be an integer from 1 to 4096');
  const { channels, sampleRate } = audio, frames = channels[0].length;
  let peak = 0, totalEnergy = 0, clippedSamples = 0, truePeak = 0;
  const dcOffset: number[] = [];
  options.onProgress?.(0.05);
  for (const channel of channels) {
    let sum = 0;
    for (const x of channel) {
      peak = Math.max(peak, Math.abs(x)); totalEnergy += x * x; sum += x;
      if (Math.abs(x) >= 1) clippedSamples++;
    }
    dcOffset.push(sum / frames);
  }
  const integratedLufs = integratedLoudness(audio);
  options.onProgress?.(0.25);
  for (let c = 0; c < channels.length; c++) {
    truePeak = Math.max(truePeak, estimateTruePeak(channels[c]));
    options.onProgress?.(0.25 + 0.65 * (c + 1) / channels.length);
  }
  let stereoCorrelation: number | null = null, sideEnergyPercent: number | null = null;
  if (channels.length === 2) {
    let ll = 0, rr = 0, lr = 0, mid = 0, side = 0;
    for (let i = 0; i < frames; i++) {
      const l = channels[0][i], r = channels[1][i];
      ll += (l - dcOffset[0]) ** 2; rr += (r - dcOffset[1]) ** 2;
      lr += (l - dcOffset[0]) * (r - dcOffset[1]);
      mid += ((l + r) / 2) ** 2; side += ((l - r) / 2) ** 2;
    }
    if (ll > 0 && rr > 0) stereoCorrelation = Math.max(-1, Math.min(1, lr / Math.sqrt(ll * rr)));
    if (mid + side > 0) sideEnergyPercent = 100 * side / (mid + side);
  }
  const rms = Math.sqrt(totalEnergy / (frames * channels.length));
  const warnings: string[] = [];
  if (frames / sampleRate < 0.4) warnings.push('400 ms未満のためIntegrated LUFSは測定できません。');
  else if (integratedLufs === null) warnings.push('無音またはゲート閾値未満のためIntegrated LUFSは測定できません。');
  if (clippedSamples) warnings.push('0 dBFS以上のサンプルがあります。');
  if (stereoCorrelation !== null && stereoCorrelation < 0) warnings.push('逆相成分があります。モノラル再生で音が弱くなる可能性があります。');
  if (dcOffset.some(x => Math.abs(x) > 0.01)) warnings.push('DCオフセットが検出されました。');
  options.onProgress?.(1);
  return {
    schemaVersion: 1, algorithmVersion: '0.1.0', sampleRate, channels: channels.length, frames,
    durationSeconds: frames / sampleRate, samplePeakDbfs: amplitudeToDb(peak), rmsDbfs: amplitudeToDb(rms),
    integratedLufs, truePeakDbtp: amplitudeToDb(truePeak), truePeakMethod: '4x-windowed-sinc-estimate',
    crestFactorDb: rms > 0 ? amplitudeToDb(peak / rms) : null,
    stereoCorrelation, sideEnergyPercent, clippedSamples, dcOffset,
    waveform: channels.map(channel => waveform(channel, bins)), warnings,
  };
}
export { analyzePerceptualFeatures, PerceptualAnalyzer, PERCEPTUAL_BANDS } from './perceptual.js';
export type { PerceptualFeatures, PerceptualBand, Estimate, BandDistribution } from './perceptual.js';
