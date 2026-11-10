import { describe, it, expect } from 'vitest';
import { mixStems, finishStemMix, masterStemMix, anonymizeFinishingReport, suggestStemRole, type AudioData, type StemDescriptor } from '@music-sync/core';
import { tone } from '../helpers/audio';

const track = (id: string, audio: AudioData, muted = false) => ({ audio, descriptor: {
  id, name: `private-${id}.wav`, role: 'other', sampleRate: audio.sampleRate, channels: audio.channels.length,
  frames: audio.channels[0].length, gainDb: 0, pan: 0, muted,
} satisfies StemDescriptor });
describe('review regression: source provenance and anonymous reports', () => {
  it.each(['no_vocals.wav', 'Vocal Removed.wav', 'without-voice.flac', 'ボーカルなし.wav', 'ヴォーカル除去.wav'])('recognizes instrumental negation: %s', name => {
    expect(suggestStemRole(name)).toBe('instrumental');
  });
  it('rejects a clipped source through both public STEM finishing APIs even when the sum is clean', () => {
    const dirty = tone({ sampleRate: 16000, seconds: 1, amplitude: 1.2 });
    for (let i = 0; i < dirty.channels[0].length; i++) dirty.channels[0][i] = Math.max(-1, Math.min(1, dirty.channels[0][i]));
    const mixed = mixStems([track('voice', dirty), track('music', tone({ sampleRate: 16000, seconds: 1 }))]);
    expect(mixed.analysis.clippedSamples).toBe(0); expect(mixed.report.tracks[0].analysis.clippedSamples).toBeGreaterThan(0);
    expect(() => finishStemMix(mixed)).toThrow('元のSTEMにクリッピング');
    expect(() => masterStemMix(mixed, { targetLufs: -16, ceilingDb: -1 })).toThrow('元のSTEMにクリッピング');
  });
  it('permits a muted clipped track, retains evidence and never writes original PCM', () => {
    const dirty = tone({ sampleRate: 16000, amplitude: 1.2 }), clean = tone({ sampleRate: 16000, amplitude: 0.1 });
    const original = clean.channels[0].slice();
    const mixed = mixStems([track('excluded', dirty, true), track('included', clean)]);
    const result = finishStemMix(mixed);
    expect(result.status).toBe('accepted'); expect(result.sourceMix).toBe(mixed.report);
    expect(clean.channels[0]).toEqual(original);
  });
  it('validates source report shape and checks cancellation before running the engine', () => {
    const audio = tone({ sampleRate: 16000 });
    const mixed = mixStems([track('a', audio), track('b', audio)]);
    expect(() => finishStemMix({ ...mixed, audio: { ...mixed.audio, sampleRate: 48000 } })).toThrow('一致');
    const controller = new AbortController(); controller.abort();
    expect(() => finishStemMix(mixed, 'AUTO', { signal: controller.signal })).toThrow('cancelled');
    mixed.report.tracks[0].analysis.clippedSamples = NaN;
    expect(() => finishStemMix(mixed)).toThrow('素材解析');
  });
  it('anonymizes names, IDs and future free-text strings while retaining numeric evidence and not changing the report', () => {
    const report = { status: 'accepted', mode: 'AUTO', name: 'AUTO', path: 'C:/private/song.wav',
      tracks: [{ id: 'private-id', name: 'private-voice.wav', role: 'vocal', clippedSamples: 0 }],
      plan: { tracks: [{ id: 'private-id', name: 'private-voice.wav' }] },
      futureExplanation: 'private-voice.wav from C:/private is not repaired', futureCode: 'AUTO', integratedLufs: -16,
      processed: { audio: { channels: [new Float32Array([0.5])] } } };
    const before = JSON.stringify(report), anonymous = anonymizeFinishingReport(report);
    const json = JSON.stringify(anonymous);
    expect(json).not.toMatch(/private|song|channels|processed/);
    expect(anonymous).toMatchObject({ status: 'accepted', mode: 'AUTO', integratedLufs: -16,
      tracks: [{ role: 'vocal', clippedSamples: 0 }] });
    expect(JSON.stringify(report)).toBe(before);
    const parsed = JSON.parse(json);
    expect(parsed.tracks[0].id).toBe(parsed.plan.tracks[0].id);
    expect(parsed.tracks[0].name).toBe(parsed.plan.tracks[0].name);
    expect(parsed.name).not.toBe('AUTO');
    expect(parsed.futureCode).toBe('[redacted]');
  });
});
