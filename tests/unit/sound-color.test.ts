import { describe, it, expect } from 'vitest';
import { applySoundColor, SOUND_COLOR_PRESETS, planSoundColor, analyzeAudio, evaluateSoundColorQuality, autoMixMaster, createComparisonPlan, type SoundColorSelection } from '@music-sync/core';
import { renderSoundColor } from '@music-sync/dsp';
import { tone } from '../helpers/audio';
import { perceptualFixture } from '../fixtures/perceptual';

const selection = (preset: SoundColorSelection['preset'], intensity: SoundColorSelection['intensity'] = 'standard'): SoundColorSelection => ({ preset, intensity });
const rms = (c: Float32Array) => Math.sqrt(c.reduce((n, x) => n + x * x, 0) / c.length);

describe('sound colour presets and safe candidates', () => {
  it.each(Object.keys(SOUND_COLOR_PRESETS) as SoundColorSelection['preset'][])('%s produces a measured independent candidate, preserving Original', preset => {
    const input = tone({ stereo: true, amplitude: 0.2, seconds: 0.6 });
    const original = input.channels.map(c => c.slice());
    const output = applySoundColor(input, selection(preset));
    expect(output.status).toBe('accepted'); expect(input.channels).toEqual(original);
    expect(output.processed!.audio.channels[0]).not.toBe(input.channels[0]);
    const last = output.attempts.at(-1)!;
    expect(last.after.frames).toBe(input.channels[0].length); expect(last.after.clippedSamples).toBe(0);
    expect(last.after.dcOffset.every(x => Math.abs(x) <= 0.003)).toBe(true);
    if (preset === 'none') expect(output.processed!.audio.channels).toEqual(original);
    else expect(last.after.truePeakDbtp!).toBeLessThanOrEqual(-1 + 0.0001);
    expect(createComparisonPlan(output.before, last.after).match.available).toBe(true);
  });
  it('EQ choices have the requested direction and stronger settings change more', () => {
    const input = tone({ frequency: 90, amplitude: 0.1, seconds: 0.6 }), before = analyzeAudio(input);
    const gentle = renderSoundColor(input, planSoundColor(before, selection('bass', 'gentle')));
    const vivid = renderSoundColor(input, planSoundColor(before, selection('bass', 'vivid')));
    expect(20 * Math.log10(rms(vivid.channels[0]) / rms(input.channels[0]))).toBeGreaterThan(2.5);
    expect(rms(vivid.channels[0])).toBeGreaterThan(rms(gentle.channels[0]));
    const high = tone({ frequency: 10000, seconds: 0.6 });
    const radio = renderSoundColor(high, planSoundColor(analyzeAudio(high), selection('am-radio', 'vivid')));
    expect(rms(radio.channels[0]) / rms(high.channels[0])).toBeLessThan(0.2);
  });
  it.each([8000, 44100, 192000])('all textures support %i Hz and one-sample boundaries with bounded finite output', sampleRate => {
    const input = { sampleRate, channels: [Float32Array.of(0.1)] };
    const before = analyzeAudio(input);
    for (const preset of Object.keys(SOUND_COLOR_PRESETS) as SoundColorSelection['preset'][]) {
      const output = renderSoundColor(input, planSoundColor(before, selection(preset, 'vivid')));
      expect(output.channels[0].length).toBe(1); expect(Number.isFinite(output.channels[0][0])).toBe(true);
    }
  });
  it('texture is deterministic, silent gaps stay silent, and invalid selections/parameters fail', () => {
    const silence = tone({ amplitude: 0, seconds: 0.5 }), plan = planSoundColor(analyzeAudio(silence), selection('cassette'));
    expect(renderSoundColor(silence, plan).channels[0].every(x => x === 0)).toBe(true);
    const input = tone({ seconds: 0.5 });
    expect(applySoundColor(input, selection('old-record'))).toEqual(applySoundColor(input, selection('old-record')));
    expect(() => applySoundColor(input, selection('unknown' as SoundColorSelection['preset']))).toThrow();
    expect(() => renderSoundColor(input, { ...plan, wowDepthMs: Infinity })).toThrow();
    expect(Object.isFrozen(SOUND_COLOR_PRESETS.cassette.bands)).toBe(true);
  });
  it('protects estimated true peak on a loud signal and refuses an already clipped source', () => {
    const input = tone({ amplitude: 0.85, frequency: 90, seconds: 0.6 });
    const output = applySoundColor(input, selection('bass', 'vivid'));
    expect(output.status).toBe('accepted'); expect(output.attempts.at(-1)!.after.truePeakDbtp!).toBeLessThanOrEqual(-1 + 0.0001);
    expect(output.attempts.length).toBeLessThanOrEqual(3);
    const clipped = applySoundColor(tone({ amplitude: 1.2 }), selection('warm'));
    expect(clipped.status).toBe('rejected'); expect(clipped.processed).toBeUndefined();
    expect(clipped.attempts).toHaveLength(0);
  });
  it('gate rejects clipping, invalid metrics, DC, changed length, excess reduction, and stereo degradation', () => {
    const before = analyzeAudio(tone({ stereo: true, seconds: 0.5 }));
    expect(evaluateSoundColorQuality(before, before, 0)).toEqual([]);
    for (const change of [{ clippedSamples: 1 }, { truePeakDbtp: 0 }, { rmsDbfs: NaN }, { dcOffset: [0.02, 0] }, { frames: before.frames + 1 }, { stereoCorrelation: -0.5 }]) {
      expect(evaluateSoundColorQuality(before, { ...before, ...change }, 0).length).toBeGreaterThan(0);
    }
    expect(evaluateSoundColorQuality(before, before, 5).length).toBeGreaterThan(0);
  });
  it('cancels before processing and during a texture pass, preserving input and settings', () => {
    const input = tone({ seconds: 0.6 }), original = input.channels[0].slice(), intent = selection('cassette');
    const a = new AbortController(); a.abort();
    expect(() => applySoundColor(input, intent, { signal: a.signal })).toThrow('cancelled');
    const b = new AbortController();
    expect(() => applySoundColor(input, intent, { signal: b.signal, onProgress: f => { if (f > 0.06) b.abort(); } })).toThrow('cancelled');
    expect(input.channels[0]).toEqual(original); expect(intent).toEqual(selection('cassette'));
  });
  it('switches presets without accumulating processing, and AUTO can add an independently evaluated colour', () => {
    const input = perceptualFixture('balanced'), original = input.channels.map(c => c.slice());
    const first = applySoundColor(input, selection('warm'));
    const second = applySoundColor(input, selection('cassette'));
    const again = applySoundColor(input, selection('warm'));
    expect(first).toEqual(again); expect(first.processed!.audio.channels).not.toEqual(second.processed!.audio.channels);
    const automatic = autoMixMaster(input, 'AUTO', { soundColor: selection('am-radio') });
    expect(automatic.status).toBe('accepted'); expect(automatic.soundColor?.status).toBe('accepted');
    expect(automatic.soundColor?.attempts.at(-1)!.after.clippedSamples).toBe(0);
    expect(input.channels).toEqual(original);
  });
});
