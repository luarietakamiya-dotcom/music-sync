import { describe, expect, it } from 'vitest';
import { analyzePerceptualFeatures, createStemMixSession, evaluateStemMasking, finishStemMix, mixStems, mixStemsWithCorrection,
  planStemBalance, planStemMasking, type AudioData, type StemDescriptor } from '@music-sync/core';
import { streamStemPresenceDip } from '@music-sync/dsp';

function material(amplitude: number, frequencies = [320, 910, 1850, 3300, 6100]): AudioData {
  const sampleRate = 16000, frames = sampleRate * 2;
  return { sampleRate, channels: [Float32Array.from({ length: frames }, (_, i) =>
    amplitude * frequencies.reduce((sum, hz) => sum + Math.sin(2 * Math.PI * hz * i / sampleRate), 0) / frequencies.length)] };
}
function pair(voice = material(0.02), music = material(0.22)) {
  const descriptor = (id: string, role: StemDescriptor['role'], audio: AudioData): StemDescriptor => ({
    id, name: `${id}.wav`, role, sampleRate: audio.sampleRate, channels: audio.channels.length,
    frames: audio.channels[0].length, gainDb: 0, pan: 0, muted: false,
  });
  return [{ descriptor: descriptor('voice', 'vocal', voice), audio: voice },
    { descriptor: descriptor('music', 'instrumental', music), audio: music }];
}

describe('adaptive accompaniment masking relief', () => {
  it('plans a small instrumental cut, verifies the rendered band and preserves original PCM', () => {
    const input = pair(), original = input.map(track => track.audio.channels[0].slice());
    const result = mixStemsWithCorrection(input);
    expect(result.report.autoBalance?.status).toBe('adjusted');
    expect(result.report.masking?.status).toBe('applied');
    expect(result.report.masking?.evaluation?.accepted).toBe(true);
    expect(result.report.masking?.evaluation?.presenceReductionDb).toBeGreaterThan(0.15);
    expect(result.report.plan.tracks[1].presenceDip?.gainDb).toBeGreaterThanOrEqual(-2);
    expect(result.report.plan.tracks[0].presenceDip).toBeUndefined();
    expect(result.analysis.clippedSamples).toBe(0);
    expect(result.analysis.truePeakDbtp!).toBeLessThanOrEqual(-3 + 0.001);
    expect(input.map(track => track.audio.channels[0])).toEqual(original);
    expect(finishStemMix(result, 'AUTO').sourceMix.masking?.status).toBe('applied');
  });

  it('does not add unnecessary EQ when the pair is balanced', () => {
    const input = pair(material(0.12), material(0.12));
    const corrected = mixStemsWithCorrection(input);
    expect(corrected.report.masking?.status).toBe('unchanged');
    expect(corrected.report.plan.tracks[1].presenceDip).toBeUndefined();
    expect(corrected.audio).toEqual(mixStems(input, 'vocal-instrumental').audio);
  });

  it('skips uncertain overlap and validates roles before any DSP', () => {
    const input = pair();
    const descriptors = input.map(track => track.descriptor);
    const features = input.map(track => analyzePerceptualFeatures(track.audio));
    const balance = planStemBalance(descriptors, features);
    expect(planStemMasking(descriptors, [{ ...features[0], confidence: 0.1 }, features[1]], balance).status).toBe('skipped');
    expect(() => planStemMasking([{ ...descriptors[0], role: 'other' }, descriptors[1]], features, balance)).toThrow('計画');
    expect(() => mixStems([{ ...input[0], descriptor: { ...descriptors[0], presenceDip: { frequencyHz: 3200, gainDb: -4, q: 0.85 } } }, input[1]])).toThrow('帯域補正');
    const unchanged = planStemMasking(descriptors, features, balance);
    const forged = { ...descriptors[1], presenceDip: { frequencyHz: 3200, gainDb: -1, q: 0.85 } };
    expect(() => createStemMixSession([descriptors[0], forged], 'vocal-instrumental', undefined,
      { ...unchanged, status: 'unchanged' })).toThrow('計画');
  });

  it('ignores an old caller dip when the adaptive plan decides no correction is needed', () => {
    const input = pair(material(0.12), material(0.12));
    const stale = { ...input[1], descriptor: { ...input[1].descriptor,
      presenceDip: { frequencyHz: 3200, gainDb: -1, q: 0.85 } } };
    const corrected = mixStemsWithCorrection([input[0], stale]);
    expect(corrected.report.masking?.status).toBe('unchanged');
    expect(corrected.report.plan.tracks[1].presenceDip).toBeUndefined();
    expect(corrected.audio).toEqual(mixStems(input, 'vocal-instrumental').audio);
  });

  it('reverts an unproven filtered candidate and keeps the manual bus exactly', () => {
    const input = pair(material(0.02), material(0.22, [320]));
    const proposed = { ...input[1].descriptor, presenceDip: { frequencyHz: 3200, gainDb: -1.5, q: 0.85 } };
    const candidate = mixStems([input[0], { ...input[1], descriptor: proposed }], 'vocal-instrumental');
    const manual = mixStems(input, 'vocal-instrumental');
    expect(candidate.report.masking?.status).toBe('reverted');
    expect(candidate.report.plan.tracks[1].presenceDip).toBeUndefined();
    expect(candidate.audio).toEqual(manual.audio);
    const features = analyzePerceptualFeatures(input[1].audio);
    const failed = evaluateStemMasking({ version: 1, status: 'proposed', instrumentalId: 'music', confidence: 1,
      relativePresenceDbBefore: -9, relativePresenceDbAfter: -9, dip: proposed.presenceDip, explanation: 'test' },
    features, features, { samplePeak: 1.1, clippedSamples: 1 });
    expect(failed.status).toBe('reverted');
    expect(failed.evaluation?.reasons.join(' ')).toContain('ピーク');
  });

  it('cancels during bounded filter evaluation without modifying source PCM', () => {
    const audio = material(0.2), original = audio.channels[0].slice(), controller = new AbortController();
    expect(() => streamStemPresenceDip(audio, { frequencyHz: 3200, gainDb: -1, q: 0.85 },
      () => controller.abort(), controller.signal)).toThrow('cancelled');
    expect(audio.channels[0]).toEqual(original);
  });
});
