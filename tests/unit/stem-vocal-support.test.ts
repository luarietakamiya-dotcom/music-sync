import { expect, it } from 'vitest';
import type { StemClarityFeatures } from '@music-sync/core';
import { planStemVocalSupport } from '../../packages/core/src/stem-vocal-support';

const sampleRate = 16000, windowFrames = 800, count = 100;
function fixture(): { lead: StemClarityFeatures; relative: Float32Array } {
  const bodyRms = new Float32Array(count).fill(0.1);
  bodyRms.fill(0, 0, 10); bodyRms.fill(0, 90);
  bodyRms.fill(0.05, 40, 46);
  const bodyEnergy = Float32Array.from(bodyRms, rms => rms * rms * 0.6);
  return { lead: { sampleRate, channels: 1, frames: count * windowFrames, windowFrames, bodyRms,
    presenceEnergy: Float32Array.from(bodyEnergy, value => value * 0.7),
    bodyEnergy, lowEnergy: new Float32Array(count), attack: new Uint8Array(count), clippedSamples: 0 },
  relative: new Float32Array(count).fill(-7) };
}

it('supports only a short masked weak island between healthy singing with a bounded, immutable plan', () => {
  const { lead, relative } = fixture();
  const before = JSON.stringify(lead), ratios = relative.slice();
  const result = planStemVocalSupport(lead, relative);
  expect(result.seconds).toBeCloseTo(0.3, 8);
  expect(result.maxGainDb).toBe(1.5);
  expect(result.gainDb.slice(40, 46).every(value => value === 1.5)).toBe(true);
  expect(result.gainDb.slice(0, 40).every(value => value === 0)).toBe(true);
  expect(result.gainDb.slice(46).every(value => value === 0)).toBe(true);
  expect(JSON.stringify(lead)).toBe(before);
  expect(relative).toEqual(ratios);
});

it('keeps old feature callers, unmasked phrases and healthy constant-level singing free of additional gain', () => {
  const old = fixture(); delete old.lead.bodyEnergy;
  expect(planStemVocalSupport(old.lead, old.relative).gainDb.every(value => value === 0)).toBe(true);
  const unmasked = fixture(); unmasked.relative.fill(-2);
  expect(planStemVocalSupport(unmasked.lead, unmasked.relative).seconds).toBe(0);
  const healthy = fixture(); healthy.lead.bodyRms.fill(0.1);
  healthy.lead.bodyEnergy!.fill(0.006); healthy.lead.presenceEnergy.fill(0.0042);
  expect(planStemVocalSupport(healthy.lead, healthy.relative).maxGainDb).toBe(0);
});

it('does not raise silence, breath-dominated islands, attacks or isolated one-window changes', () => {
  const silent = fixture(); silent.lead.bodyRms.fill(0); silent.lead.bodyEnergy!.fill(0); silent.lead.presenceEnergy.fill(0);
  expect(planStemVocalSupport(silent.lead, silent.relative).seconds).toBe(0);
  const breath = fixture();
  breath.lead.bodyEnergy!.fill(0.00001, 40, 46);
  breath.lead.presenceEnergy.fill(0.001, 40, 46);
  expect(planStemVocalSupport(breath.lead, breath.relative).seconds).toBe(0);
  const attacks = fixture(); attacks.lead.attack.fill(1, 40, 46);
  expect(planStemVocalSupport(attacks.lead, attacks.relative).seconds).toBe(0);
  const brief = fixture(); brief.lead.bodyRms.fill(0.1); brief.lead.bodyRms[42] = 0.05;
  brief.lead.bodyEnergy = Float32Array.from(brief.lead.bodyRms, rms => rms * rms * 0.6);
  brief.lead.presenceEnergy = Float32Array.from(brief.lead.bodyEnergy, value => value * 0.7);
  expect(planStemVocalSupport(brief.lead, brief.relative).seconds).toBe(0);
});

it('leaves long quiet passages and trailing words alone rather than levelling intentional dynamics', () => {
  for (const [start, end] of [[30, 70], [83, 90], [40, 61]]) {
    const { lead, relative } = fixture();
    lead.bodyRms.fill(0.1, 10, 90); lead.bodyRms.fill(0.05, start, end);
    lead.bodyEnergy = Float32Array.from(lead.bodyRms, rms => rms * rms * 0.6);
    lead.presenceEnergy = Float32Array.from(lead.bodyEnergy, value => value * 0.7);
    expect(planStemVocalSupport(lead, relative).seconds).toBe(0);
  }
});

it('rejects spectral changes, very weak tails and included clipping instead of lifting uncertain material', () => {
  const spectral = fixture(); spectral.lead.presenceEnergy.fill(0.003, 40, 46);
  expect(planStemVocalSupport(spectral.lead, spectral.relative).seconds).toBe(0);
  const tail = fixture(); tail.lead.bodyRms.fill(0.02, 40, 46);
  tail.lead.bodyEnergy = Float32Array.from(tail.lead.bodyRms, rms => rms * rms * 0.6);
  tail.lead.presenceEnergy = Float32Array.from(tail.lead.bodyEnergy, value => value * 0.7);
  expect(planStemVocalSupport(tail.lead, tail.relative).seconds).toBe(0);
  const clipped = fixture(); clipped.lead.clippedSamples = 1;
  expect(planStemVocalSupport(clipped.lead, clipped.relative).maxGainDb).toBe(0);
});

it('validates trajectory metadata and finite evidence and observes cancellation', () => {
  const { lead, relative } = fixture();
  expect(() => planStemVocalSupport(lead, relative.subarray(1))).toThrow();
  const invalid = fixture(); invalid.relative[5] = Infinity;
  expect(() => planStemVocalSupport(invalid.lead, invalid.relative)).toThrow();
  const body = fixture(); body.lead.bodyEnergy![5] = NaN;
  expect(() => planStemVocalSupport(body.lead, body.relative)).toThrow();
  const partial = fixture(); partial.lead.bodyEnergy = new Float32Array(2);
  expect(() => planStemVocalSupport(partial.lead, partial.relative)).toThrow();
  expect(() => planStemVocalSupport({ ...lead, windowFrames: 799 }, relative)).toThrow();
  const controller = new AbortController(); controller.abort();
  expect(() => planStemVocalSupport(lead, relative, { signal: controller.signal })).toThrow();
});
