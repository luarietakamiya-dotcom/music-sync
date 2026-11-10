import { describe, it, expect } from 'vitest';
import { mixStems, planStemMix, createStemMixSession, suggestStemRole, STEM_LIMITS, autoMixMaster, DEFAULT_FINISH_CONTROLS, type AudioData, type StemDescriptor } from '@music-sync/core';
import { readWavMetadata, decodeWav } from '../../apps/web/src/decode';
import { tone, wav } from '../helpers/audio';

function track(id: string, audio: AudioData, options: Partial<StemDescriptor> = {}) {
  const descriptor: StemDescriptor = { id, name: `${id}.wav`, role: 'other', sampleRate: audio.sampleRate, channels: audio.channels.length, frames: audio.channels[0].length, gainDb: 0, pan: 0, muted: false, ...options };
  return { audio, descriptor };
}
describe('immutable aligned STEM / vocal-instrumental input', () => {
  it('keeps exact start alignment, pads shorter tails, and sums mono/stereo without changing sources', () => {
    const a = tone({ sampleRate: 8000, amplitude: 0, seconds: 1 }), b = tone({ sampleRate: 8000, amplitude: 0, seconds: 0.5, stereo: true });
    a.channels[0][101] = 0.1; b.channels[0][101] = 0.2; b.channels[1][102] = 0.3;
    const original = [a, b].map(t => t.channels.map(c => c.slice()));
    const result = mixStems([track('voice', a, { role: 'vocal' }), track('music', b, { role: 'instrumental' })], 'vocal-instrumental');
    expect(result.audio.channels[0][101]).toBeCloseTo(0.3, 7); expect(result.audio.channels[1][101]).toBeCloseTo(0.1, 7);
    expect(result.audio.channels[1][102]).toBeCloseTo(0.3, 7); expect(result.audio.channels[0].slice(103).every(x => x === 0)).toBe(true);
    expect(result.audio.channels[0].length).toBe(8000); expect(result.report.attenuationDb).toBe(0);
    expect(result.report.warnings.join(' ')).toContain('末尾を無音');
    expect([a.channels, b.channels]).toEqual(original);
  });
  it.each([8000, 48000, 192000])('protects the full summed peak at %i Hz by uniform attenuation, with no compression', sampleRate => {
    const audio = tone({ sampleRate, seconds: 0.5, amplitude: 0.8 });
    const original = audio.channels[0].slice();
    const tracks = Array.from({ length: 4 }, (_, i) => track(`part${i}`, audio));
    const result = mixStems(tracks);
    expect(result.analysis.truePeakDbtp!).toBeLessThanOrEqual(-3 + 0.0001); expect(result.analysis.clippedSamples).toBe(0);
    expect(result.report.attenuationDb).toBeLessThan(-12);
    const gain = 10 ** (result.report.attenuationDb / 20);
    expect(result.audio.channels[0][Math.floor(sampleRate * 0.0031)]).toBeCloseTo(original[Math.floor(sampleRate * 0.0031)] * 4 * gain, 6);
    expect(result.audio.channels[0]).toEqual(result.audio.channels[1]); expect(audio.channels[0]).toEqual(original);
  });
  it('applies selected per-track gain, mute and pan from immutable originals', () => {
    const audio = tone({ sampleRate: 8000, amplitude: 0.1 });
    const result = mixStems([track('left', audio, { pan: -1, gainDb: -6 }), track('mute', audio, { muted: true })]);
    expect(result.audio.channels[1].every(x => x === 0)).toBe(true);
    expect(result.audio.channels[0][1]).toBeCloseTo(audio.channels[0][1] * Math.SQRT2 * 10 ** (-6 / 20), 7);
    expect(result.report.tracks[1].descriptor.muted).toBe(true);
    const again = mixStems([track('left', audio, { pan: -1, gainDb: -6 }), track('mute', audio, { muted: true })]);
    expect(again).toEqual(result);
  });
  it('suggests roles from English/Japanese names without requiring naming conventions', () => {
    for (const [name, role] of [['Black Rose_Vocals.wav', 'vocal'], ['ボーカル.flac', 'vocal'], ['伴奏.wav', 'instrumental'], ['song_inst.wav', 'instrumental'], ['drums.wav', 'drums'], ['ベース.flac', 'bass'], ['guitar.wav', 'guitar'], ['ピアノ.wav', 'keys'], ['不明.wav', 'other']]) expect(suggestStemRole(name)).toBe(role);
  });
  it('validates paired roles, track counts, metadata, duplicates and sample-rate compatibility before allocation', () => {
    const a = track('a', tone({ sampleRate: 8000 })), b = track('b', tone({ sampleRate: 8000 }));
    expect(() => planStemMix([a.descriptor])).toThrow('2〜16');
    expect(() => planStemMix([a.descriptor, b.descriptor], 'vocal-instrumental')).toThrow('役割');
    expect(() => planStemMix([a.descriptor, { ...b.descriptor, sampleRate: 48000 }])).toThrow('サンプルレート');
    for (const bad of [{ ...b.descriptor, id: 'a' }, { ...b.descriptor, role: 'unknown' }, { ...b.descriptor, gainDb: NaN }, { ...b.descriptor, pan: 2 }, { ...b.descriptor, frames: 0 }])
      expect(() => planStemMix([a.descriptor, bad as StemDescriptor])).toThrow('不正');
    expect(() => planStemMix(Array.from({ length: 17 }, (_, i) => ({ ...a.descriptor, id: String(i) })))).toThrow('2〜16');
  });
  it('rejects unsafe bus/source budgets using metadata only, without allocating source PCM', () => {
    const base = track('a', tone({ sampleRate: 48000 })).descriptor;
    expect(() => planStemMix([{ ...base, frames: 48000 * 600 }, { ...base, id: 'b' }])).toThrow('合成音声');
    expect(() => planStemMix(Array.from({ length: 16 }, (_, i) => ({ ...base, id: String(i), channels: 2, frames: 48000 * 200 })))).toThrow('合計PCM');
    const valid = planStemMix([{ ...base, frames: 48000 * 180 }, { ...base, id: 'b', frames: 48000 * 180 }]);
    expect(valid.busBytes).toBeLessThan(STEM_LIMITS.maxBusBytes); expect(Object.isFrozen(valid)).toBe(true);
  });
  it('streaming session rejects wrong order/dimensions and prevents reuse after finalization', () => {
    const a = track('a', tone({ sampleRate: 8000 })), b = track('b', tone({ sampleRate: 8000 }));
    const session = createStemMixSession([a.descriptor, b.descriptor]);
    expect(() => session.finish()).toThrow('すべて'); expect(() => session.addTrack('b', b.audio)).toThrow('順序');
    expect(() => session.addTrack('a', tone({ sampleRate: 8000, seconds: 0.5 }))).toThrow('一致');
    session.addTrack('a', a.audio); session.addTrack('b', b.audio);
    const result = session.finish(); expect(result.report.tracks).toHaveLength(2);
    expect(() => session.addTrack('a', a.audio)).toThrow('finalized'); expect(() => session.finish()).toThrow();
  });
  it('supports cancellation before import and between tracks, without mutating originals', () => {
    const audio = tone({ sampleRate: 8000 }), original = audio.channels[0].slice();
    for (const point of [0, 0.4, 0.95, 1]) {
      const controller = new AbortController();
      expect(() => mixStems([track('a', audio), track('b', audio)], 'stems', { signal: controller.signal, onProgress: f => { if (f >= point) controller.abort(); } })).toThrow('cancelled');
    }
    expect(audio.channels[0]).toEqual(original);
  });
  it('records source clipping explicitly and can pass a clean bus into existing finishing/export analysis', () => {
    const dirty = mixStems([track('a', tone({ amplitude: 1.1 })), track('b', tone())]);
    expect(dirty.analysis.clippedSamples).toBe(0); expect(dirty.report.tracks[0].analysis.clippedSamples).toBeGreaterThan(0);
    expect(dirty.report.warnings.join(' ')).toContain('復元されません');
    const clean = mixStems([track('a', tone({ amplitude: 0.1 })), track('b', tone({ amplitude: 0.05, frequency: 1600 }))]);
    const result = autoMixMaster(clean.audio, 'AUTO', { preferences: { controls: DEFAULT_FINISH_CONTROLS, output: 'youtube' } });
    expect(result.status, result.reasons.join(' ')).toBe('accepted'); expect(result.finalAfter!.clippedSamples).toBe(0);
  });
  it('WAV metadata preflight and decode agree for all supported sample formats', () => {
    const audio = tone({ sampleRate: 8000, stereo: true, seconds: 0.1 });
    for (const [bits, float] of [[8, false], [16, false], [24, false], [32, false], [32, true]] as const) {
      const bytes = wav(audio, bits, float), meta = readWavMetadata(bytes), decoded = decodeWav(bytes);
      expect(meta).toEqual({ sampleRate: decoded.sampleRate, channels: decoded.channels.length, frames: decoded.channels[0].length });
    }
  });
});
