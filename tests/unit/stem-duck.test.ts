import { expect, it } from 'vitest';
import type { AudioData } from '@music-sync/shared';
import { createStemDuck } from '../../packages/dsp/src/stem-duck';

const rate = 16000, windowFrames = 800;
function tone(hz: number, frames = rate * 2): AudioData {
  const left = Float32Array.from({ length: frames }, (_, i) => 0.12 * Math.sin(2 * Math.PI * hz * i / rate));
  return { sampleRate: rate, channels: [left, left.map(value => value * 0.5)] };
}
function render(input: AudioData, presence: Float32Array, low: Float32Array | undefined, step: number) {
  const processor = createStemDuck(input.sampleRate, input.channels.length, windowFrames, presence, low);
  const audio = { sampleRate: input.sampleRate, channels: input.channels.map(channel => channel.slice()) };
  for (let offset = 0; offset < audio.channels[0].length; offset += step)
    processor.processOwned({ sampleRate: audio.sampleRate, channels: audio.channels.map(channel => channel.subarray(offset, offset + step)) });
  return audio;
}
function power(samples: Float32Array) {
  return samples.subarray(rate / 4, samples.length - rate / 4).reduce((sum, value) => sum + value * value, 0);
}
function changeDb(hz: number, presence: Float32Array, low?: Float32Array) {
  const input = tone(hz), after = render(input, presence, low, 317);
  return 10 * Math.log10(power(after.channels[0]) / power(input.channels[0]));
}

it('retains identical filter and curve state across arbitrary chunks without writing source buffers', () => {
  const input = tone(2600), saved = input.channels.map(channel => channel.slice());
  for (let i = 0; i < input.channels[0].length; i++) {
    input.channels[0][i] += 0.03 * Math.sin(2 * Math.PI * 110 * i / rate);
    input.channels[1][i] += 0.015 * Math.sin(2 * Math.PI * 110 * i / rate);
  }
  const originals = input.channels.map(channel => channel.slice());
  const presence = Float32Array.from({ length: 40 }, (_, i) => i % 7 ? -1.5 : 0);
  const low = Float32Array.from({ length: 23 }, (_, i) => i % 3 ? -1 : 0);
  const whole = render(input, presence, low, 65536), chunks = render(input, presence, low, 311);
  expect(chunks.channels).toEqual(whole.channels);
  expect(input.channels).toEqual(originals);
  expect(saved[0]).not.toEqual(whole.channels[0]);
  for (let i = 0; i < whole.channels[0].length; i++) expect(whole.channels[1][i]).toBe(whole.channels[0][i] * 0.5);
});

it('attenuates the intended presence and bass bands while retaining the other end of the spectrum', () => {
  const presence = new Float32Array(40).fill(-2), low = new Float32Array(40).fill(-1.5);
  expect(changeDb(2600, presence)).toBeCloseTo(-2, 3);
  expect(changeDb(110, new Float32Array(0), low)).toBeCloseTo(-1.5, 3);
  expect(changeDb(110, presence)).toBeGreaterThan(-0.05);
  expect(changeDb(2600, new Float32Array(0), low)).toBeGreaterThan(-0.05);
  expect(changeDb(6000, presence)).toBeGreaterThan(-0.25);
});

it('keeps dry windows and unused tails sample-identical and avoids large boundary jumps', () => {
  const input = tone(2600), curve = new Float32Array(40);
  curve.fill(-2, 10, 15);
  const result = render(input, curve, undefined, 47);
  for (const [c, channel] of result.channels.entries()) {
    expect(channel.subarray(0, windowFrames * 10)).toEqual(input.channels[c].subarray(0, windowFrames * 10));
    expect(channel.subarray(windowFrames * 15)).toEqual(input.channels[c].subarray(windowFrames * 15));
    // A 2.6 kHz tone already changes quickly. Ramping must not introduce an additional abrupt residual.
    let previous = 0, maximumJump = 0;
    for (let i = 0; i < channel.length; i++) {
      const residual = channel[i] - input.channels[c][i];
      maximumJump = Math.max(maximumJump, Math.abs(residual - previous)); previous = residual;
    }
    expect(maximumJump).toBeLessThan(0.025);
  }
});

it('owns its curves and treats an all-zero plan as an exact bypass', () => {
  const input = tone(2600), zero = new Float32Array(40);
  expect(render(input, zero, zero, 167).channels).toEqual(input.channels);
  const curve = new Float32Array(40).fill(-2);
  const processor = createStemDuck(rate, 2, windowFrames, curve);
  curve.fill(0);
  const owned = { ...input, channels: input.channels.map(channel => channel.slice()) };
  processor.processOwned(owned);
  expect(10 * Math.log10(power(owned.channels[0]) / power(input.channels[0]))).toBeCloseTo(-2, 3);
});

it('validates plans and input while keeping silence and isolated transients finite at supported rate limits', () => {
  for (const curve of [Float32Array.of(-2.1), Float32Array.of(0.1), Float32Array.of(NaN)])
    expect(() => createStemDuck(rate, 1, windowFrames, curve)).toThrow();
  expect(() => createStemDuck(rate, 1, windowFrames, new Float32Array(0), Float32Array.of(-1.6))).toThrow();
  expect(() => createStemDuck(rate, 3, windowFrames, new Float32Array(0))).toThrow();
  for (const sampleRate of [8000, 192000]) {
    const frames = Math.round(sampleRate * 0.15), size = Math.round(sampleRate * 0.05);
    const samples = new Float32Array(frames); samples[0] = 1; samples[frames - 1] = -0.5;
    const processor = createStemDuck(sampleRate, 1, size, new Float32Array(3).fill(-2), new Float32Array(2).fill(-1.5));
    processor.processOwned({ sampleRate, channels: [samples] });
    expect(samples.every(Number.isFinite)).toBe(true);
    expect(samples.every(value => Math.abs(value) <= 1)).toBe(true);
    const silent = new Float32Array(size);
    createStemDuck(sampleRate, 1, size, Float32Array.of(-2)).processOwned({ sampleRate, channels: [silent] });
    expect(silent.every(value => value === 0)).toBe(true);
  }
  expect(() => createStemDuck(rate, 1, windowFrames, Float32Array.of(-1))
    .processOwned({ sampleRate: rate, channels: [Float32Array.of(NaN)] })).toThrow();
});
