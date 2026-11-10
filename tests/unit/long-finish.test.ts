import { describe, expect, it } from 'vitest';
import { analyzeAudio, createLongMix, longMasterGain, checkLongCandidate } from '@music-sync/core';
import { tone } from '../helpers/audio';

describe('long WAV finishing', () => {
  it('carries LIVE reflections over uneven block boundaries', () => {
    const input = tone({ seconds: 0.6, stereo: true });
    const report = analyzeAudio(input);
    const render = (block: number) => {
      const channels = input.channels.map(channel => channel.slice());
      const mix = createLongMix(report, 'LIVE', { venue: 'arena', intensity: 'standard' }, 1);
      for (let i = 0; i < report.frames; i += block) mix.processOwned({ sampleRate: report.sampleRate, channels: channels.map(c => c.subarray(i, i + block)) });
      return channels;
    };
    const whole = render(report.frames);
    expect(render(513)).toEqual(whole);
    expect(whole[0][20000]).not.toBe(input.channels[0][20000]);
  });
  it('limits gain using True Peak and rejects a clipped or shortened candidate', () => {
    const report = analyzeAudio(tone());
    expect(longMasterGain({ ...report, truePeakDbtp: -1.2 }, 'IMPACT', 'cd').gainDb).toBeCloseTo(0.199);
    expect(checkLongCandidate(report, report, -16)).toBe(true);
    expect(checkLongCandidate(report, { ...report, clippedSamples: 1 }, -16)).toBe(false);
    expect(checkLongCandidate(report, { ...report, frames: report.frames - 1 }, -16)).toBe(false);
  });
});
