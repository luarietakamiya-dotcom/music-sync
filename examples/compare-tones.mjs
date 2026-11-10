import assert from 'node:assert/strict';
import { analyzeAudio, createComparisonPlan } from '@music-sync/core';

const sampleRate = 48000;
const before = Float32Array.from({ length: sampleRate }, (_, i) => 0.1 * Math.sin(2 * Math.PI * 1000 * i / sampleRate));
const after = before.map(x => x * 2);
const plan = createComparisonPlan(
  analyzeAudio({ sampleRate, channels: [before] }),
  analyzeAudio({ sampleRate, channels: [after] }),
);
assert.equal(plan.match.available, true);
assert.ok(Math.abs(plan.match.gainsDb.b + 6.0206) < 0.01);
assert.equal(plan.match.gainsDb.a, 0);
console.log('Comparison monitoring plan:', plan);
