import { expect, it } from 'vitest';
import { analyzeAudio } from '@music-sync/audio-analysis';
import { evaluateStemClarityQuality, planStemMix, renderFileStems, suggestStemRole, suggestStemVocalRole, type AudioData, type StemDescriptor } from '@music-sync/core';

const rate = 16000, blockFrames = 257;
function material(id: string, role: StemDescriptor['role'], seconds: number, sample: (n: number) => number, vocalRole?: StemDescriptor['vocalRole']) {
  const audio: AudioData = { sampleRate: rate, channels: [Float32Array.from({ length: Math.round(rate * seconds) }, (_, n) => sample(n))] };
  const descriptor: StemDescriptor = { id, name: id + '.wav', role, vocalRole, sampleRate: rate, channels: 1,
    frames: audio.channels[0].length, gainDb: 0, pan: 0, muted: false };
  return { audio, descriptor, async *open() {
    for (let n = 0; n < descriptor.frames; n += blockFrames)
      yield { sampleRate: rate, channels: audio.channels.map(channel => channel.subarray(n, n + blockFrames)) };
  } };
}
const sine = (n: number, hz: number) => Math.sin(2 * Math.PI * hz * n / rate);
function fixture() {
  return [
    material('lead', 'vocal', 4, n => n >= rate && n < rate * 3 ? 0.03 * sine(n, 2300) + 0.01 * sine(n, 700) : 0, 'lead'),
    material('guitar', 'guitar', 4, n => 0.23 * sine(n, 2600) + 0.03 * sine(n, 330)),
    material('chorus', 'vocal', 4, n => n >= rate * 1.5 && n < rate * 2.5 ? 0.05 * sine(n, 2700) : 0, 'backing'),
    material('bass', 'bass', 4, n => 0.08 * sine(n, 100)),
  ];
}
async function render(tracks: ReturnType<typeof fixture>, clarity: boolean, signal?: AbortSignal, progress?: (fraction: number, text: string) => void) {
  const frames = Math.max(...tracks.map(track => track.descriptor.frames));
  const channels = [new Float32Array(frames), new Float32Array(frames)];
  let offset = 0;
  const result = await renderFileStems(tracks, { mode: 'stems', autoBalance: false, clarity, blockFrames, signal, progress,
    async write(block) {
      block.channels.forEach((channel, c) => channels[c].set(channel, offset));
      offset += block.channels[0].length;
    } });
  expect(offset).toBe(frames);
  return { ...result, channels };
}
function difference(a: Float32Array, b: Float32Array, start: number, end: number, gainA = 1, gainB = 1) {
  let largest = 0;
  for (let n = start; n < end; n++) largest = Math.max(largest, Math.abs(a[n] / gainA - b[n] / gainB));
  return largest;
}

it('renders measured masked passages, keeps dry intros/breaks and all original samples, and accepts the measured candidate', async () => {
  const tracks = fixture(), descriptors = structuredClone(tracks.map(track => track.descriptor));
  const originals = tracks.map(track => track.audio.channels[0].slice());
  const dry = await render(tracks, false), processed = await render(tracks, true);
  const clarity = processed.report.clarity!;
  expect(clarity.status).toBe('applied');
  expect(clarity.evaluation?.accepted).toBe(true);
  expect(clarity.maskedSeconds).toBeGreaterThan(1.5);
  expect(clarity.tracks.find(track => track.id === 'lead')?.presenceSeconds).toBe(0);
  expect(clarity.tracks.find(track => track.id === 'guitar')?.maxPresenceReductionDb).toBeLessThanOrEqual(2);
  expect(clarity.tracks.find(track => track.id === 'chorus')?.maxPresenceReductionDb).toBeLessThanOrEqual(1);
  const dryGain = 10 ** (dry.report.attenuationDb / 20), wetGain = 10 ** (processed.report.attenuationDb / 20);
  expect(difference(dry.channels[0], processed.channels[0], rate / 4, rate * 3 / 4, dryGain, wetGain)).toBeLessThan(1e-7);
  expect(difference(dry.channels[0], processed.channels[0], rate * 3.25, rate * 3.75, dryGain, wetGain)).toBeLessThan(1e-7);
  expect(difference(dry.channels[0], processed.channels[0], rate * 1.2, rate * 2.8, dryGain, wetGain)).toBeGreaterThan(0.005);
  expect(tracks.map(track => track.descriptor)).toEqual(descriptors);
  for (const [i, track] of tracks.entries()) expect(track.audio.channels[0].every((value, n) => value === originals[i][n])).toBe(true);
});

