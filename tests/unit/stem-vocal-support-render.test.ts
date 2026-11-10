import { expect, it } from 'vitest';
import { renderFileStems, type AudioData, type StemDescriptor } from '@music-sync/core';

const rate = 16000, blockFrames = 257, duration = 4;
const sine = (n: number, hz: number) => Math.sin(2 * Math.PI * hz * n / rate);
function track(id: string, role: StemDescriptor['role'], sample: (n: number) => number, vocalRole?: StemDescriptor['vocalRole']) {
  const audio: AudioData = { sampleRate: rate, channels: [Float32Array.from({ length: rate * duration }, (_, n) => sample(n))] };
  const descriptor: StemDescriptor = { id, name: id + '.wav', role, vocalRole, gainDb: 0, pan: 0, muted: false,
    sampleRate: rate, channels: 1, frames: audio.channels[0].length };
  return { audio, descriptor, async *open() {
    for (let n = 0; n < descriptor.frames; n += blockFrames)
      yield { sampleRate: rate, channels: audio.channels.map(channel => channel.subarray(n, n + blockFrames)) };
  } };
}
function fixture() {
  return [
    track('lead', 'vocal', n => n < rate * 0.5 || n >= rate * 3.5 ? 0 :
      (n >= rate * 1.5 && n < rate * 1.8 ? 0.5 : 1) * (0.07 * sine(n, 700) + 0.025 * sine(n, 2300)), 'lead'),
    track('guitar', 'guitar', n => 0.18 * sine(n, 2600) + 0.04 * sine(n, 330)),
    track('bass', 'bass', n => 0.05 * sine(n, 100)),
  ];
}
async function render(tracks: ReturnType<typeof fixture>, vocalSupport: boolean) {
  const channels = [new Float32Array(rate * duration), new Float32Array(rate * duration)];
  let offset = 0;
  const result = await renderFileStems(tracks, { mode: 'stems', autoBalance: false, clarity: true, vocalSupport, blockFrames,
    async write(block) {
      block.channels.forEach((channel, c) => channels[c].set(channel, offset));
      offset += block.channels[0].length;
    } });
  expect(offset).toBe(rate * duration);
  return { ...result, channels };
}
function maxDifference(before: Awaited<ReturnType<typeof render>>, after: Awaited<ReturnType<typeof render>>, start: number, end: number) {
  const aGain = 10 ** (before.report.attenuationDb / 20), bGain = 10 ** (after.report.attenuationDb / 20);
  let maximum = 0;
  for (let n = Math.round(start * rate); n < Math.round(end * rate); n++)
    maximum = Math.max(maximum, Math.abs(before.channels[0][n] / aGain - after.channels[0][n] / bGain));
  return maximum;
}

it('supports only a short masked vocal dip and preserves original sources, healthy singing and instrumental gaps', async () => {
  const tracks = fixture(), originals = tracks.map(source => source.audio.channels[0].slice());
  const descriptors = structuredClone(tracks.map(source => source.descriptor));
  const without = await render(tracks, false), withSupport = await render(tracks, true);
  const lead = withSupport.report.clarity!.tracks.find(item => item.id === 'lead')!;
  expect(withSupport.report.clarity?.status).toBe('applied');
  expect(withSupport.report.clarity?.evaluation?.accepted).toBe(true);
  expect(lead.supportSeconds).toBeGreaterThanOrEqual(0.15);
  expect(lead.supportSeconds).toBeLessThanOrEqual(0.4);
  expect(lead.maxSupportGainDb).toBeGreaterThan(0);
  expect(lead.maxSupportGainDb).toBeLessThanOrEqual(1.5);
  expect(withSupport.report.clarity!.tracks.filter(item => item.id !== 'lead').every(item => !item.supportSeconds)).toBe(true);
  expect(maxDifference(without, withSupport, 1.6, 1.7)).toBeGreaterThan(0.001);
  expect(maxDifference(without, withSupport, 0.1, 0.4)).toBeLessThan(1e-7);
  expect(maxDifference(without, withSupport, 0.8, 1.2)).toBeLessThan(1e-7);
  expect(maxDifference(without, withSupport, 2.5, 3.1)).toBeLessThan(1e-7);
  expect(maxDifference(without, withSupport, 3.6, 3.9)).toBeLessThan(1e-7);
  expect(tracks.map(source => source.descriptor)).toEqual(descriptors);
  for (const [i, source] of tracks.entries()) expect(source.audio.channels[0].every((value, n) => value === originals[i][n])).toBe(true);
});

