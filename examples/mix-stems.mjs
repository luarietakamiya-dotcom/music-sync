import { mixStemsWithCorrection, finishStemMix } from '../packages/core/dist/index.js';
const sampleRate = 16000, frames = sampleRate * 2;
const source = (id, role, amplitude) => {
  const audio = { sampleRate, channels: [Float32Array.from({ length: frames }, (_, i) => {
    const t = i / sampleRate;
    return amplitude * [320, 910, 1850, 3300, 6100].reduce((sum, hz) => sum + Math.sin(2 * Math.PI * hz * t), 0) / 5;
  })] };
  const descriptor = { id, name: `${id}.wav`, role, sampleRate, channels: 1, frames, gainDb: 0, pan: 0, muted: false };
  return { audio, descriptor };
};
const mixed = mixStemsWithCorrection([source('voice', 'vocal', 0.02), source('music', 'instrumental', 0.22)]);
const finished = finishStemMix(mixed, 'AUTO');
if (finished.status !== 'accepted') throw new Error(finished.reasons.join(' '));
console.log('STEM import:', mixed.report.plan.mode, 'tracks:', mixed.report.tracks.length,
  'balance:', mixed.report.autoBalance.status, 'masking:', mixed.report.masking.status,
  'vocal adjustment:', mixed.report.autoBalance.tracks[0].adjustmentDb,
  'bus peak:', mixed.analysis.truePeakDbtp, 'finished LUFS:', finished.finalAfter.integratedLufs);