it('applies one whole-song headroom gain after the adaptive chain without clipping the summed bus', async () => {
  const tracks = fixture();
  tracks[3] = material('bass', 'bass', 4, n => 0.65 * sine(n, 100));
  tracks.forEach(track => { track.descriptor.gainDb = 6; });
  const result = await render(tracks, true);
  expect(result.report.clarity?.status).toBe('applied');
  expect(result.report.attenuationDb).toBeLessThan(0);
  expect(result.analysis.truePeakDbtp).toBeLessThanOrEqual(-3);
  expect(result.analysis.clippedSamples).toBe(0);
  expect(result.report.tracks.every(track => track.analysis.clippedSamples === 0)).toBe(true);
});

it('leaves an ambiguous duet and the disabled path exactly dry', async () => {
  const tracks = fixture();
  delete tracks[0].descriptor.vocalRole;
  delete tracks[2].descriptor.vocalRole;
  const dry = await render(tracks, false), ambiguous = await render(tracks, true);
  expect(dry.report.clarity).toBeUndefined();
  expect(ambiguous.report.clarity?.status).toBe('skipped');
  expect(ambiguous.report.clarity?.leadId).toBeNull();
  expect(ambiguous.channels).toEqual(dry.channels);
  expect(ambiguous.report.clarity?.reasons.join(' ')).toContain('メインボーカル');
});

it('processes a shorter lead and backing track without changing or truncating the instrumental tail', async () => {
  const tracks = fixture();
  tracks[0] = material('lead', 'vocal', 2.15, n => n >= rate ? 0.025 * sine(n, 2300) : 0, 'lead');
  tracks[2] = material('chorus', 'vocal', 1.73, n => 0.02 * sine(n, 2700), 'backing');
  const dry = await render(tracks, false), processed = await render(tracks, true);
  expect(processed.report.clarity?.status).toBe('applied');
  expect(processed.analysis.frames).toBe(rate * 4);
  expect(processed.report.clarity!.activeLeadSeconds).toBeLessThanOrEqual(1.2);
  expect(difference(dry.channels[0], processed.channels[0], rate * 3, rate * 4,
    10 ** (dry.report.attenuationDb / 20), 10 ** (processed.report.attenuationDb / 20))).toBeLessThan(1e-7);
});

it('cancels the adaptive measurement pass before any output commit', async () => {
  const controller = new AbortController();
  let writes = 0;
  await expect(renderFileStems(fixture(), { mode: 'stems', autoBalance: false, clarity: true, blockFrames,
    signal: controller.signal, progress(_fraction, text) {
      if (text.includes('検証しています')) controller.abort();
    }, async write() { writes++; } })).rejects.toThrow();
  expect(writes).toBe(0);
});

it('rejects measured loudness, dynamics, stereo and DC regressions instead of accepting any processed mix', () => {
  const input: AudioData = { sampleRate: rate, channels: [Float32Array.from({ length: rate }, (_, n) => 0.1 * sine(n, 400))] };
  const before = analyzeAudio(input);
  expect(evaluateStemClarityQuality(before, before, 1).accepted).toBe(true);
  const regressions = [
    { rmsDbfs: before.rmsDbfs! - 2 },
    { rmsDbfs: before.rmsDbfs! + 0.3 },
    { crestFactorDb: before.crestFactorDb! - 2 },
    { stereoCorrelation: 0.8 },
    { sideEnergyPercent: 5 },
    { dcOffset: [0.02] },
    { frames: before.frames - 1 },
  ];
  const stereoBefore = { ...before, stereoCorrelation: 0.99, sideEnergyPercent: 0 };
  for (const regression of regressions) {
    const evaluation = evaluateStemClarityQuality(stereoBefore, { ...stereoBefore, ...regression }, 0.5);
    expect(evaluation.accepted).toBe(false);
    expect(evaluation.reasons.length).toBeGreaterThan(0);
  }
});

it('includes the final peak-protection gain in its quality decision even when normalized meters are identical', () => {
  const before = analyzeAudio({ sampleRate: rate, channels: [Float32Array.from({ length: rate }, (_, n) => 0.01 * sine(n, 400))] });
  const safe = evaluateStemClarityQuality(before, before, 1, { beforeGain: 0.5, afterGain: 0.5, measurementGain: 0.01 });
  expect(safe.accepted).toBe(true);
  const excessiveLoss = evaluateStemClarityQuality(before, before, 1, {
    beforeGain: 0.5, afterGain: 0.5 * 10 ** (-3 / 20), measurementGain: 0.01,
  });
  expect(excessiveLoss.accepted).toBe(false);
  expect(excessiveLoss.rmsChangeDb).toBeCloseTo(-3, 8);
  expect(excessiveLoss.headroomGainChangeDb).toBeCloseTo(-3, 8);
  expect(excessiveLoss.reasons.join(' ')).toContain('平均音量');
});

