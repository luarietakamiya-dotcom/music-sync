import { describe, expect, it } from 'vitest';
import { decodeWav } from '../../apps/web/src/decode';
import { readWavFileMetadata, streamWavChunks } from '../../apps/web/src/wav-stream';
import { tone, wav } from '../helpers/audio';

describe('bounded WAV file reader', () => {
  it('decodes consecutive chunks exactly like the existing whole-file parser', async () => {
    const audio = tone({ stereo: true, seconds: 1.6, amplitude: 0.32 });
    const buffer = wav(audio, 24);
    const file = new Blob([buffer]);
    const info = await readWavFileMetadata(file);
    expect(info.frames).toBe(audio.channels[0].length);
    const reference = decodeWav(buffer);
    const restored = [new Float32Array(info.frames), new Float32Array(info.frames)];
    let position = 0, count = 0;
    for await (const chunk of streamWavChunks(file, info)) {
      expect(chunk.channels[0].length).toBeLessThanOrEqual(65536);
      restored.forEach((channel, index) => channel.set(chunk.channels[index], position));
      position += chunk.channels[0].length; count++;
    }
    expect(count).toBe(2);
    expect(position).toBe(info.frames);
    expect(restored).toEqual(reference.channels);
  });

  it('rejects malformed metadata and cancels before decoding a chunk', async () => {
    await expect(readWavFileMetadata(new Blob(['not wav']))).rejects.toThrow();
    const file = new Blob([wav(tone({ seconds: 0.1 }), 16)]);
    const info = await readWavFileMetadata(file);
    const controller = new AbortController(); controller.abort();
    const chunks = streamWavChunks(file, info, controller.signal);
    await expect(chunks.next()).rejects.toThrow('cancelled');
  });
});
