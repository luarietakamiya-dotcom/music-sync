import { describe, expect, it } from 'vitest';
import { DEFAULT_FINISH_CONTROLS, OUTPUT_PROFILES, planFinishControls, applyFinishingPreferences, autoMixMaster, analyzeAudio, analyzeAdaptiveFeatures, createComparisonPlan, validateFinishingPreferences, type FinishingPreferences, type FinishControls, type OutputProfileId } from '@music-sync/core';
import { tone } from '../helpers/audio';
import { perceptualFixture } from '../fixtures/perceptual';

const settings = (controls: Partial<FinishControls> = {}, output: OutputProfileId = 'auto'): FinishingPreferences => ({ controls: { ...DEFAULT_FINISH_CONTROLS, ...controls }, output });

describe('plain-language finishing controls and output loudness', () => {
  it('does not select unnecessary DSP and keeps old AUTO behavior with default options', () => {
    const input = perceptualFixture('balanced');
    expect(planFinishControls(analyzeAudio(input), analyzeAdaptiveFeatures(input), DEFAULT_FINISH_CONTROLS).stages).toEqual([]);
    expect(autoMixMaster(input, 'AUTO', { preferences: settings() })).toEqual(autoMixMaster(input, 'AUTO'));
    const neutral = applyFinishingPreferences(tone({ amplitude: 0.4 }), settings());
    expect(neutral.processed!.chain.bypass).toBe(true);
    expect(neutral.processed!.audio).toEqual(tone({ amplitude: 0.4 }));
  });
  it.each(['vocal', 'bass', 'clarity', 'warmth', 'punch', 'width', 'density'] as const)('turns %s into an explicit bounded plan and immutable safe output', key => {
    const input = perceptualFixture('balanced'), original = input.channels.map(c => c.slice());
    const selection = settings({ [key]: 3 });
    const planned = planFinishControls(analyzeAudio(input), analyzeAdaptiveFeatures(input), selection.controls);
    expect(planned.stages.length + planned.skipped.length).toBeGreaterThan(0);
    const result = applyFinishingPreferences(input, selection);
    expect(result.status, result.reasons.join(' ')).toBe('accepted');
    const after = result.attempts.at(-1)!.after;
    expect(after.clippedSamples).toBe(0); expect(after.truePeakDbtp!).toBeLessThanOrEqual(-1.0000 + 0.0001);
    expect(createComparisonPlan(analyzeAudio(input), after).match.available).toBe(true);
    expect(result.attempts.length).toBeLessThanOrEqual(3); expect(input.channels).toEqual(original);
    if (key !== 'density') expect(result.processed!.audio.channels).not.toEqual(original);
  });
  it.each(['youtube', 'streaming', 'cd', 'dynamic'] as const)('measures the final %s target and keeps density independent from destination LUFS', output => {
    const input = tone({ amplitude: 0.2, seconds: 1 });
    const result = applyFinishingPreferences(input, settings({ density: 2 }, output));
    expect(result.status, result.reasons.join(' ')).toBe('accepted');
    expect(result.requestedLufs).toBe(OUTPUT_PROFILES[output].targetLufs);
    expect(result.targetReached).toBe(true);
    expect(Math.abs(analyzeAudio(result.processed!.audio).integratedLufs! - result.requestedLufs)).toBeLessThan(0.5);
  });
  it('reports a safety-limited target honestly instead of forcing compression or claiming success', () => {
    const input = tone({ amplitude: 0.01 });
    const result = applyFinishingPreferences(input, settings({}, 'cd'));
    expect(result.status).toBe('accepted'); expect(result.targetReached).toBe(false);
    expect(result.actualLufs! - analyzeAudio(input).integratedLufs!).toBeLessThanOrEqual(6.0001);
    expect(result.explanations.join(' ')).toContain('目標音量より控えめ');
    expect(result.attempts.at(-1)!.after.clippedSamples).toBe(0);
  });
  it('limits bass enhancement on bass-heavy input, width on unstable stereo and compression on dense audio', () => {
    const plan = (name: Parameters<typeof perceptualFixture>[0], controls: Partial<FinishControls>) => {
      const audio = perceptualFixture(name); return planFinishControls(analyzeAudio(audio), analyzeAdaptiveFeatures(audio), settings(controls).controls);
    };
    const bass = (p: ReturnType<typeof plan>) => p.stages.find(s => s.kind === 'eq' && s.frequencyHz === 95);
    expect(bass(plan('bass-heavy', { bass: 3 }))).toMatchObject({ gainDb: 0.7 });
    expect(bass(plan('balanced', { bass: 3 }))).toMatchObject({ gainDb: 2 });
    expect(plan('excessive-stereo', { width: 3 }).stages).toEqual([]);
    expect(plan('overcompressed', { density: 3 }).compressionBudgetDb).toBe(0);
  });
  it('applies destination last after LIVE, colour and combined preferences and re-measures final export PCM', () => {
    const input = perceptualFixture('balanced'), original = input.channels.map(c => c.slice());
    const result = autoMixMaster(input, 'LIVE', { live: { venue: 'live-house', intensity: 'gentle' }, soundColor: { preset: 'warm', intensity: 'gentle' },
      preferences: settings({ vocal: 1, bass: 1, punch: 1, density: 1 }, 'youtube') });
    expect(result.status, result.reasons.join(' ')).toBe('accepted');
    expect(result.preferences!.selection.output).toBe('youtube');
    expect(result.finalAfter).toEqual(analyzeAudio(result.processed!.audio));
    expect(result.finalAfter!.clippedSamples).toBe(0); expect(input.channels).toEqual(original);
  });
  it('can switch destination and controls repeatedly from A, without accumulation', () => {
    const input = tone({ amplitude: 0.2 });
    const first = autoMixMaster(input, 'IMPACT', { preferences: settings({ vocal: 1 }, 'cd') });
    expect(first.status, first.reasons.join(' ')).toBe('accepted');
    const second = autoMixMaster(input, 'AUTO', { preferences: settings({}, 'youtube') });
    expect(second.status).toBe('accepted');
    expect(autoMixMaster(input, 'IMPACT', { preferences: settings({ vocal: 1 }, 'cd') })).toEqual(first);
    expect(second.preferences!.requestedLufs).toBe(-14);
  });
  it.each(['am-radio', 'old-record', 'cassette'] as const)('preserves the intended %s colour while applying the final destination', preset => {
    const result = autoMixMaster(perceptualFixture('balanced'), 'AUTO', { soundColor: { preset, intensity: 'standard' }, preferences: settings({}, 'youtube') });
    expect(result.status, result.reasons.join(' ')).toBe('accepted');
    expect(result.soundColor!.selection.preset).toBe(preset);
    expect(result.preferences!.requestedLufs).toBe(-14);
    expect(result.finalAfter).toEqual(analyzeAudio(result.processed!.audio));
  });
  it('supports pre-cancel and cancellation between render and evaluation without mutating A', () => {
    const input = perceptualFixture('balanced'), original = input.channels.map(c => c.slice());
    for (const point of [0, 0.23]) {
      const controller = new AbortController();
      expect(() => applyFinishingPreferences(input, settings({ bass: 3 }, 'cd'), { signal: controller.signal, onProgress: f => { if (f >= point) controller.abort(); } })).toThrow('cancelled');
    }
    expect(input.channels).toEqual(original);
  });
  it('rejects malformed/NaN controls, unknown profiles, clipped input and non-measurable audio', () => {
    for (const bad of [{ ...settings(), output: 'invented' }, settings({ vocal: NaN as never }), settings({ bass: 4 as never }), { output: 'auto', controls: {} }])
      expect(() => validateFinishingPreferences(bad as FinishingPreferences)).toThrow('不正');
    expect(Object.isFrozen(OUTPUT_PROFILES.youtube)).toBe(true);
    expect(applyFinishingPreferences(tone({ amplitude: 0 }), settings({}, 'cd')).processed).toBeUndefined();
    expect(applyFinishingPreferences(tone({ amplitude: 1.1 }), settings({ bass: 3 })).processed).toBeUndefined();
  });
});
