import assert from 'node:assert/strict';
import { analyzeAudio, processAudio, defaultProcessingChain, encodeFloatWav } from '@music-sync/core';

const input = { sampleRate: 48000, channels: [Float32Array.from({ length: 48000 }, (_, i) => 0.8 * Math.sin(2 * Math.PI * 1000 * i / 48000))] };
const chain = defaultProcessingChain(); chain.gainDb = 6;
const processed = processAudio(input, chain);
const report = analyzeAudio(processed.audio), wav = encodeFloatWav(processed.audio);
assert.ok(report.truePeakDbtp <= -1 + 1e-5);
assert.equal(new DataView(wav).getUint32(44, true), 48000);
console.log({ outputTruePeak: report.truePeakDbtp, reductionDb: processed.maxReductionDb, floatWavBytes: wav.byteLength });
