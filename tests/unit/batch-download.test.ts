import { expect, it } from 'vitest';
import { unzipSync } from 'fflate';
import { encodeFloatWav } from '@music-sync/core';
import { batchDownloadName, batchTrackExportOptions, writeBatchArchive } from '../../apps/web/src/batch-download';
import { readWavFileMetadata, streamWavChunks } from '../../apps/web/src/wav-stream';

function song(name: string, frequency = 440) {
  return { name, file: new File([encodeFloatWav({ sampleRate: 16000,
    channels: [Float32Array.from({ length: 40000 }, (_, n) => .1 * Math.sin(2 * Math.PI * frequency * n / 16000))] })], name) };
}
it('streams ordered individually encoded PCM24 songs into a ZIP without changing source files', async () => {
  const tracks = [song('日本語.wav'), song('日本語.wav', 660)], chunks: Uint8Array<ArrayBuffer>[] = [];
  const originals = await Promise.all(tracks.map(async track => new Uint8Array(await track.file.arrayBuffer())));
  let active = 0, maximum = 0;
  await writeBatchArchive(tracks, { format: 'wav-24', dither: false }, { async write(chunk) {
    active++; maximum = Math.max(maximum, active); await Promise.resolve(); chunks.push(chunk.slice()); active--;
  } });
  expect(maximum).toBe(1); expect(Math.max(...chunks.map(chunk => chunk.length))).toBeLessThanOrEqual(65536 + 1024);
  const zip = new Uint8Array(await new Blob(chunks).arrayBuffer()), entries = unzipSync(zip);
  expect(Object.keys(entries)).toEqual(['01 日本語.wav', '02 日本語.wav']);
  for (const [index, bytes] of Object.values(entries).entries()) {
    const file = new File([bytes], 'saved.wav'), info = await readWavFileMetadata(file);
    expect(info.bits).toBe(24); expect(info.frames).toBe(40000); expect(info.sampleRate).toBe(16000);
    let samples = 0; for await (const block of streamWavChunks(file, info)) samples += block.channels[0].length;
    expect(samples).toBe(40000); expect(new Uint8Array(await tracks[index].file.arrayBuffer())).toEqual(originals[index]);
  }
});
it('derives empty common titles per song while keeping shared artist, album and cover settings', () => {
  const input = { format: 'mp3' as const, metadata: { title: '', artist: 'Artist', album: 'Album' } };
  const first = batchTrackExportOptions(input, 'First.flac'), second = batchTrackExportOptions(input, 'Second.wav');
  expect(first.metadata?.title).toBe('First'); expect(second.metadata?.title).toBe('Second');
  expect(first.metadata?.artist).toBe('Artist'); expect(first.metadata?.album).toBe('Album');
  expect(input.metadata.title).toBe('');
  expect(batchTrackExportOptions({ ...input, metadata: { ...input.metadata, title: 'Explicit' } }, 'Second.wav').metadata?.title).toBe('Explicit');
  expect(batchDownloadName('../bad:name.wav', 'mp3', 0)).toBe('01 _bad_name.mp3');
  expect(batchDownloadName('..', 'wav', 1)).toBe('02 MusicSync.wav');
});
it('rejects invalid counts and cancellation without finishing a downloadable ZIP', async () => {
  const track = song('source.wav'), abort = new AbortController(); let writes = 0;
  await expect(writeBatchArchive([], { format: 'wav-f32' }, { async write() { writes++; } })).rejects.toThrow();
  await expect(writeBatchArchive(Array.from({ length: 21 }, () => track), { format: 'wav-f32' }, { async write() { writes++; } })).rejects.toThrow();
  abort.abort();
  await expect(writeBatchArchive([track], { format: 'wav-f32' }, { signal: abort.signal, async write() { writes++; } })).rejects.toThrow();
  expect(writes).toBe(0);
  const halfway = new AbortController();
  await expect(writeBatchArchive([track, song('later.wav')], { format: 'wav-f32' }, {
    signal: halfway.signal, async write() { writes++; }, progress(fraction) { if (fraction > .1) halfway.abort(); },
  })).rejects.toThrow();
});
it('propagates a storage failure and never continues encoding later songs', async () => {
  let writes = 0; const progress: number[] = [];
  await expect(writeBatchArchive([song('first.wav'), song('second.wav')], { format: 'wav-16' }, {
    async write() { writes++; throw new Error('storage quota'); }, progress(value) { progress.push(value); },
  })).rejects.toThrow('storage quota');
  expect(writes).toBe(1); expect(progress.every(value => value < .5)).toBe(true);
});
it('enforces the remaining batch storage budget before writing an oversized ZIP block', async () => {
  let bytes = 0;
  await expect(writeBatchArchive([song('bounded.wav')], { format: 'wav-f32' }, {
    maximumBytes: 1024, async write(chunk) { bytes += chunk.length; },
  })).rejects.toThrow('保存容量');
  expect(bytes).toBeLessThanOrEqual(1024);
});
