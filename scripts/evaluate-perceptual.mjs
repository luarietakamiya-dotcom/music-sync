import { mkdirSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { autoMixMaster } from '../packages/core/dist/index.js';
import { fixtureNames, fixtureExpectations, perceptualFixture } from '../tests/fixtures/perceptual.ts';

// Deterministic generated signals, not a perceptual-quality certification corpus.
const fixtures = [];
for (const name of fixtureNames) {
  const input = perceptualFixture(name), start = performance.now();
  const mode = name === 'wet' ? 'LIVE' : name === 'transient-heavy' ? 'IMPACT' : 'AUTO';
  const result = autoMixMaster(input, mode);
  fixtures.push({ name, expected: fixtureExpectations[name], mode, seconds: (performance.now() - start) / 1000,
    status: result.status, reasons: result.reasons, before: result.perceptual,
    attempts: result.attempts.map(a => ({ iteration: a.iteration, plan: a.mix.perceptual, stages: a.mix.stages,
      objectives: a.objectiveQuality, safety: a.quality, after: a.perceptual })) });
  console.log(`${name}: ${result.status}, ${result.attempts.length} attempt(s)`);
}
mkdirSync('artifacts/evaluation', { recursive: true });
writeFileSync('artifacts/evaluation/phase7-fixtures.json', JSON.stringify({ algorithm: 'perceptual-v1', fixtures }, null, 2) + '\n');
