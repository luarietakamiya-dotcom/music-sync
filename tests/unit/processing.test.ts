import { describe, it, expect } from 'vitest';
import { processAudio, defaultProcessingChain, encodeFloatWav, analyzeAudio, type ProcessingChain } from '@music-sync/core';
import { peakingCoefficients, createBiquad } from '@music-sync/dsp';
import { decodeWav } from '../../apps/web/src/decode';
import { tone } from '../helpers/audio';

const rms = (a: Float32Array) => Math.sqrt(a.reduce((s, x) => s + x * x, 0) / a.length);
const peak = (a: Float32Array) => a.reduce((s, x) => Math.max(s, Math.abs(x)), 0);
function dry(): ProcessingChain { const c = defaultProcessingChain(); c.limiter.enabled = false; return c; }

describe('Phase 3 processing and export', () => {
  it('bypass and neutral chains are bit-exact independent copies; source and settings are immutable', () => {
    const input = tone({ stereo: true }); const original = input.channels.map(c => c.slice());
    for (const bypass of [false, true]) {
      const c = dry(); c.bypass = bypass;
      if (bypass) { c.gainDb = 12; c.eq.enabled = true; c.eq.gainDb = 12; c.limiter.enabled = true; }
      const json = JSON.stringify(c), output = processAudio(input, c);
      expect(output.audio.channels).toEqual(original);
      expect(output.audio.channels[0]).not.toBe(input.channels[0]);
      output.audio.channels[0][0] = 1;
      expect(input.channels).toEqual(original); expect(JSON.stringify(c)).toBe(json);
    }
  });
  it('gain is exact within float precision and export preserves values above full scale', () => {
    const input = tone({ amplitude: 0.8 }), c = dry(); c.gainDb = 6;
    const output = processAudio(input, c).audio;
    expect(20 * Math.log10(rms(output.channels[0]) / rms(input.channels[0]))).toBeCloseTo(6, 5);
    expect(peak(output.channels[0])).toBeGreaterThan(1);
    expect(decodeWav(encodeFloatWav(output))).toEqual(output);
  });
  it.each([8000, 44100, 48000, 96000, 192000])('peaking EQ reaches requested center gain at %i Hz', sampleRate => {
    const input = tone({ sampleRate, frequency: 1000, seconds: 0.1 });
    const c = dry(); c.eq = { enabled: true, frequencyHz: 1000, gainDb: 6, q: 1 };
    const output = processAudio(input, c).audio;
    const start = Math.round(sampleRate * 0.03);
    expect(20 * Math.log10(rms(output.channels[0].slice(start)) / rms(input.channels[0].slice(start)))).toBeCloseTo(6, 2);
  });
  it('EQ impulse response has unit DC gain and finite decay at parameter extremes', () => {
    for (const sr of [8000, 192000]) for (const frequency of [20, Math.min(20000, sr * 0.45)]) for (const q of [0.1, 10]) for (const db of [-12, 12]) {
      const filter = createBiquad(peakingCoefficients(sr, frequency, db, q));
      let sum = 0, tail = 0, finite = true;
      for (let i = 0; i < sr * 4; i++) { const y = filter(i === 0 ? 1 : 0); finite &&= Number.isFinite(y); sum += y; tail = y; }
      expect(finite).toBe(true);
      expect(sum).toBeCloseTo(1, 3); expect(Math.abs(tail)).toBeLessThan(0.00001);
    }
  });
  it('linked limiting preserves stereo ratios, timing and estimated peak ceiling', () => {
    const input = tone({ amplitude: 0.8, seconds: 0.15, frequency: 12000, phase: Math.PI / 4 });
    input.channels[0][1000] = 3;
    const stereo = { ...input, channels: [input.channels[0], input.channels[0].map(x => x * -0.25)] };
    const c = defaultProcessingChain(); c.gainDb = 6;
    const output = processAudio(stereo, c);
    expect(output.audio.channels[0].length).toBe(stereo.channels[0].length);
    expect(output.maxReductionDb).toBeGreaterThan(6);
    const result = analyzeAudio(output.audio);
    expect(result.truePeakDbtp!).toBeLessThanOrEqual(-1 + 0.00001);
    output.audio.channels[0].forEach((x, i) => expect(output.audio.channels[1][i]).toBeCloseTo(x * -0.25, 6));
    const impulse = { sampleRate: 48000, channels: [new Float32Array(4800)] }; impulse.channels[0][1234] = 3;
    const rendered = processAudio(impulse, c).audio.channels[0];
    expect(Array.from(rendered).flatMap((x, i) => x ? [i] : [])).toEqual([1234]);
  });
  it('silence, one-sample files and independent repeated processing are deterministic', () => {
    for (const input of [tone({ amplitude: 0 }), { sampleRate: 8000, channels: [Float32Array.of(2)] }]) {
      const a = processAudio(input, defaultProcessingChain()), b = processAudio(input, defaultProcessingChain());
      expect(a).toEqual(b); expect(peak(a.audio.channels[0])).toBeLessThanOrEqual(10 ** (-1 / 20) + 1e-6);
    }
  });
  it('rejects malformed/non-finite/out-of-range settings and non-finite samples', () => {
    const input = tone({ seconds: 0.01 });
    for (const value of [NaN, Infinity, -25, 13]) { const c = dry(); c.gainDb = value; expect(() => processAudio(input, c)).toThrow(); }
    const c = dry(); c.eq.frequencyHz = 22000; expect(() => processAudio(input, c)).toThrow();
    c.eq.frequencyHz = 1000; c.eq.q = 0; expect(() => processAudio(input, c)).toThrow();
    expect(() => processAudio(input, null as unknown as ProcessingChain)).toThrow();
    input.channels[0][0] = NaN; expect(() => encodeFloatWav(input)).toThrow();
  });
  it('writes correct Float32 header, interleaving, fact frames and original rate', () => {
    const audio = { sampleRate: 44100, channels: [Float32Array.of(-1.5, 0, 0.3), Float32Array.of(0.5, -0.75, 2)] };
    const buffer = encodeFloatWav(audio), v = new DataView(buffer);
    expect(buffer.byteLength).toBe(80); expect(v.getUint32(4, true)).toBe(72);
    expect(v.getUint16(20, true)).toBe(3); expect(v.getUint32(24, true)).toBe(44100);
    expect(v.getUint32(44, true)).toBe(3); expect(v.getUint32(52, true)).toBe(24);
    expect([v.getFloat32(56, true), v.getFloat32(60, true), v.getFloat32(64, true)]).toEqual([-1.5, 0.5, 0]);
    expect(decodeWav(buffer)).toEqual(audio);
  });
});
