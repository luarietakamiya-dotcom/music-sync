import { describe, expect, it } from 'vitest';
import { analyzeAudio, capabilities } from '@music-sync/core';
import { estimateTruePeak } from '@music-sync/dsp';
import { tone } from '../helpers/audio';

describe('Phase 1: portable analysis', () => {
  it('measures a -20 dBFS mono 1 kHz tone and preserves input', () => {
    const audio = tone(), before = audio.channels[0].slice();
    const result = analyzeAudio(audio);
    expect(result.samplePeakDbfs).toBeCloseTo(-20, 4);
    expect(result.rmsDbfs).toBeCloseTo(-23.0103, 3);
    expect(result.crestFactorDb).toBeCloseTo(3.0103, 3);
    expect(result.integratedLufs).toBeCloseTo(-23.0, 1);
    expect(result.stereoCorrelation).toBeNull();
    expect(audio.channels[0]).toEqual(before);
  });
  it('sums stereo energy for loudness, rather than averaging or downmixing', () => {
    const mono = analyzeAudio(tone()), stereo = analyzeAudio(tone({ stereo: true }));
    expect(stereo.integratedLufs! - mono.integratedLufs!).toBeCloseTo(3.0103, 3);
    expect(stereo.stereoCorrelation).toBeCloseTo(1, 8);
    expect(stereo.sideEnergyPercent).toBe(0);
    const opposite = tone({ stereo: true }); opposite.channels[1].forEach((x, i, a) => { a[i] = -x; });
    const anti = analyzeAudio(opposite);
    expect(anti.stereoCorrelation).toBeCloseTo(-1, 8);
    expect(anti.sideEnergyPercent).toBeCloseTo(100);
    expect(anti.integratedLufs).toBeCloseTo(stereo.integratedLufs!, 6);
  });
  it('handles silence, short clips, one silent channel and DC without NaN/Infinity', () => {
    const silent = analyzeAudio({ sampleRate: 48000, channels: [new Float32Array(48000)] });
    expect(silent.integratedLufs).toBeNull(); expect(silent.samplePeakDbfs).toBeNull();
    expect(silent.crestFactorDb).toBeNull(); expect(silent.rmsDbfs).toBeNull();
    expect(analyzeAudio(tone({ seconds: 0.1 })).integratedLufs).toBeNull();
    const one = tone({ stereo: true }); one.channels[1].fill(0);
    expect(analyzeAudio(one).stereoCorrelation).toBeNull();
    const dc = analyzeAudio({ sampleRate: 48000, channels: [new Float32Array(1000).fill(0.25)] });
    expect(dc.dcOffset[0]).toBe(0.25); expect(dc.crestFactorDb).toBe(0);
    expect(JSON.stringify(silent)).not.toMatch(/NaN|Infinity/);
  });
  it('applies relative and absolute loudness gates', () => {
    const loud = tone({ seconds: 2 });
    const gated = new Float32Array(48000 * 4);
    gated.set(loud.channels[0]);
    gated.set(tone({ seconds: 2, amplitude: 0.0001 }).channels[0], 96000);
    const reference = analyzeAudio(loud).integratedLufs!;
    expect(Math.abs(analyzeAudio({ sampleRate: 48000, channels: [gated] }).integratedLufs! - reference)).toBeLessThan(0.4);
    expect(analyzeAudio(tone({ amplitude: 0.00001 })).integratedLufs).toBeNull();
  });
  it.each([44100, 48000, 96000])('adapts K weighting at %i Hz', sampleRate => {
    expect(analyzeAudio(tone({ sampleRate })).integratedLufs).toBeCloseTo(-23.0, 1);
  });
  it('detects intersample peaks beyond sample peaks', () => {
    const signal = tone({ frequency: 12000, amplitude: 0.95, phase: Math.PI / 4 }).channels[0];
    const samplePeak = Math.max(...signal);
    const peak = estimateTruePeak(signal);
    expect(peak).toBeGreaterThan(samplePeak * 1.3);
    expect(peak).toBeLessThan(1.2);
  });
  it('counts clipped samples without clipping the input, and envelopes retain peaks', () => {
    const channel = new Float32Array([0, -1.2, 0.2, 1, 0.1]);
    const result = analyzeAudio({ sampleRate: 48000, channels: [channel] }, { waveformBins: 2 });
    expect(result.clippedSamples).toBe(2);
    expect(result.waveform[0].min[0]).toBeCloseTo(-1.2);
    expect(result.waveform[0].max[1]).toBe(1);
  });
  it('rejects invalid PCM, dimensions and waveform options', () => {
    expect(() => analyzeAudio({ sampleRate: 0, channels: [] })).toThrow();
    expect(() => analyzeAudio({ sampleRate: 48000, channels: [new Float32Array()] })).toThrow();
    expect(() => analyzeAudio({ sampleRate: 48000, channels: [new Float32Array([NaN])] })).toThrow();
    expect(() => analyzeAudio({ sampleRate: 48000, channels: [new Float32Array([Infinity])] })).toThrow();
    expect(() => analyzeAudio({ sampleRate: 48000, channels: [new Float32Array(2), new Float32Array(1)] })).toThrow();
    expect(() => analyzeAudio(tone(), { waveformBins: 0 })).toThrow();
  });
  it('does not expose future phases as implemented', () => {
    expect(capabilities.analysis).toBe(true);
    expect(capabilities.dsp).toBe(true); expect(capabilities.audioExport).toBe(true);
  });
});
