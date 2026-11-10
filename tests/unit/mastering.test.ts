import { describe, it, expect } from 'vitest';
import { analyzeAudio, masterAudio, planMastering, type MasteringOptions } from '@music-sync/core';
import { tone } from '../helpers/audio';

const options: MasteringOptions = { targetLufs: -14, ceilingDb: -1 };
describe('Phase 4 deterministic mastering', () => {
  it.each([0.1, 0.7])('normalizes quiet/loud material, retains source, stereo and timing (%s)', amplitude => {
    const audio = tone({ amplitude, stereo: true });
    const original = audio.channels.map(c => c.slice());
    const result = masterAudio(audio, options);
    expect(result.status).toBe('accepted'); expect(result.processed).toBeDefined();
    expect(Math.abs(result.after!.integratedLufs! + 14)).toBeLessThan(0.5);
    expect(result.after!.truePeakDbtp!).toBeLessThanOrEqual(-1.0 + 1e-5);
    expect(result.after!.stereoCorrelation).toBeCloseTo(result.before.stereoCorrelation!, 5);
    expect(result.after!.crestFactorDb).toBeCloseTo(result.before.crestFactorDb!, 4);
    expect(result.after!.frames).toBe(audio.channels[0].length);
    expect(audio.channels).toEqual(original);
  });
  it('no-op is a bit-exact copy when target and ceiling already pass', () => {
    const input = tone(), before = analyzeAudio(input);
    const result = masterAudio(input, { targetLufs: before.integratedLufs!, ceilingDb: -1 });
    expect(result.status).toBe('accepted'); expect(result.plan.chain.bypass).toBe(true);
    expect(result.processed!.audio).toEqual(input);
    expect(result.processed!.audio.channels[0]).not.toBe(input.channels[0]);
  });
  it('refuses silent/short/clipped/extremely quiet/DC input before rendering', () => {
    const dc = tone(); dc.channels[0].fill(0.1);
    for (const input of [tone({ amplitude: 0 }), tone({ seconds: 0.1 }), tone({ amplitude: 1.2 }), tone({ amplitude: 0.0001 }), dc]) {
      const snapshot = input.channels.map(c => c.slice());
      const result = masterAudio(input, options);
      expect(result.status).toBe('rejected'); expect(result.after).toBeNull();
      expect(result.processed).toBeUndefined(); expect(result.reasons.length).toBeGreaterThan(0);
      expect(input.channels).toEqual(snapshot);
    }
  });
  it('rejects a transient-heavy candidate and exposes no rejected PCM', () => {
    const input = tone({ amplitude: 0.1 }); input.channels[0][12000] = 0.95;
    expect(planMastering(analyzeAudio(input), options).available).toBe(true);
    const result = masterAudio(input, options);
    expect(result.status).toBe('rejected'); expect(result.after).not.toBeNull();
    expect(result.processed).toBeUndefined();
    expect(result.reasons.join(' ')).toContain('3 dB');
    expect(input.channels[0][12000]).toBeCloseTo(0.95, 6);
  });
  it('does not claim impossible target/ceiling combinations were reached', () => {
    const result = masterAudio(tone({ amplitude: 0.2, frequency: 100 }), { targetLufs: -9, ceilingDb: -6 });
    expect(result.status).toBe('rejected'); expect(result.processed).toBeUndefined();
    expect(result.reasons.join(' ')).toContain('±0.5 LU');
  });
  it('rechecks DC after gain even when the input DC gate passes', () => {
    const input = tone({ amplitude: 0.1 }); input.channels[0].forEach((x, i) => { input.channels[0][i] = x + 0.04; });
    const result = masterAudio(input, options);
    expect(result.plan.available).toBe(true); expect(result.status).toBe('rejected');
    expect(result.reasons.join(' ')).toContain('DC');
  });
  it('is deterministic and does not mutate options or trust outside analysis', () => {
    const input = tone({ seconds: 0.5 }); const original = JSON.stringify(options);
    const progress: number[] = [];
    const a = masterAudio(input, options, f => progress.push(f)), b = masterAudio(input, options);
    expect(a).toEqual(b); expect(JSON.stringify(options)).toBe(original);
    expect(progress.at(-1)).toBe(1); expect(progress.every((x, i) => x >= (progress[i - 1] ?? 0))).toBe(true);
  });
  it('rejects malformed targets and invalid PCM before processing', () => {
    for (const target of [NaN, Infinity, -25, -8]) expect(() => masterAudio(tone(), { ...options, targetLufs: target })).toThrow();
    for (const ceiling of [NaN, -7, 0]) expect(() => masterAudio(tone(), { ...options, ceilingDb: ceiling })).toThrow();
    expect(() => masterAudio({ sampleRate: 48000, channels: [Float32Array.of(NaN)] }, options)).toThrow();
  });
});