it('can disable the additional gain while retaining the previous accompaniment correction', async () => {
  const result = await render(fixture(), false);
  expect(result.report.clarity?.status).toBe('applied');
  expect(result.report.clarity?.evaluation?.accepted).toBe(true);
  expect(result.report.clarity!.tracks.every(item => item.supportSeconds === undefined && item.maxSupportGainDb === undefined)).toBe(true);
  expect(result.report.clarity!.tracks.find(item => item.id === 'guitar')!.presenceSeconds).toBeGreaterThan(0);
  expect(result.report.clarity!.explanations.join(' ')).not.toContain('控えめに支えました');
});

it('explains why an even vocal phrase receives no extra gain', async () => {
  const tracks = fixture();
  tracks[0] = track('lead','vocal',n=>n<rate*.5||n>=rate*3.5 ? 0 :
    .07*sine(n,700)+.025*sine(n,2300),'lead');
  const result=await render(tracks,true);
  expect(result.report.clarity!.tracks[0].supportSeconds).toBeUndefined();
  expect(result.report.warnings.join(' ')).toContain('歌声を追加で持ち上げる必要を確認できず');
});

it('measures the supported candidate together with its final whole-song peak protection', async () => {
  const tracks = fixture();
  tracks[1] = track('guitar', 'guitar', n => 0.7 * sine(n, 2600));
  tracks[2] = track('bass', 'bass', n => 0.65 * sine(n, 100));
  tracks.forEach(source => { source.descriptor.gainDb = 6; });
  const result = await render(tracks, true);
  expect(result.report.clarity?.status).toBe('applied');
  expect(result.report.clarity?.evaluation?.accepted).toBe(true);
  expect(result.report.clarity!.tracks[0].supportSeconds).toBeGreaterThan(0);
  expect(result.report.attenuationDb).toBeLessThan(0);
  expect(result.analysis.truePeakDbtp).toBeLessThanOrEqual(-3);
  expect(result.analysis.clippedSamples).toBe(0);
  expect(result.report.tracks.every(source => source.analysis.clippedSamples === 0)).toBe(true);
});

it('does not support ambiguous, muted or clipped lead sources and matches the correction-disabled PCM', async () => {
  for (const kind of ['ambiguous', 'muted', 'clipped'] as const) {
    const tracks = fixture();
    if (kind === 'ambiguous') { tracks[1].descriptor.role = 'vocal'; tracks[1].descriptor.vocalRole = 'lead'; }
    if (kind === 'muted') tracks[0].descriptor.muted = true;
    if (kind === 'clipped') tracks[0].audio.channels[0][rate] = 1.1;
    const without = await render(tracks, false), withSupport = await render(tracks, true);
    expect(withSupport.report.clarity?.status).toBe('skipped');
    expect(withSupport.report.clarity!.tracks.every(item => !item.supportSeconds)).toBe(true);
    expect(withSupport.channels).toEqual(without.channels);
  }
});

it('stops candidate evaluation before writing a cancelled supported mix', async () => {
  const controller = new AbortController();
  let writes = 0;
  await expect(renderFileStems(fixture(), { mode: 'stems', autoBalance: false, clarity: true, vocalSupport: true,
    blockFrames, signal: controller.signal, progress(_fraction, text) { if (text.includes('検証しています')) controller.abort(); },
    async write() { writes++; } })).rejects.toThrow();
  expect(writes).toBe(0);
});
