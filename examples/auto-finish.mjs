import assert from 'node:assert/strict';
import { autoMixMaster } from '@music-sync/core';

const input = { sampleRate: 16000, channels: [Float32Array.from({ length: 32000 }, (_, i) => 0.1 * Math.sin(2 * Math.PI * 1000 * i / 16000))] };
for (const mode of ['AUTO', 'IMPACT', 'LIVE']) {
  const result = autoMixMaster(input, mode);
  assert.equal(result.status, 'accepted');
  assert.ok(result.attempts.length <= 3);
  console.log({ mode, status: result.status, mixStages: result.attempts.at(-1).mix.stages.map(s => s.kind), lufs: result.attempts.at(-1).after.integratedLufs });
}
