import { describe, it, expect } from 'vitest';
import { analyzeAudio, analyzeAdaptiveFeatures, autoMixMaster, planMixCorrection, evaluateAutoQuality, type AdaptiveFeatures, type AutoMode } from '@music-sync/core';
import { renderMix } from '@music-sync/dsp';
import { tone } from '../helpers/audio';

function music() {
  const sr = 16000, frames = sr * 2;
  const left = Float32Array.from({ length: frames }, (_, i) => {
    const t = i / sr, envelope = (0.2 + 0.8 * Math.sin(t * Math.PI * 2) ** 4) * Math.min(1, t * 20, (2 - t) * 20);
    return envelope * (0.1 * Math.sin(2 * Math.PI * 90 * t) + 0.12 * Math.sin(2 * Math.PI * 700 * t) + 0.07 * Math.sin(2 * Math.PI * 2400 * t));
  });
  return { sampleRate: sr, channels: [left, left.map((x, i) => x * 0.9 + 0.012 * Math.sin(2 * Math.PI * 1100 * i / sr))] };
}
const balanced: AdaptiveFeatures = { bandEnergy: { bass: 0.2, lowMid: 0.2, presence: 0.35, highMid: 0.15, air: 0.1 },
  dynamicRangeDb: 8, sustainRatio: 0.4, channelBalanceDb: 0, negativeCorrelationFraction: 0 };

