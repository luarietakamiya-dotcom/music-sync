import { describe, expect, it } from 'vitest';
import { analyzeAudio, StreamingAudioAnalyzer } from '@music-sync/core';
import { TruePeakEstimator, estimateTruePeak } from '@music-sync/dsp';
import { tone } from '../helpers/audio';

describe('chunked basic analysis', () => {
  it('matches whole-buffer analysis across uneven chunk boundaries without changing Original', () => {
    const audio = tone({ sampleRate: 48000, stereo: true, seconds: 1.4, amplitude: 0.34 });
    audio.channels[1].forEach((value, index, channel) => { channel[index] = value * 0.66 + 0.015; });
    const original = audio.channels.map(channel => channel.slice());
    const reference = analyzeAudio(audio, { waveformBins: 73 });
    const stream = new StreamingAudioAnalyzer(48000, 2, audio.channels[0].length, 73);
    let offset = 0;
    for (const size of [1, 11, 4093, 17, 1200, 22222, 9, 32000, 90000]) {
      if (offset >= audio.channels[0].length) break;
      const end = Math.min(offset + size, audio.channels[0].length);
      stream.push({ sampleRate: 48000, channels: audio.channels.map(channel => channel.subarray(offset, end)) });
      offset = end;
    }
    if (offset < audio.channels[0].length)
      stream.push({ sampleRate: 48000, channels: audio.channels.map(channel => channel.subarray(offset)) });
    const result = stream.finish();
    for (const key of ['samplePeakDbfs', 'rmsDbfs', 'integratedLufs', 'truePeakDbtp', 'crestFactorDb', 'stereoCorrelation', 'sideEnergyPercent'] as const)
      expect(result[key]).toBeCloseTo(reference[key]!, 6);
    expect(result.waveform).toEqual(reference.waveform);
    expect(result.clippedSamples).toBe(reference.clippedSamples);
    expect(result.dcOffset[0]).toBeCloseTo(reference.dcOffset[0], 8);
    expect(result.dcOffset[1]).toBeCloseTo(reference.dcOffset[1], 8);
    expect(audio.channels).toEqual(original);
  });

  it('keeps the sinc peak estimate continuous across chunk boundaries', () => {
    const samples = new Float32Array(513);
    samples[29] = 0.63; samples[30] = -0.82; samples[255] = 0.93; samples[256] = -0.95;
    const estimator = new TruePeakEstimator();
    for (let i = 0; i < samples.length; i += 37) estimator.push(samples.subarray(i, i + 37));
    expect(estimator.finish()).toBe(estimateTruePeak(samples));
    expect(estimator.finish()).toBe(estimateTruePeak(samples));
    expect(() => estimator.push(samples)).toThrow();
  });

  it('rejects an incomplete or malformed chunk rather than reporting a partial song', () => {
    const analyzer = new StreamingAudioAnalyzer(48000, 1, 100);
    analyzer.push({ sampleRate: 48000, channels: [new Float32Array(40)] });
    expect(() => analyzer.finish()).toThrow('complete');
    expect(() => analyzer.push({ sampleRate: 44100, channels: [new Float32Array(60)] })).toThrow('format');
    expect(() => analyzer.push({ sampleRate: 48000, channels: [new Float32Array(61)] })).toThrow('dimensions');
    analyzer.push({ sampleRate: 48000, channels: [new Float32Array(60)] });
    expect(analyzer.finish().integratedLufs).toBeNull();
  });
});
