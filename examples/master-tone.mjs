import assert from 'node:assert/strict';
import { masterAudio, encodeFloatWav } from '@music-sync/core';

const input = { sampleRate: 48000, channels: [Float32Array.from({ length: 48000 }, (_, i) => 0.1 * Math.sin(2 * Math.PI * 1000 * i / 48000))] };
const result = masterAudio(input, { targetLufs: -14, ceilingDb: -1 });
assert.equal(result.status, 'accepted');
assert.ok(Math.abs(result.after.integratedLufs + 14) <= 0.5);
const wav = encodeFloatWav(result.processed.audio);
console.log({ status: result.status, lufs: result.after.integratedLufs, wavBytes: wav.byteLength });
