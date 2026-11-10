import { expect, it } from 'vitest';
import type { AudioData } from '@music-sync/shared';
import type { StemDescriptor } from '@music-sync/core';
import { createStemClarityAnalyzer, planStemClarity, type StemClarityFeatures } from '../../packages/core/src/stem-clarity';
const rate = 16000, frames = rate, windowFrames = rate / 20, windows = 20;
type Track = StemDescriptor & {
    vocalRole?: 'lead' | 'backing';
};
function track(id: string, role: Track['role'], vocalRole?: Track['vocalRole']): Track {
    return { id, name: id + '.wav', role, vocalRole, sampleRate: rate, channels: 1, frames, gainDb: 0, pan: 0, muted: false };
}
function data(presence: number, body = 0.2, low = 0.001): StemClarityFeatures {
    return { sampleRate: rate, channels: 1, frames, windowFrames,
        presenceEnergy: new Float32Array(windows).fill(presence), lowEnergy: new Float32Array(windows).fill(low),
        bodyRms: new Float32Array(windows).fill(body), attack: new Uint8Array(windows), clippedSamples: 0 };
}
function fixture() {
    const tracks = [track('voice', 'vocal', 'lead'), track('guitar', 'guitar'), track('drums', 'drums'), track('bass', 'bass')];
    const features = [data(0.002, 0.1), data(0.03, 0.25), data(0.001, 0.1), data(0.0001, 0.12)];
    for (let i = 0; i < windows; i++)
        if (i < 4 || i >= 12) {
            features[0].presenceEnergy[i] = 0;
            features[0].bodyRms[i] = 0;
        }
    return { tracks, features };
}
it('measures identical band energies through arbitrary contiguous chunks and retains source PCM', () => {
    const sampleRate = 16000, count = 32117;
    const pcm = Float32Array.from({ length: count }, (_, i) => 0.12 * Math.sin(2 * Math.PI * 100 * i / sampleRate) + 0.04 * Math.sin(2 * Math.PI * 2300 * i / sampleRate));
    const audio: AudioData = { sampleRate, channels: [pcm, pcm.slice()] }, original = pcm.slice();
    const one = createStemClarityAnalyzer(sampleRate, 2, count), chunks = createStemClarityAnalyzer(sampleRate, 2, count);
    one.push(audio);
    for (let i = 0; i < count; i += 317)
        chunks.push({ sampleRate, channels: audio.channels.map(channel => channel.subarray(i, i + 317)) });
    const a = one.finish(), b = chunks.finish();
    expect(b).toEqual(a);
    expect(a.presenceEnergy.length).toBe(Math.ceil(count / 800));
    expect(a.presenceEnergy[10]).toBeGreaterThan(0.0001);
    expect(a.lowEnergy[10]).toBeGreaterThan(0.001);
    expect(pcm).toEqual(original);
});
it('cuts only overlapping accompaniment during a masked lead, preserving intros, breaks, lead and bass presence', () => {
    const { tracks, features } = fixture();
    const saved = JSON.stringify(features), descriptors = JSON.stringify(tracks);
    const result = planStemClarity(tracks, features);
    expect(result.report.status).toBe('applied');
    expect(result.report.leadId).toBe('voice');
    expect(result.report.maskedSeconds).toBeCloseTo(0.4, 6);
    expect(result.report.projectedPresenceImprovementDb).toBeGreaterThan(1);
    expect(result.tracks[0].presenceDb.every(value => value === 0)).toBe(true);
    expect(result.tracks[3].presenceDb.every(value => value === 0)).toBe(true);
    expect(result.tracks[1].presenceDb[3]).toBe(0);
    expect(result.tracks[1].presenceDb[4]).toBe(-2);
    expect(result.tracks[1].presenceDb[12]).toBe(0);
    expect(JSON.stringify(result.report)).not.toContain('presenceDb');
    expect(JSON.stringify(features)).toBe(saved);
    expect(JSON.stringify(tracks)).toBe(descriptors);
});
it('keeps balanced passages and silent lead windows unprocessed', () => {
    const { tracks, features } = fixture();
    features[0].presenceEnergy.fill(0.1);
    expect(planStemClarity(tracks, features).report.status).toBe('skipped');
    features[0].bodyRms.fill(0);
    const silent = planStemClarity(tracks, features);
    expect(silent.report.activeLeadSeconds).toBe(0);
    expect(silent.tracks.every(item => item.presenceDb.every(value => value === 0) && item.lowDb.every(value => value === 0))).toBe(true);
});
it('requires an unambiguous included lead and supports a legacy single vocal', () => {
    const { tracks, features } = fixture();
    tracks[0].vocalRole = undefined;
    expect(planStemClarity(tracks, features).report.leadId).toBe('voice');
    const second = track('second', 'vocal');
    expect(planStemClarity([...tracks, second], [...features, data(0.01)]).report.status).toBe('skipped');
    tracks[0].vocalRole = 'lead';
    second.vocalRole = 'lead';
    expect(planStemClarity([...tracks, second], [...features, data(0.01)]).report.leadId).toBeNull();
    tracks[0].muted = true;
    expect(planStemClarity(tracks, features).report.status).toBe('skipped');
});
it('gently adjusts explicit backing vocals, leaves unspecified duet voices intact and respects manual gains', () => {
    const { tracks, features } = fixture();
    const backing1 = track('back1', 'vocal', 'backing'), backing2 = track('back2', 'vocal', 'backing'), duet = track('duet', 'vocal');
    const result = planStemClarity([...tracks, backing1, backing2, duet], [...features, data(0.02), data(0.02), data(0.02)]);
    expect(result.tracks[4].presenceDb[5]).toBe(-1);
    expect(result.tracks[5].presenceDb[5]).toBe(-1);
    expect(result.tracks[6].presenceDb.every(value => value === 0)).toBe(true);
    tracks[0].gainDb = 6;
    tracks[1].gainDb = -12;
    expect(planStemClarity(tracks, features).report.maskedSeconds).toBe(0);
});
it('allows a bounded bass cut only at a sung kick/bass collision and leaves drums low band unchanged', () => {
    const { tracks, features } = fixture();
    features[1] = data(0.001, 0.05, 0.0001);
    features[2] = data(0.001, 0.2, 0.025);
    features[3] = data(0.0001, 0.2, 0.028);
    features[2].attack[1] = 1;
    features[2].attack[6] = 1;
    features[2].attack[9] = 1;
    features[2].attack[15] = 1;
    const result = planStemClarity(tracks, features);
    expect(result.tracks[3].lowDb[1]).toBe(0);
    expect(result.tracks[3].lowDb[6]).toBe(-1);
    expect(result.tracks[3].lowDb[7]).toBe(0);
    expect(result.tracks[3].lowDb[15]).toBe(0);
    expect(result.tracks[2].lowDb.every(value => value === 0)).toBe(true);
    expect(result.report.tracks[3].lowSeconds).toBeCloseTo(0.1, 6);
    tracks[3].muted = true;
    expect(planStemClarity(tracks, features).tracks[3].lowDb.every(value => value === 0)).toBe(true);
});
it('validates frame trajectories, records clipping and stops a cancelled planning pass', () => {
    const { tracks, features } = fixture();
    const cancelled = new AbortController();
    cancelled.abort();
    expect(() => planStemClarity(tracks, features, { signal: cancelled.signal })).toThrow();
    expect(() => planStemClarity(tracks, [...features.slice(1)])).toThrow();
    features[1].presenceEnergy[0] = Number.NaN;
    expect(() => planStemClarity(tracks, features)).toThrow();
    features[1].presenceEnergy[0] = 0.03;
    features[1].clippedSamples = 1;
    expect(planStemClarity(tracks, features).report.status).toBe('skipped');
    const analyzer = createStemClarityAnalyzer(8000, 1, 100);
    analyzer.push({ sampleRate: 8000, channels: [new Float32Array(100).fill(1.1)] });
    expect(analyzer.finish().clippedSamples).toBe(100);
    expect(() => createStemClarityAnalyzer(8000, 1, 0)).toThrow();
});