it('evaluates DC in final output units rather than allowing a large offset behind measurement attenuation', () => {
  const before = analyzeAudio({ sampleRate: rate, channels: [Float32Array.from({ length: rate }, (_, n) => 0.001 * sine(n, 400))] });
  const after = { ...before, dcOffset: [0.0001] };
  expect(evaluateStemClarityQuality(before, after, 1).accepted).toBe(true);
  const normalized = evaluateStemClarityQuality(before, after, 1, { beforeGain: 1, afterGain: 1, measurementGain: 0.01 });
  expect(normalized.accepted).toBe(false);
  expect(normalized.reasons.join(' ')).toContain('DC');
});

it('suggests editable lead/backing roles without treating negated vocal filenames as a singer or breaking legacy pairs', () => {
  for (const name of ['0 Lead Vocals.wav', 'Main_Vocal.flac', 'メインボーカル.wav']) {
    expect(suggestStemRole(name)).toBe('vocal');
    expect(suggestStemVocalRole(name)).toBe('lead');
  }
  for (const name of ['1 Backing Vocals.wav', 'Background-Vocals.flac', 'Chorus.wav', 'Harmony.wav', 'ハモリ.wav']) {
    expect(suggestStemRole(name)).toBe('vocal');
    expect(suggestStemVocalRole(name)).toBe('backing');
  }
  for (const name of ['no_vocals.wav', 'without voice.flac', 'Lead Vocals Removed.wav', 'ボーカルなし.wav']) {
    expect(suggestStemRole(name)).toBe('instrumental');
    expect(suggestStemVocalRole(name)).toBeUndefined();
  }
  expect(suggestStemVocalRole('Vocals.wav')).toBeUndefined();
  const pair = fixture().slice(0, 2).map(track => ({ ...track.descriptor }));
  delete pair[0].vocalRole;
  pair[1].role = 'instrumental';
  expect(planStemMix(pair, 'vocal-instrumental').mode).toBe('vocal-instrumental');
  expect(() => planStemMix([{ ...pair[0], role: 'guitar', vocalRole: 'lead' }, pair[1]])).toThrow();
});

function cancellingStems(leadAmplitude: number) {
  // These labelled sources cancel in the untreated bus. Applying different safe
  // per-role cuts can expose energy, so per-source checks alone are insufficient.
  return [
    material('lead', 'vocal', 2, n => leadAmplitude * sine(n, 2300), 'lead'),
    material('guitar', 'guitar', 2, n => 0.2 * sine(n, 2600)),
    material('chorus', 'vocal', 2, n => -0.2 * sine(n, 2600), 'backing'),
  ];
}
it('weakens a real phase-sensitive mix once and falls back to the exact dry bus if the reduced candidate still raises RMS', async () => {
  const tracks = cancellingStems(0.03);
  const dry = await render(tracks, false);
  let retries = 0;
  const candidate = await render(tracks, true, undefined, (_fraction, text) => { if (text.includes('半分')) retries++; });
  expect(retries).toBe(1);
  expect(candidate.report.clarity?.status).toBe('reverted');
  expect(candidate.report.clarity?.evaluation?.strength).toBe(0.5);
  expect(candidate.report.clarity?.evaluation?.accepted).toBe(false);
  expect(candidate.report.clarity?.evaluation?.rmsChangeDb).toBeGreaterThan(0.15);
  expect(candidate.report.clarity?.tracks.every(track => track.presenceSeconds === 0 && track.lowSeconds === 0)).toBe(true);
  expect(candidate.channels).toEqual(dry.channels);
});

it('retains a phase-sensitive candidate only after the one reduced-strength retry passes the measured quality gate', async () => {
  let retries = 0;
  const candidate = await render(cancellingStems(0.07), true, undefined, (_fraction, text) => { if (text.includes('半分')) retries++; });
  expect(retries).toBe(1);
  expect(candidate.report.clarity?.status).toBe('applied');
  expect(candidate.report.clarity?.evaluation?.accepted).toBe(true);
  expect(candidate.report.clarity?.evaluation?.strength).toBe(0.5);
  expect(candidate.report.clarity?.evaluation?.rmsChangeDb).toBeLessThanOrEqual(0.15);
  expect(candidate.report.clarity?.tracks.find(track => track.id === 'guitar')?.maxPresenceReductionDb).toBe(1);
  expect(candidate.report.clarity?.tracks.find(track => track.id === 'chorus')?.maxPresenceReductionDb).toBe(0.5);
});
