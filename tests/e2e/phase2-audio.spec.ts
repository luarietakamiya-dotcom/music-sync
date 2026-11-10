import { test, expect } from '@playwright/test';
import type {} from '../audio/main';

test.beforeEach(async ({ page }) => {
  await page.goto('http://127.0.0.1:4174/');
  await page.waitForFunction(() => typeof window.renderScenario === 'function');
});

test('offline output retains sample-aligned impulses through switches and seek', async ({ page }) => {
  const output = await page.evaluate(() => window.renderScenario({ kind: 'impulses', seek: 0.05,
    switches: [{ at: 0.15, slot: 'b' }, { at: 0.45, slot: 'a' }, { at: 0.65, slot: 'b' }] }));
  const impulses = output.pcm.flatMap((x, i) => Math.abs(x) > 0.01 ? [i] : []);
  expect(impulses).toEqual([3600, 13200, 22800, 32400, 42000]);
  output.positions.forEach(p => expect(p.after).toBe(p.before));
  expect(output.sourceUnchanged).toBe(true);
});

test('actual matched output stays within 0.1 dB across A/B; RAW retains 6 dB', async ({ page }) => {
  for (const matched of [false, true]) {
    const output = await page.evaluate(matched => window.renderScenario({ kind: 'tone', matched, switches: [{ at: 0.5, slot: 'b' }] }), matched);
    const rms = (start: number, end: number) => {
      const segment = output.pcm.slice(start * output.sampleRate, end * output.sampleRate);
      return Math.sqrt(segment.reduce((sum, x) => sum + x * x, 0) / segment.length);
    };
    const differenceDb = 20 * Math.log10(rms(0.65, 0.85) / rms(0.2, 0.4));
    expect(Math.abs(differenceDb - (matched ? 0 : 6.0206))).toBeLessThan(0.1);
    expect(Math.max(...output.pcm.map(Math.abs))).toBeLessThan(10 ** (-1 / 20));
  }
});

test('rapid switch/RAW-match changes render continuous ramps without overshoot', async ({ page }) => {
  const output = await page.evaluate(() => window.renderScenario({ kind: 'dc', switches: [
    { at: 0.3, slot: 'b' }, { at: 0.305, slot: 'a', toggleMatch: true },
    { at: 0.31, slot: 'b' }, { at: 0.315, slot: 'a', toggleMatch: true },
  ] }));
  const transitions = output.pcm.slice(0.28 * output.sampleRate, 0.36 * output.sampleRate);
  let delta = 0;
  transitions.forEach((x, i) => { if (i) delta = Math.max(delta, Math.abs(x - transitions[i - 1])); });
  expect(delta).toBeLessThan(0.002);
  expect(Math.max(...transitions)).toBeLessThanOrEqual(0.601);
  expect(Math.min(...transitions)).toBeGreaterThan(0);
});
