import { describe, expect, it } from 'vitest';
import { analyzePerceptualFeatures, finishStemMix, mixStemsWithBalance, planStemBalance, type AudioData, type StemDescriptor } from '@music-sync/core';

function material(amplitude: number): AudioData {
  const sampleRate = 16000, frames = sampleRate * 2;
  const channel = Float32Array.from({ length: frames }, (_, i) => {
    const t = i / sampleRate;
    return amplitude * (Math.sin(2 * Math.PI * 320 * t) + Math.sin(2 * Math.PI * 910 * t) +
      Math.sin(2 * Math.PI * 1850 * t) + Math.sin(2 * Math.PI * 3300 * t) + Math.sin(2 * Math.PI * 6100 * t)) / 5;
  });
  return { sampleRate, channels: [channel] };
}
function pair(vocal: AudioData, instrumental: AudioData, vocalGain = 0) {
  const descriptor = (id: string, role: StemDescriptor['role'], audio: AudioData, gainDb: number): StemDescriptor => ({
    id, name: `${id}.wav`, role, sampleRate: audio.sampleRate, channels: audio.channels.length,
    frames: audio.channels[0].length, gainDb, pan: 0, muted: false,
  });
  return [{ descriptor: descriptor('voice', 'vocal', vocal, vocalGain), audio: vocal },
    { descriptor: descriptor('music', 'instrumental', instrumental, 0), audio: instrumental }];
}

describe('conservative adaptive vocal + accompaniment balance', () => {
  it('raises only a quiet vocal, protects the bus and keeps both source buffers unchanged', () => {
    const voice = material(0.02), music = material(0.22), input = pair(voice, music);
    const originals = input.map(track => track.audio.channels[0].slice());
    const result = mixStemsWithBalance(input);
    const balance = result.report.autoBalance!;
    expect(balance.status).toBe('adjusted');
    expect(balance.tracks[0].adjustmentDb).toBeGreaterThan(0);
    expect(balance.tracks[0].adjustmentDb).toBeLessThanOrEqual(3);
    expect(balance.tracks[1].adjustmentDb).toBe(0);
    expect(balance.relativePresenceDbAfter!).toBeGreaterThan(balance.relativePresenceDbBefore!);
    expect(result.report.plan.tracks[0].gainDb).toBe(balance.tracks[0].gainDb);
    expect(result.analysis.clippedSamples).toBe(0);
    expect(result.analysis.truePeakDbtp!).toBeLessThanOrEqual(-3 + 0.001);
    expect(input.map(track => track.audio.channels[0])).toEqual(originals);
    expect(finishStemMix(result, 'AUTO').sourceMix.autoBalance).toEqual(balance);
  });

  it('leaves an adequate balance alone and never normalizes every source to the same LUFS', () => {
    const input = pair(material(0.13), material(0.13));
    const result = mixStemsWithBalance(input);
    expect(result.report.autoBalance).toMatchObject({ status: 'unchanged', tracks: [
      { adjustmentDb: 0 }, { adjustmentDb: 0 },
    ] });
  });

  it('reduces an overly dominant vocal conservatively, respecting the user gain bound', () => {
    const input = pair(material(0.35), material(0.015));
    const features = input.map(track => analyzePerceptualFeatures(track.audio));
    const plan = planStemBalance(input.map(track => track.descriptor), features);
    expect(plan.status).toBe('adjusted');
    expect(plan.tracks[0].adjustmentDb).toBeLessThan(0);
    expect(plan.tracks[0].adjustmentDb).toBeGreaterThanOrEqual(-2);
    const capped = pair(material(0.02), material(0.22), 6);
    const cappedPlan = planStemBalance(capped.map(track => track.descriptor), capped.map(track => analyzePerceptualFeatures(track.audio)));
    expect(cappedPlan.tracks[0].gainDb).toBeLessThanOrEqual(6);
    expect(cappedPlan.status).toBe('skipped');
    expect(cappedPlan.explanation).toContain('範囲');
  });

  it('skips muted or insufficient evidence and rejects invalid roles or metadata', () => {
    const input = pair(material(0.02), material(0.22));
    const features = input.map(track => analyzePerceptualFeatures(track.audio));
    const descriptors = input.map(track => track.descriptor);
    expect(planStemBalance([{ ...descriptors[0], muted: true }, descriptors[1]], features).status).toBe('skipped');
    expect(planStemBalance(descriptors, [{ ...features[0], confidence: 0.1 }, features[1]]).status).toBe('skipped');
    expect(() => planStemBalance([{ ...descriptors[0], role: 'other' }, descriptors[1]], features)).toThrow('役割');
    expect(() => mixStemsWithBalance([{ ...input[0], descriptor: { ...descriptors[0], frames: 100 } }, input[1]])).toThrow('一致');
  });

  it('honors cancellation without modifying source PCM', () => {
    const input = pair(material(0.02), material(0.22));
    const original = input[0].audio.channels[0].slice();
    const controller = new AbortController();
    expect(() => mixStemsWithBalance(input, { signal: controller.signal, onProgress: fraction => {
      if (fraction >= 0.15) controller.abort();
    } })).toThrow('cancelled');
    expect(input[0].audio.channels[0]).toEqual(original);
  });
});
