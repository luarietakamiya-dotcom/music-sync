import { expect, it } from 'vitest';
import type { AudioData } from '@music-sync/shared';
import { createStemGain } from '../../packages/dsp/src/stem-gain';

const rate = 16000, windowFrames = 800;
function audio(frames = rate * 2): AudioData {
  const left = Float32Array.from({ length: frames }, (_, i) => 0.12 * Math.sin(2 * Math.PI * 710 * i / rate));
  return { sampleRate: rate, channels: [left, left.map(value => value * 0.5)] };
}
function render(input: AudioData, curve: Float32Array, step: number) {
  const result = { ...input, channels: input.channels.map(channel => channel.slice()) };
  const processor = createStemGain(input.sampleRate, input.channels.length, windowFrames, curve);
  for (let offset = 0; offset < result.channels[0].length; offset += step)
    processor.processOwned({ sampleRate: result.sampleRate, channels: result.channels.map(channel => channel.subarray(offset, offset + step)) });
  return result;
}

it('keeps zero windows, gaps and unused tails exactly dry and all-zero plans as an exact bypass', () => {
  const input = audio(), curve = new Float32Array(30); curve.fill(1.5, 5, 15); curve.fill(0.8, 20, 23);
  const result = render(input, curve, 317);
  expect(render(input, new Float32Array(0), 197).channels).toEqual(input.channels);
  expect(render(input, new Float32Array(40), 311).channels).toEqual(input.channels);
  for (const [c, channel] of result.channels.entries()) {
    for (const [start, end] of [[0, 5], [15, 20], [23, 40]])
      expect(channel.subarray(start * windowFrames, end * windowFrames)).toEqual(input.channels[c].subarray(start * windowFrames, end * windowFrames));
  }
});

it('reaches the bounded target without repeated 50 ms gain dips and fades smoothly inside the positive run', () => {
  const curve = new Float32Array(40); curve.fill(1.5, 10, 30);
  const result = render({ sampleRate: rate, channels: [new Float32Array(rate * 2).fill(0.1)] }, curve, 317).channels[0];
  const target = Math.fround(0.1 * 10 ** (1.5 / 20));
  for (let n = 13 * windowFrames; n < 27 * windowFrames; n++) expect(result[n]).toBeCloseTo(target, 7);
  expect(result[10 * windowFrames]).toBeCloseTo(0.1, 7);
  expect(result[30 * windowFrames - 1]).toBeCloseTo(0.1, 7);
  for (let n = 10 * windowFrames + 1; n < 12 * windowFrames; n++) expect(result[n]).toBeGreaterThanOrEqual(result[n - 1]);
  let jump = 0;
  for (let n = 1; n < result.length; n++) jump = Math.max(jump, Math.abs(result[n] - result[n - 1]));
  expect(jump).toBeLessThan(0.00002);
});

it('interpolates varying target gains continuously, preserves stereo ratios and is sample-identical across arbitrary chunks', () => {
  const input = audio(), original = input.channels.map(channel => channel.slice());
  const curve = Float32Array.from({ length: 40 }, (_, i) => i >= 5 && i < 34 ? 0.2 + (i % 4) * 0.4 : 0);
  const whole = render(input, curve, 65536), chunks = render(input, curve, 137);
  expect(chunks.channels).toEqual(whole.channels);
  expect(input.channels).toEqual(original);
  for (let n = 0; n < whole.channels[0].length; n++) expect(whole.channels[1][n]).toBe(whole.channels[0][n] * 0.5);
  const constant = render({ sampleRate: rate, channels: [new Float32Array(rate * 2).fill(0.1)] }, curve, 23).channels[0];
  let jump = 0;
  for (let n = 1; n < constant.length; n++) jump = Math.max(jump, Math.abs(constant[n] - constant[n - 1]));
  expect(jump).toBeLessThan(0.00003);
});

it('owns its curve so later caller changes cannot alter an in-flight pass', () => {
  const curve = new Float32Array(40).fill(1.5), processor = createStemGain(rate, 1, windowFrames, curve);
  curve.fill(0);
  const samples = new Float32Array(rate * 2).fill(0.1);
  processor.processOwned({ sampleRate: rate, channels: [samples] });
  expect(processor.applied).toBe(true);
  expect(samples[rate]).toBeCloseTo(0.1 * 10 ** (1.5 / 20), 7);
  expect(createStemGain(rate, 1, windowFrames, new Float32Array(3)).applied).toBe(false);
});

it('validates plans and complete input chunks before mutation and stays finite at supported rate limits', () => {
  for (const curve of [Float32Array.of(-0.1), Float32Array.of(1.6), Float32Array.of(NaN), Float32Array.of(Infinity)])
    expect(() => createStemGain(rate, 1, windowFrames, curve)).toThrow();
  expect(() => createStemGain(rate, 3, windowFrames, new Float32Array(0))).toThrow();
  expect(() => createStemGain(7999, 1, windowFrames, new Float32Array(0))).toThrow();
  expect(() => createStemGain(rate, 1, 0, new Float32Array(0))).toThrow();
  const samples = Float32Array.of(0.1, 0.2, NaN), original = samples.slice();
  expect(() => createStemGain(rate, 1, windowFrames, Float32Array.of(1.5)).processOwned({ sampleRate: rate, channels: [samples] })).toThrow();
  expect(samples).toEqual(original);
  expect(() => createStemGain(rate, 1, windowFrames, Float32Array.of(1.5)).processOwned({ sampleRate: rate, channels: [Float32Array.of(33)] })).toThrow();
  for (const sampleRate of [8000, 192000]) {
    const size = Math.round(sampleRate * 0.05), channel = new Float32Array(size * 5); channel[size * 2] = 1;
    createStemGain(sampleRate, 1, size, new Float32Array(5).fill(1.5)).processOwned({ sampleRate, channels: [channel] });
    expect(channel.every(Number.isFinite)).toBe(true);
    expect(Math.max(...channel)).toBeLessThanOrEqual(10 ** (1.5 / 20));
  }
});
