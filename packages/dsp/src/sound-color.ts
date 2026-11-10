import { validateAudio, type AudioData } from '@music-sync/shared';
import { createBiquad } from './index.js';
import { peakingCoefficients } from './processing.js';

export interface ToneBand { frequencyHz: number; gainDb: number; q: number }
export interface SoundColorParameters {
  bands: ToneBand[]; highpassHz: number; lowpassHz: number;
  drive: number; noiseAmplitude: number; crackleAmplitude: number;
  wowDepthMs: number; wowRateHz: number; monoAmount: number; referenceRms: number;
}
const range = (x: number, min: number, max: number) => {
  if (!Number.isFinite(x) || x < min || x > max) throw new Error('Invalid sound-color parameter');
};
export function validateSoundColorParameters(p: SoundColorParameters, sampleRate: number): void {
  if (!p || !Array.isArray(p.bands) || p.bands.length > 8) throw new Error('Invalid sound-color bands');
  for (const band of p.bands) {
    range(band.frequencyHz, 20, sampleRate * 0.45); range(band.gainDb, -6, 6); range(band.q, 0.3, 2);
  }
  range(p.highpassHz, 0, sampleRate * 0.4); range(p.lowpassHz, 0, sampleRate * 0.45);
  range(p.drive, 0, 0.5); range(p.noiseAmplitude, 0, 0.01); range(p.crackleAmplitude, 0, 0.03);
  range(p.wowDepthMs, 0, 1); range(p.wowRateHz, 0.1, 3); range(p.monoAmount, 0, 1); range(p.referenceRms, 1e-8, 32);
}
/** Offline texture/EQ kernel. Owns its output; scratch is at most one channel. */
export function renderSoundColor(input: AudioData, p: SoundColorParameters, onProgress?: (fraction: number) => void): AudioData {
  validateAudio(input); validateSoundColorParameters(p, input.sampleRate);
  const channels = input.channels.map(channel => channel.slice()), frames = channels[0].length, sr = input.sampleRate;
  channels.forEach((channel, c) => {
    const filters = p.bands.map(band => createBiquad(peakingCoefficients(sr, band.frequencyHz, band.gainDb, band.q)));
    const hpC = p.highpassHz ? Math.exp(-2 * Math.PI * p.highpassHz / sr) : 0;
    const lpC = p.lowpassHz ? 1 - Math.exp(-2 * Math.PI * p.lowpassHz / sr) : 0;
    let previous = 0, high = 0, low1 = 0, low2 = 0;
    for (let i = 0; i < frames; i++) {
      let x = channel[i];
      for (const filter of filters) x = filter(x);
      if (hpC) { high = hpC * (high + x - previous); previous = x; x = high; }
      if (lpC) { low1 += lpC * (x - low1); low2 += lpC * (low1 - low2); x = low2; }
      channel[i] = x;
      if (i % 65536 === 0) onProgress?.((c + 0.5 * i / frames) / channels.length);
    }
    const source = p.wowDepthMs ? channel.slice() : channel;
    const depth = p.wowDepthMs * sr / 1000, edgeFrames = Math.min(Math.round(sr * 0.05), frames / 2);
    let seed = 0x1234abcd + c * 193, envelope = 0;
    const envelopeC = 1 - Math.exp(-1 / (sr * 0.025)), driveGain = 1 + p.drive * 3;
    for (let i = 0; i < frames; i++) {
      const edge = Math.min(1, i / Math.max(1, edgeFrames), (frames - 1 - i) / Math.max(1, edgeFrames));
      let x = source[i];
      if (depth) {
        // Offline fractional time warp; no fixed output delay, channel-linked modulation.
        const shift = depth * edge * (Math.sin(2 * Math.PI * p.wowRateHz * i / sr) + 0.18 * Math.sin(2 * Math.PI * 7.3 * i / sr));
        const position = Math.max(0, Math.min(frames - 1, i + shift)), index = Math.floor(position), fraction = position - index;
        x = source[index] * (1 - fraction) + source[Math.min(frames - 1, index + 1)] * fraction;
      }
      envelope += envelopeC * (Math.abs(x) - envelope);
      if (p.drive) x = (1 - p.drive) * x + p.drive * Math.tanh(x * driveGain) / driveGain;
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const random = seed / 4294967296;
      // Texture follows programme activity, so silence is not filled with hiss.
      const activity = Math.min(1, envelope / Math.max(1e-8, p.referenceRms * 0.2)) * edge;
      x += (random * 2 - 1) * p.noiseAmplitude * activity;
      if (random > 1 - 6 / sr) x += p.crackleAmplitude * (random > 1 - 3 / sr ? 1 : -1) * activity;
      channel[i] = x;
      if (i % 65536 === 0) onProgress?.((c + 0.5 + 0.5 * i / frames) / channels.length);
    }
  });
  if (channels.length === 2 && p.monoAmount) {
    for (let i = 0; i < frames; i++) {
      const mid = (channels[0][i] + channels[1][i]) / 2, side = (channels[0][i] - channels[1][i]) / 2 * (1 - p.monoAmount);
      channels[0][i] = mid + side; channels[1][i] = mid - side;
    }
  }
  // Avoid DC introduced by nonlinear texture. Empty/neutral parameters stay bit-exact.
  if (p.bands.length || p.highpassHz || p.lowpassHz || p.drive || p.noiseAmplitude || p.crackleAmplitude || p.wowDepthMs || p.monoAmount) {
    for (const channel of channels) {
      const mean = channel.reduce((sum, x) => sum + x, 0) / frames;
      for (let i = 0; i < frames; i++) channel[i] -= mean;
    }
  }
  const audio = { sampleRate: sr, channels }; validateAudio(audio); onProgress?.(1); return audio;
}
