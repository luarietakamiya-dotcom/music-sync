import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { analyzeAudio, createComparisonPlan, COMPARISON_POLICY, singleSourceGainDb } from '@music-sync/core';
import { decodeWav, readFlacMetadata } from '../../apps/web/src/decode';
import { envelopeAt } from '../../apps/web/src/comparison-player';
import { tone, wav } from '../helpers/audio';

describe('Phase 2 comparison plan', () => {
  it('matches a 6 dB level difference within 0.1 LU without changing PCM or reports', () => {
    const a = tone({ amplitude: 0.1 }), b = tone({ amplitude: 0.2 });
    const hash = (pcm: Float32Array) => createHash('sha256').update(new Uint8Array(pcm.buffer)).digest('hex');
    const before = [hash(a.channels[0]), hash(b.channels[0])];
    const reports = [analyzeAudio(a), analyzeAudio(b)] as const;
    const reportsBefore = JSON.stringify(reports);
    const plan = createComparisonPlan(...reports);
    expect(plan.match.available).toBe(true);
    expect(plan.match.gainsDb.a).toBe(0);
    expect(plan.match.gainsDb.b).toBeCloseTo(-6.0206, 3);
    const normalized = [a, b].map((audio, i) => analyzeAudio({ ...audio,
      channels: audio.channels.map(c => Float32Array.from(c, x => x * 10 ** (plan.match.gainsDb[i === 0 ? 'a' : 'b'] / 20))),
    }).integratedLufs!);
    expect(Math.abs(normalized[0] - normalized[1])).toBeLessThan(0.1);
    expect(before).toEqual([hash(a.channels[0]), hash(b.channels[0])]);
    expect(JSON.stringify(reports)).toBe(reportsBefore);
  });
  it('preserves relative loudness in RAW and applies only a common headroom gain', () => {
    const a = analyzeAudio(tone({ amplitude: 1.2 })), b = analyzeAudio(tone({ amplitude: 0.6 }));
    const plan = createComparisonPlan(a, b);
    expect(plan.rawGainsDb.a).toBe(plan.rawGainsDb.b);
    expect(plan.rawGainsDb.a).toBeLessThan(0);
    expect(a.truePeakDbtp! + plan.rawGainsDb.a).toBeLessThanOrEqual(-1 + 1e-10);
    expect((a.integratedLufs! + plan.rawGainsDb.a) - (b.integratedLufs! + plan.rawGainsDb.b)).toBeCloseTo(6.0206, 3);
  });
  it('keeps both matched signals below the estimated ceiling, including high crest material', () => {
    const audio = tone({ amplitude: 0.1 }); audio.channels[0][12000] = 1.5;
    const a = analyzeAudio(audio), b = analyzeAudio(tone({ amplitude: 0.2 }));
    const plan = createComparisonPlan(a, b);
    expect(plan.match.sharedAttenuationDb).toBeLessThan(0);
    expect(a.truePeakDbtp! + plan.match.gainsDb.a).toBeLessThanOrEqual(COMPARISON_POLICY.ceilingDb + 1e-9);
    expect(b.truePeakDbtp! + plan.match.gainsDb.b).toBeLessThanOrEqual(COMPARISON_POLICY.ceilingDb + 1e-9);
    expect(plan.match.gainsDb.a).toBeLessThanOrEqual(0); expect(plan.match.gainsDb.b).toBeLessThanOrEqual(0);
  });
  it('refuses undefined LUFS and extreme differences without replacing LUFS by RMS', () => {
    const a = analyzeAudio(tone());
    const silence = analyzeAudio(tone({ amplitude: 0 }));
    const short = analyzeAudio(tone({ seconds: 0.1 }));
    expect(createComparisonPlan(a, silence).match.available).toBe(false);
    expect(createComparisonPlan(a, short).match.available).toBe(false);
    expect(createComparisonPlan(a, analyzeAudio(tone({ amplitude: 0.001 }))).match.reason).toContain('24 LU');
  });
  it('accepts unequal lengths on the common interval, rejects rate/channel mismatches', () => {
    const a = analyzeAudio(tone({ seconds: 2 })), b = analyzeAudio(tone());
    expect(createComparisonPlan(a, b).durationSeconds).toBe(1);
    expect(createComparisonPlan(a, b).lengthMismatch).toBe(true);
    expect(() => createComparisonPlan(a, analyzeAudio(tone({ sampleRate: 44100 })))).toThrow(/サンプルレート/);
    expect(() => createComparisonPlan(a, analyzeAudio(tone({ stereo: true })))).toThrow(/チャンネル/);
  });
  it('rejects NaN, inconsistent duration, and unavailable peaks in external reports', () => {
    const report = analyzeAudio(tone());
    expect(() => createComparisonPlan(report, { ...report, integratedLufs: NaN })).toThrow();
    expect(() => createComparisonPlan(report, { ...report, durationSeconds: 100 })).toThrow();
    expect(() => createComparisonPlan(report, { ...report, truePeakDbtp: null })).toThrow();
    expect(singleSourceGainDb(analyzeAudio(tone({ amplitude: 0 })))).toBe(0);
  });
  it('enforces the remaining pair memory budget before WAV/FLAC allocation', () => {
    const data = wav(tone());
    expect(() => decodeWav(data, 1024)).toThrow(/合計/);
    const buffer = new ArrayBuffer(42), v = new DataView(buffer);
    [102,76,97,67,128,0,0,34].forEach((n, i) => v.setUint8(i, n));
    v.setBigUint64(18, (48000n << 44n) | (15n << 36n) | 48000n);
    expect(() => readFlacMetadata(buffer, 1024)).toThrow(/合計/);
  });
  it('holds the exact value of interrupted gain ramps', () => {
    const first = { from: 0, to: 1, start: 0, end: 0.02 };
    const atSwitch = envelopeAt(first, 0.007);
    const next = { from: atSwitch, to: 0, start: 0.007, end: 0.027 };
    expect(atSwitch).toBeCloseTo(0.35);
    expect(envelopeAt(next, 0.007)).toBe(atSwitch);
    expect(envelopeAt(next, 0.027)).toBe(0);
  });
});
