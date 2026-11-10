import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { analyzeAudio } from '@music-sync/core';
import { tone } from '../helpers/audio';

const fixtures = JSON.parse(readFileSync(new URL('../fixtures/loudness-reference.json', import.meta.url), 'utf8')) as {
  cases: { sampleRate: number; frequency: number; amplitude: number; seconds: number; lufs: number }[];
};
it.each(fixtures.cases)('matches independent pyloudnorm DeMan reference: $sampleRate Hz / $frequency Hz tone', fixture => {
  expect(Math.abs(analyzeAudio(tone(fixture)).integratedLufs! - fixture.lufs)).toBeLessThan(0.01);
});
