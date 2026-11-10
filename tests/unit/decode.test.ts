import { describe, it, expect } from 'vitest';
import { decodeWav, readFlacMetadata } from '../../apps/web/src/decode';
import { tone, wav } from '../helpers/audio';

describe('Phase 1: bounded file decoding', () => {
  it.each([8, 16, 24, 32])('decodes PCM %i bit stereo at the original rate', bits => {
    const input = tone({ sampleRate: 44100, seconds: 0.02, stereo: true });
    const output = decodeWav(wav(input, bits));
    expect(output.sampleRate).toBe(44100); expect(output.channels).toHaveLength(2);
    for (let i = 0; i < input.channels[0].length; i++) expect(Math.abs(input.channels[0][i] - output.channels[0][i])).toBeLessThanOrEqual(1 / 2 ** (bits - 1));
  });
  it('decodes Float32 without normalizing or clipping', () => {
    const original = { sampleRate: 48000, channels: [new Float32Array([-1.5, 0, 1.5])] };
    expect(decodeWav(wav(original, 32, true)).channels[0]).toEqual(original.channels[0]);
  });
  it('rejects corrupt chunks, unsupported codecs and float NaNs', () => {
    expect(() => decodeWav(new ArrayBuffer(12))).toThrow();
    const badSize = wav(tone({ seconds: 0.01 })); new DataView(badSize).setUint32(40, 0xffffffff, true);
    expect(() => decodeWav(badSize)).toThrow(/チャンク/);
    const codec = wav(tone({ seconds: 0.01 })); new DataView(codec).setUint16(20, 6, true);
    expect(() => decodeWav(codec)).toThrow(/PCM/);
    const malformed = wav({ sampleRate: 48000, channels: [new Float32Array([NaN])] }, 32, true);
    expect(() => decodeWav(malformed)).toThrow(/サンプル/);
  });
  it('rejects multichannel audio rather than silently discarding channels', () => {
    const audio = tone({ seconds: 0.01 });
    expect(() => decodeWav(wav({ ...audio, channels: [audio.channels[0], audio.channels[0], audio.channels[0]] }))).toThrow(/ステレオ/);
  });
  it('preflights FLAC stream dimensions before invoking the native decoder', () => {
    const b = new ArrayBuffer(42), v = new DataView(b);
    [102, 76, 97, 67, 128, 0, 0, 34].forEach((n, i) => v.setUint8(i, n));
    const packed = (48000n << 44n) | (1n << 41n) | (15n << 36n) | 48000n;
    v.setBigUint64(18, packed);
    expect(readFlacMetadata(b)).toEqual({ sampleRate: 48000, channels: 2, frames: 48000 });
    v.setBigUint64(18, (48000n << 44n) | 0xfffffffffn);
    expect(() => readFlacMetadata(b)).toThrow(/10分/);
    expect(() => readFlacMetadata(new ArrayBuffer(0))).toThrow();
  });
});
