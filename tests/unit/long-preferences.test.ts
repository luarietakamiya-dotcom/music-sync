import { expect, it } from 'vitest';
import { analyzeAudio, DEFAULT_FINISH_CONTROLS, type AudioData, type FinishControls } from '@music-sync/core';
import { createLongPreferences } from '../../packages/core/src/long-preferences';

const controls = (values: Partial<FinishControls>): FinishControls => ({ ...DEFAULT_FINISH_CONTROLS, ...values });
function source(rate = 16000): AudioData {
  const channels = [new Float32Array(rate * 2), new Float32Array(rate * 2)];
  for (let i = 0; i < channels[0].length; i++) {
    const t = i / rate, envelope = i % Math.round(rate * 0.3) < rate * 0.025 ? 1 : 0.22;
    const mid = envelope * (0.18 * Math.sin(2 * Math.PI * 95 * t) + 0.07 * Math.sin(2 * Math.PI * 2600 * t));
    const side = 0.013 * Math.sin(2 * Math.PI * 1500 * t);
    channels[0][i] = mid + side; channels[1][i] = mid - side;
  }
  return { sampleRate: rate, channels };
}
function render(input: AudioData, selection: FinishControls, step: number, strength = 1) {
  const processor = createLongPreferences(analyzeAudio(input), selection, strength);
  const audio = { sampleRate: input.sampleRate, channels: input.channels.map(ch => ch.slice()) };
  for (let i = 0; i < audio.channels[0].length; i += step)
    processor.processOwned({ sampleRate: audio.sampleRate, channels: audio.channels.map(ch => ch.subarray(i, i + step)) });
  return { audio, processor };
}
function energy(samples: Float32Array) { return samples.reduce((sum, value) => sum + value * value, 0); }

it('keeps filtering, spectral adaptation and dynamics identical across arbitrary chunk boundaries', () => {
  const input = source(), original = input.channels.map(ch => ch.slice());
  const selection = controls({ vocal: 3, bass: 2, clarity: 3, warmth: 1, punch: 2, width: 2, density: 2 });
  const whole = render(input, selection, 65536), chunks = render(input, selection, 317);
  expect(chunks.audio.channels).toEqual(whole.audio.channels);
  expect(input.channels).toEqual(original);
  expect(whole.processor.applied).toBe(true);
  expect(whole.processor.density).toBe(2);
  expect(whole.processor.explanations.length).toBeGreaterThan(4);
});
it('leaves neutral processing sample-identical without choosing any stages', () => {
  const input = source();
  const result = render(input, controls({}), 107);
  expect(result.audio.channels).toEqual(input.channels);
  expect(result.processor.applied).toBe(false);
  expect(result.processor.explanations).toEqual([]);
  expect(result.processor.appliedControls).toEqual(DEFAULT_FINISH_CONTROLS);
});
it('produces measurable bass and vocal-band changes while keeping the source arrays intact', () => {
  for (const [hz, selection] of [[95, controls({ bass: 3 })], [2600, controls({ vocal: 3 })]] as const) {
    const input = { sampleRate: 16000, channels: [Float32Array.from({ length: 32000 }, (_, i) => 0.1 * Math.sin(2 * Math.PI * hz * i / 16000))] };
    const saved = input.channels[0].slice(), normal = render(input, selection, 256), reduced = render(input, selection, 256, 0.5);
    const liftDb = 10 * Math.log10(energy(normal.audio.channels[0]) / energy(saved));
    expect(liftDb).toBeGreaterThan(0.2);
    expect(liftDb).toBeLessThan(2.1);
    expect(energy(normal.audio.channels[0])).toBeGreaterThan(energy(reduced.audio.channels[0]));
    expect(input.channels[0]).toEqual(saved);
  }
});
it('bounds punch and density gains and avoids additional compression in a dense source', () => {
  const input = source(), processed = render(input, controls({ density: 3, punch: 3 }), 997);
  let minGain = Infinity, maxGain = 0, finite = true;
  for (const [c, channel] of processed.audio.channels.entries()) for (let i = 0; i < channel.length; i++) {
    finite &&= Number.isFinite(channel[i]);
    if (Math.abs(input.channels[c][i]) < 1e-7) continue;
    const gain = channel[i] / input.channels[c][i];
    minGain = Math.min(minGain, gain); maxGain = Math.max(maxGain, gain);
  }
  expect(finite).toBe(true);
  expect(minGain).toBeGreaterThanOrEqual(10 ** (-1.2 / 20) - 1e-6);
  expect(maxGain).toBeLessThanOrEqual(10 ** (1 / 20) + 1e-6);
  const dense = { sampleRate: 8000, channels: [Float32Array.from({ length: 8000 }, (_, i) => i % 2 ? 0.1 : -0.1)] };
  const skipped = render(dense, controls({ density: 3, punch: 3 }), 619);
  expect(skipped.processor.density).toBe(0);
  expect(skipped.processor.appliedControls.density).toBe(0);
  expect(skipped.processor.appliedControls.punch).toBe(0);
  expect(skipped.audio.channels).toEqual(dense.channels);
  expect(skipped.processor.skipped).toHaveLength(2);
});
it('widens only stable non-mono audio and remains finite at the minimum sample rate', () => {
  const input = source(8000), result = render(input, controls({ width: 3 }), 251);
  const before = analyzeAudio(input), after = analyzeAudio(result.audio);
  expect(after.sideEnergyPercent!).toBeGreaterThan(before.sideEnergyPercent!);
  expect(after.sideEnergyPercent!).toBeLessThan(before.sideEnergyPercent! + 1.5);
  const mono = { sampleRate: 8000, channels: [input.channels[0]] };
  const skipped = render(mono, controls({ width: 3 }), 317);
  expect(skipped.audio.channels).toEqual(mono.channels);
  expect(skipped.processor.appliedControls.width).toBe(0);
  const lowRate = render(input, controls({ vocal: 3, clarity: 3, bass: 3, warmth: 3 }), 61);
  expect(lowRate.audio.channels.every(channel => channel.every(Number.isFinite))).toBe(true);
});
