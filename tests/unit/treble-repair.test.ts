import { describe, it, expect } from 'vitest';
import { TrebleRepair, type AudioData, type TrebleMode } from '@music-sync/core';

function source(noisy = true): AudioData {
  const rate = 48000;
  let seed = 7, prev = 0;
  const pcm = Float32Array.from({ length: rate * 3 }, (_, i) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const next = seed / 2 ** 32 - 0.5, noise = (next - prev) * 0.15;
    prev = next;
    const t = i / rate;
    return 0.12 * Math.sin(2 * Math.PI * 440 * t) + (noisy && ((t >= 0.2 && t < 0.28) || (t >= 0.65 && t < 2.6)) ? noise : 0);
  });
  return { sampleRate: rate, channels: [pcm] };
}
function trial(input: AudioData, mode: TrebleMode, block: number, damage = false) {
  const repair = new TrebleRepair(input.sampleRate, input.channels.length, mode);
  function feed(audio: AudioData, visit: (chunk: AudioData) => void) {
    for (let offset = 0; offset < audio.channels[0].length; offset += block)
      visit({ sampleRate: audio.sampleRate, channels: audio.channels.map(ch => ch.subarray(offset, offset + block)) });
  }
  feed(input, chunk => repair.analyze(chunk));
  const candidate = { ...input, channels: input.channels.map(ch => ch.slice()) };
  if (repair.plan()) {
    const render = repair.renderer();
    feed(candidate, chunk => {
      render(chunk);
      if (damage) chunk.channels[0].fill(0);
      repair.measure(chunk);
    });
    repair.evaluate();
  }
  return { report: repair.report, audio: repair.report.status === 'applied' ? candidate : input };
}
describe('adaptive treble restoration', () => {
  it('measures a sustained hiss reduction, protects brief bursts and does not depend on chunk boundaries', () => {
    const input = source(), original = input.channels[0].slice();
    const a = trial(input, 'auto', 65536), b = trial(input, 'auto', 371);
    expect(a.report.status).toBe('applied');
    expect(a.report.highReductionDb).toBeGreaterThan(0.2);
    expect(a.report.seconds).toBeLessThan(1.95);
    expect(a.audio.channels[0].subarray(0, 30000)).toEqual(original.subarray(0, 30000));
    expect(b.report).toEqual(a.report);
    expect(b.audio.channels[0]).toEqual(a.audio.channels[0]);
    expect(input.channels[0]).toEqual(original);
    expect(trial(input, 'strong', 4096).report.highReductionDb).toBeGreaterThan(trial(input, 'light', 4096).report.highReductionDb);
  });
  it('leaves tonal high notes, silence, disabled restoration and low sample rates untouched', () => {
    const clean = source(false);
    for (let i = 0; i < clean.channels[0].length; i++) clean.channels[0][i] += 0.15 * Math.sin(2 * Math.PI * 9000 * i / clean.sampleRate);
    expect(trial(clean, 'strong', 4096).audio).toBe(clean);
    expect(trial(source(), 'off', 4096).report.status).toBe('skipped');
    expect(trial({ ...clean, sampleRate: 16000 }, 'strong', 4096).report.status).toBe('skipped');
    clean.channels[0].fill(0);
    expect(trial(clean, 'auto', 4096).audio).toBe(clean);
  });
  it('keeps a decaying cymbal-like noise burst unchanged', () => {
    const input = source(false);
    let seed = 17, prev = 0;
    for (let i = 0; i < input.channels[0].length; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const next = seed / 2 ** 32 - 0.5;
      input.channels[0][i] += 0.4 * (next - prev) * Math.exp(-i / (0.16 * input.sampleRate));
      prev = next;
    }
    expect(trial(input, 'strong', 997).audio).toBe(input);
  });
  it('reverts a damaged candidate to the unmodified source', () => {
    const input = source();
    const result = trial(input, 'standard', 4096, true);
    expect(result.report.status).toBe('reverted');
    expect(result.audio).toBe(input);
  });
});