describe('Phase 6 adaptive mix/master engine', () => {
  it('analysis changes the plan for bass-heavy versus harsh input', () => {
    const bass = tone({ sampleRate: 16000, frequency: 70 }), harsh = tone({ sampleRate: 16000, frequency: 6500 });
    const low = planMixCorrection(analyzeAudio(bass), analyzeAdaptiveFeatures(bass), 'AUTO');
    const high = planMixCorrection(analyzeAudio(harsh), analyzeAdaptiveFeatures(harsh), 'AUTO');
    expect(low.problems.bassExcess).toBe(true); expect(high.problems.harsh).toBe(true);
    expect(low.stages).not.toEqual(high.stages);
    expect(low.stages).toContainEqual(expect.objectContaining({ kind: 'eq', frequencyHz: 120, gainDb: -2.4 }));
  });
  it('selects no mix DSP for a healthy AUTO profile; dense IMPACT gets no compression/punch', () => {
    const report = analyzeAudio(music());
    const healthy = { ...report, dcOffset: [0, 0], sideEnergyPercent: 15, stereoCorrelation: 0.7, crestFactorDb: 9 };
    expect(planMixCorrection(healthy, balanced, 'AUTO').stages).toEqual([]);
    expect(planMixCorrection({ ...healthy, crestFactorDb: 4 }, balanced, 'IMPACT').stages.some(x => x.kind === 'dynamics')).toBe(false);
  });
  it('healthy AUTO at the natural target returns a bit-exact bypass candidate', () => {
    const input = tone({ sampleRate: 16000 });
    const gain = 10 ** ((-16 - analyzeAudio(input).integratedLufs!) / 20);
    for (let i = 0; i < input.channels[0].length; i++) input.channels[0][i] *= gain;
    const result = autoMixMaster(input, 'AUTO');
    expect(result.status).toBe('accepted'); expect(result.attempts[0].mix.stages).toEqual([]);
    expect(result.attempts[0].master.chain.bypass).toBe(true); expect(result.processed!.audio).toEqual(input);
  });
  it('enforces bounded input memory before doing long analysis', () => {
    expect(() => autoMixMaster({ sampleRate: 48000, channels: [new Float32Array(96 * 1024 * 1024 / 4 + 1)] })).toThrow('96 MiB');
  });
  it.each(['AUTO', 'IMPACT', 'LIVE'] as AutoMode[])('%s preserves Original and produces a measured, peak-safe candidate', mode => {
    const input = music(), snapshot = input.channels.map(c => c.slice());
    const stages: string[] = [];
    const result = autoMixMaster(input, mode, { onProgress: p => stages.push(p.stage) });
    expect(result.status, result.reasons.join(' ')).toBe('accepted');
    expect(result.processed!.audio.channels[0]).not.toBe(input.channels[0]);
    expect(input.channels).toEqual(snapshot);
    const final = result.attempts.at(-1)!;
    expect(final.after.truePeakDbtp!).toBeLessThanOrEqual(-1 + 0.0001); expect(final.after.clippedSamples).toBe(0);
    expect(final.after.frames).toBe(input.channels[0].length); expect(final.after.integratedLufs).not.toBeNull();
    expect(stages).toEqual(expect.arrayContaining(['Analyzing', 'Creating candidate', 'Evaluating', 'Finalizing']));
    if (mode === 'LIVE') expect(final.mix.stages.some(s => s.kind === 'live')).toBe(true);
    if (mode === 'IMPACT') expect(final.mix.stages.some(s => s.kind === 'dynamics')).toBe(true);
  });
  it('LIVE reduces space for sustained/wide material, protects bass and center', () => {
    const report = analyzeAudio(music());
    const dry = planMixCorrection({ ...report, sideEnergyPercent: 15 }, balanced, 'LIVE');
    const wet = planMixCorrection({ ...report, sideEnergyPercent: 40 }, { ...balanced, sustainRatio: 0.9, bandEnergy: { ...balanced.bandEnergy, bass: 0.7 } }, 'LIVE');
    const dryLive = dry.stages.find(s => s.kind === 'live')!, wetLive = wet.stages.find(s => s.kind === 'live')!;
    if (dryLive.kind !== 'live' || wetLive.kind !== 'live') throw new Error('Missing live');
    expect(wetLive.parameters.wet).toBeLessThan(dryLive.parameters.wet);
    expect(wetLive.parameters.highpassHz).toBeGreaterThan(dryLive.parameters.highpassHz);
    expect(wet.stages.some(s => s.kind === 'width' && s.amount > 1)).toBe(false);
  });
  it('LIVE has delayed early reflections, decaying tail, no dry shift and bounded mono/stereo behavior', () => {
    for (const sampleRate of [8000, 48000, 192000]) {
      const impulse = new Float32Array(sampleRate); impulse[0] = 0.5;
      const input = { sampleRate, channels: [impulse] };
      const output = renderMix(input, [{ kind: 'live', parameters: { venue: 'intimate-room', wet: 0.14, preDelayMs: 22, highpassHz: 200, decaySeconds: 0.65 } }]);
      expect(output.channels[0][0]).toBe(0.5); expect(impulse.slice(1).every(x => x === 0)).toBe(true);
      expect(output.channels[0].slice(1, Math.floor(sampleRate * 0.02)).every(x => x === 0)).toBe(true);
      expect(output.channels[0].slice(Math.floor(sampleRate * 0.03), Math.floor(sampleRate * 0.1)).some(x => Math.abs(x) > 1e-5)).toBe(true);
      expect(output.channels[0].every(Number.isFinite)).toBe(true);
      expect(Math.abs(output.channels[0].at(-1)!)).toBeLessThan(1e-8);
    }
  });
  it('quality gate rejects peak, crest, stereo, spectral, DC and dynamic regressions', () => {
    const before = analyzeAudio(music());
    const check = (after = before, features = balanced, reduction = 0) => evaluateAutoQuality(before, after, balanced, features, 'AUTO', reduction);
    expect(check().accepted).toBe(true);
    for (const after of [
      { ...before, truePeakDbtp: 0.1 }, { ...before, clippedSamples: 1 },
      { ...before, crestFactorDb: before.crestFactorDb! - 4 }, { ...before, dcOffset: [0.1, 0.1] },
      { ...before, stereoCorrelation: -0.9 }, { ...before, sideEnergyPercent: 99 }, { ...before, integratedLufs: NaN },
    ]) expect(check(after).accepted).toBe(false);
    expect(check(before, { ...balanced, bandEnergy: { ...balanced.bandEnergy, bass: 0.7 } }).accepted).toBe(false);
    expect(check(before, { ...balanced, dynamicRangeDb: 1 }).accepted).toBe(false);
    expect(check(before, balanced, 4).accepted).toBe(false);
  });
  it('retries from Original with weaker/simplified plans and obeys the iteration cap', () => {
    const input = tone({ amplitude: 0.1, sampleRate: 16000 }); input.channels[0][4000] = 0.95;
    const result = autoMixMaster(input, 'IMPACT', { maxIterations: 2 });
    expect(result.attempts.length).toBe(2);
    expect(result.attempts[0].quality.accepted).toBe(false);
    expect(result.attempts[1].mix.strength).toBe(0.5);
    expect(result.attempts[1].mix.stages.some(s => s.kind === 'dynamics')).toBe(false);
    if (result.status === 'rejected') expect(result.processed).toBeUndefined();
    expect(() => autoMixMaster(input, 'AUTO', { maxIterations: 4 })).toThrow();
  });
  it('supports cancellation at stage boundaries and rejects silence/clipped input without candidates', () => {
    const controller = new AbortController(); const input = music(), before = input.channels[0].slice();
    expect(() => autoMixMaster(input, 'LIVE', { signal: controller.signal, onProgress: p => { if (p.stage === 'Creating candidate') controller.abort(); } })).toThrow('cancelled');
    expect(input.channels[0]).toEqual(before);
    for (const audio of [tone({ amplitude: 0 }), tone({ amplitude: 1.1 }), tone({ seconds: 0.1 })]) {
      const result = autoMixMaster(audio); expect(result.status).toBe('rejected'); expect(result.attempts).toHaveLength(0); expect(result.processed).toBeUndefined();
    }
  });
  it('mode switching is deterministic and does not reuse filter/room state', () => {
    const input = music(), live = autoMixMaster(input, 'LIVE'); autoMixMaster(input, 'IMPACT');
    expect(autoMixMaster(input, 'LIVE')).toEqual(live);
  });
});
