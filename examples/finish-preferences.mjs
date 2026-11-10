import { autoMixMaster, DEFAULT_FINISH_CONTROLS } from '../packages/core/dist/index.js';
const sampleRate = 48000;
const input = { sampleRate, channels: [Float32Array.from({ length: sampleRate }, (_, i) => 0.2 * Math.sin(2 * Math.PI * 1000 * i / sampleRate))] };
const result = autoMixMaster(input, 'AUTO', {
  preferences: { controls: { ...DEFAULT_FINISH_CONTROLS, vocal: 1, density: 1 }, output: 'youtube' },
});
if (result.status !== 'accepted') throw new Error(result.reasons.join(' '));
console.log('Final destination:', result.preferences.selection.output, 'requested LUFS:', result.preferences.requestedLufs,
  'actual LUFS:', result.finalAfter.integratedLufs, 'target reached:', result.preferences.targetReached);
