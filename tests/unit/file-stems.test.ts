import { expect, it } from 'vitest';
import { mixStemsWithCorrection, mixStems, renderFileStems, type AudioData, type StemDescriptor } from '@music-sync/core';

const blockFrames = 257;
function stem(id: string, frames: number, channels: number, pan: number, muted = false) {
  const descriptor: StemDescriptor = { id, name: id, role: 'other', gainDb: 0, muted, pan, sampleRate: 16000, frames, channels };
  const audio: AudioData = { sampleRate: 16000, channels: Array.from({ length: channels }, (_, c) =>
    Float32Array.from({ length: frames }, (_, i) => 0.85 * Math.sin((c + 1) * i / 9))) };
  return { descriptor, audio, async *open() {
    for (let i = 0; i < frames; i += blockFrames)
      yield { sampleRate: 16000, channels: audio.channels.map(channel => channel.subarray(i, i + blockFrames)) };
  } };
}

it('sums unequal mono and stereo tracks with identical pan, mute, tail and global headroom across chunk boundaries', async () => {
  const tracks = [stem('drums', 32020, 2, -0.25), stem('bass', 28111, 1, 0.1), stem('keys', 40000, 1, 0, true)];
  const expected = mixStems(tracks);
  let offset = 0;
  const actual = await renderFileStems(tracks, { mode: 'stems', autoBalance: false, blockFrames, async write(block) {
    for (const [i, channel] of block.channels.entries()) expect(channel).toEqual(expected.audio.channels[i].subarray(offset, offset + channel.length));
    offset += block.channels[0].length;
  } });
  expect(offset).toBe(40000);
  expect(actual.report.attenuationDb).toBeLessThan(0);
  expect(actual.analysis.truePeakDbtp).toBeCloseTo(expected.analysis.truePeakDbtp!, 5);
  expect(actual.analysis.clippedSamples).toBe(0);
});
it('stops writing on cancellation', async () => {
  const abort = new AbortController();
  let writes = 0;
  await expect(renderFileStems([stem('one', 4000, 1, 0), stem('two', 4000, 1, 0)], {
    mode: 'stems', autoBalance: false, blockFrames, signal: abort.signal,
    async write() { writes++; abort.abort(); },
  })).rejects.toThrow();
  expect(writes).toBe(1);
});

it('applies only a measured instrumental dip and keeps its filter state across successive blocks', async () => {
  const tracks = [stem('voice', 32000, 1, 0), stem('instrumental', 32000, 1, 0)];
  for (const [i, track] of tracks.entries()) {
    track.descriptor.role = i === 0 ? 'vocal' : 'instrumental';
    const samples = track.audio.channels[0];
    for (let n = 0; n < samples.length; n++) samples[n] = (i === 0 ? 0.02 : 0.22) *
      [320, 910, 1850, 3300, 6100].reduce((sum, f) => sum + Math.sin(2 * Math.PI * n * f / 16000), 0) / 5;
  }
  const originals = tracks.map(track => track.audio.channels[0].slice());
  const expected = mixStemsWithCorrection(tracks);
  let offset = 0;
  const actual = await renderFileStems(tracks, { mode: 'vocal-instrumental', autoBalance: true, blockFrames, async write(block) {
    for (const [i, channel] of block.channels.entries()) expect(channel).toEqual(expected.audio.channels[i].subarray(offset, offset + channel.length));
    offset += block.channels[0].length;
  } });
  expect(actual.report.autoBalance?.status).toBe('adjusted');
  expect(actual.report.masking?.status).toBe('applied');
  expect(tracks.map(track => track.audio.channels[0])).toEqual(originals);
});
