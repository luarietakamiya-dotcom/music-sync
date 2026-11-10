import { validateAudio, type AudioData } from '@music-sync/shared';
import { createBiquad } from './index.js';
import { peakingCoefficients } from './processing.js';
import { applyLiveToOwned, type LiveParameters } from './live.js';
import { applyDynamicEqToOwned, applyMultibandToOwned, type DynamicEqBand, type MultibandParameters } from './band-dynamics.js';

export type MixStage = { kind: 'dc'; } | { kind: 'eq'; frequencyHz: number; gainDb: number; q: number }
  | { kind: 'dynamic-eq'; bands: DynamicEqBand[] }
  | { kind: 'multiband'; parameters: MultibandParameters }
  | { kind: 'bass-center'; amount: number; crossoverHz: number }
  | { kind: 'width'; amount: number; crossoverHz: number }
  | { kind: 'balance'; leftDb: number; rightDb: number }
  | { kind: 'dynamics'; compressionDb: number; punchDb: number; referenceRms: number }
  | { kind: 'live'; parameters: LiveParameters };
const finiteRange = (value: number, min: number, max: number) => {
  if (!Number.isFinite(value) || value < min || value > max) throw new Error('Invalid mix-stage parameter');
};
/** Generic mix-stage executor, independent of presets/modes. Each call clones Original. */
export function renderMix(input: AudioData, stages: readonly MixStage[], prepareOwned?: (audio: AudioData) => void): AudioData {
  validateAudio(input);
  if (!Array.isArray(stages) || stages.length > 12) throw new Error('Too many mix stages');
  const audio = { sampleRate: input.sampleRate, channels: input.channels.map(c => c.slice()) };
  prepareOwned?.(audio);
  const sr = audio.sampleRate, channels = audio.channels, frames = channels[0].length;
  for (const stage of stages) {
    switch (stage.kind) {
      case 'dynamic-eq': applyDynamicEqToOwned(audio, stage.bands); break;
      case 'multiband': applyMultibandToOwned(audio, stage.parameters); break;
      case 'bass-center': {
        finiteRange(stage.amount, 0.7, 1); finiteRange(stage.crossoverHz, 80, 180);
        if (channels.length !== 2) break;
        let lowSide = 0; const coefficient = 1 - Math.exp(-2 * Math.PI * stage.crossoverHz / sr);
        for (let i = 0; i < frames; i++) {
          const mid = (channels[0][i] + channels[1][i]) / 2, side = (channels[0][i] - channels[1][i]) / 2;
          lowSide += coefficient * (side - lowSide);
          const adjusted = side + lowSide * (stage.amount - 1);
          channels[0][i] = mid + adjusted; channels[1][i] = mid - adjusted;
        }
        break;
      }
      case 'dc':
        for (const channel of channels) { const mean = channel.reduce((sum, x) => sum + x, 0) / frames; for (let i = 0; i < frames; i++) channel[i] -= mean; }
        break;
      case 'eq': {
        finiteRange(stage.gainDb, -3, 2);
        const coefficients = peakingCoefficients(sr, stage.frequencyHz, stage.gainDb, stage.q);
        for (const channel of channels) { const filter = createBiquad(coefficients); for (let i = 0; i < frames; i++) channel[i] = filter(channel[i]); }
        break;
      }
      case 'width': {
        finiteRange(stage.amount, 0.7, 1.08); finiteRange(stage.crossoverHz, 120, 400);
        if (channels.length !== 2) break;
        let lowSide = 0; const coefficient = 1 - Math.exp(-2 * Math.PI * stage.crossoverHz / sr);
        for (let i = 0; i < frames; i++) {
          const mid = (channels[0][i] + channels[1][i]) * 0.5, side = (channels[0][i] - channels[1][i]) * 0.5;
          lowSide += coefficient * (side - lowSide);
          const adjusted = lowSide + (side - lowSide) * stage.amount;
          channels[0][i] = mid + adjusted; channels[1][i] = mid - adjusted;
        }
        break;
      }
      case 'balance':
        finiteRange(stage.leftDb, -1.5, 0); finiteRange(stage.rightDb, -1.5, 0);
        channels.forEach((channel, c) => { const gain = 10 ** ((c === 0 ? stage.leftDb : stage.rightDb) / 20); for (let i = 0; i < frames; i++) channel[i] *= gain; });
        break;
      case 'dynamics': {
        finiteRange(stage.compressionDb, 0, 2); finiteRange(stage.punchDb, 0, 1.2); finiteRange(stage.referenceRms, 1e-8, 32);
        let fast = 0, slow = 0, gainDb = 0;
        const fastC = 1 - Math.exp(-1 / (sr * 0.004)), slowC = 1 - Math.exp(-1 / (sr * 0.06));
        const attack = 1 - Math.exp(-1 / (sr * 0.015)), release = 1 - Math.exp(-1 / (sr * 0.1));
        for (let i = 0; i < frames; i++) {
          let level = 0; for (const channel of channels) level = Math.max(level, Math.abs(channel[i]));
          fast += fastC * (level - fast); slow += slowC * (level - slow);
          const over = Math.max(0, 20 * Math.log10(Math.max(slow, 1e-12) / stage.referenceRms) - 3);
          const target = -Math.min(stage.compressionDb, over * 0.35);
          gainDb += (target < gainDb ? attack : release) * (target - gainDb);
          const punch = stage.punchDb * Math.max(0, Math.min(1, (fast - slow) / Math.max(slow, stage.referenceRms * 0.5)));
          const gain = 10 ** ((gainDb + punch) / 20);
          for (const channel of channels) channel[i] *= gain;
        }
        break;
      }
      case 'live': applyLiveToOwned(audio, stage.parameters); break;
      default: throw new Error('Unknown mix-stage kind');
    }
  }
  validateAudio(audio); return audio;
}
