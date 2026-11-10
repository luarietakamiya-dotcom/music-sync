import assert from 'node:assert/strict';
import { applySoundColor, createComparisonPlan } from '@music-sync/core';

const input = { sampleRate: 16000, channels: [Float32Array.from({ length: 16000 }, (_, i) => 0.1 * Math.sin(2 * Math.PI * 1000 * i / 16000))] };
const original = input.channels[0].slice();
const result = applySoundColor(input, { preset: 'cassette', intensity: 'standard' });
assert.equal(result.status, 'accepted');
assert.deepEqual(input.channels[0], original);
const after = result.attempts.at(-1).after;
assert.equal(after.clippedSamples, 0);
assert.ok(createComparisonPlan(result.before, after).match.available);
console.log({ colour: result.selection.preset, status: result.status, truePeak: after.truePeakDbtp, explanation: result.explanations });
