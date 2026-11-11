import { describe, expect, it } from 'vitest';
import { createMixtureMasks, type SeparationMaskShape } from '../../packages/dsp/src/separation-masks';

const shape = (overrides: Partial<SeparationMaskShape> = {}): SeparationMaskShape => ({ channels: 2, sources: 1, bins: 1, frames: 1, ...overrides });
function close(actual: number, expected: number) {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(Math.max(1e-7, Math.abs(expected) * 1e-6));
}
function reconstruct(output: Float32Array, length: number, sources: number) {
  return Float64Array.from({ length }, (_, index) => {
    let value = 0; for (let source = 0; source <= sources; source++) value += output[source * length + index]; return value;
  });
}

describe('conservative learned separation masks', () => {
  it('uses one real mask for both original channels and keeps their pan and complex phase', () => {
    const mixture = new Float32Array([3, 4, -6, 8]);
    // The model puts this estimate on the left and rotates its phase. Neither
    // change is copied to the output; only its linked magnitude sets the mask.
    const estimate = new Float32Array([0, 5, 0, 0]);
    const output = createMixtureMasks(mixture, estimate, shape()), weight = 5 / Math.sqrt(125);
    for (let component = 0; component < 4; component++) {
      close(output[component], mixture[component] * weight);
      close(output[4 + component], mixture[component] * (1 - weight));
    }
    expect(output[2]).toBeLessThan(0); expect(output[3]).toBeGreaterThan(0);
    close(output[2], -2 * output[0]); close(output[3], 2 * output[1]);
    // Each complex component is rounded to Float32 independently; bound the
    // phase cross-product by that precision at this signal's actual magnitude.
    const cross = output[1] * mixture[0] - output[0] * mixture[1];
    const scale = Math.abs(output[1] * mixture[0]) + Math.abs(output[0] * mixture[1]);
    expect(Math.abs(cross)).toBeLessThanOrEqual(scale * 2 ** -23);
    const joined = reconstruct(output, 4, 1); joined.forEach((value, index) => close(value, mixture[index]));
  });

  it.each([1, 2])('reconstructs every bin / frame of five overlapping estimates with %s channel(s)', channels => {
    const dimensions = shape({ channels, sources: 5, bins: 13, frames: 17 }), length = channels * 2 * 13 * 17;
    let seed = 0x739fd129;
    const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 0x100000000 * 4 - 2; };
    const mixture = Float32Array.from({ length }, random), estimates = Float32Array.from({ length: length * 5 }, random);
    const output = createMixtureMasks(mixture, estimates, dimensions), joined = reconstruct(output, length, 5);
    expect(output.length).toBe(length * 6);
    joined.forEach((value, index) => close(value, mixture[index]));
    for (let source = 0; source < 6; source++) for (let index = 0; index < length; index++) {
      const value = output[source * length + index];
      expect(Number.isFinite(value)).toBe(true); expect(Math.abs(value)).toBeLessThanOrEqual(Math.abs(mixture[index]));
      expect(value === 0 || Math.sign(value) === Math.sign(mixture[index])).toBe(true);
    }
  });

  it('shares a duplicated full-mixture estimate without doubling it or leaving a negative remainder', () => {
    const mixture = new Float32Array([1, -.5, .25, -.125]), estimates = new Float32Array([...mixture, ...mixture]);
    const output = createMixtureMasks(mixture, estimates, shape({ sources: 2 }));
    for (let source = 0; source < 2; source++) for (let index = 0; index < 4; index++) close(output[source * 4 + index], mixture[index] / 2);
    expect(output.subarray(8).every(value => value === 0)).toBe(true);
    reconstruct(output, 4, 2).forEach((value, index) => close(value, mixture[index]));
  });

  it('keeps bins with no learned coverage entirely in the unassigned remainder', () => {
    // Each plane is [bin 0 time 0, bin 0 time 1, bin 1 time 0, bin 1 time 1].
    const mixture = new Float32Array([2, 4, 6, 8, 0, 0, 0, 0]);
    const estimates = new Float32Array([1, 0, 0, 4, 0, 0, 0, 0]);
    const output = createMixtureMasks(mixture, estimates, shape({ channels: 1, bins: 2, frames: 2 }));
    expect(output.subarray(0, 4)).toEqual(new Float32Array([1, 0, 0, 4]));
    expect(output.subarray(8, 12)).toEqual(new Float32Array([1, 4, 6, 4]));
    expect(output.subarray(4, 8).every(value => value === 0)).toBe(true);
    reconstruct(output, 8, 1).forEach((value, index) => close(value, mixture[index]));
  });

  it('returns the whole original in the remainder when estimates are zero', () => {
    const mixture = new Float32Array([.13, -.21, 0, -0]);
    const output = createMixtureMasks(mixture, new Float32Array(20), shape({ sources: 5 }));
    expect(output.subarray(0, 20).every(value => value === 0)).toBe(true);
    expect(new Uint8Array(output.buffer, 20 * 4)).toEqual(new Uint8Array(mixture.buffer));
  });

  it.each([0, 1])('does not manufacture audio from silence even when estimated magnitude is %s', value => {
    const output = createMixtureMasks(new Float32Array(4), new Float32Array(20).fill(value), shape({ sources: 5 }));
    expect(output.length).toBe(24); expect(output.every(sample => sample === 0 && Number.isFinite(sample))).toBe(true);
  });

  it('handles the largest finite Float32 magnitudes without power-sum overflow or clipping', () => {
    const max = 3.4028234663852886e38, mixture = new Float32Array([max, -max, max, -max]);
    const estimates = new Float32Array([...mixture, ...mixture]);
    const output = createMixtureMasks(mixture, estimates, shape({ sources: 2 }));
    expect(output.every(value => Number.isFinite(value))).toBe(true);
    for (let source = 0; source < 2; source++) for (let component = 0; component < 4; component++)
      expect(output[source * 4 + component]).toBe(mixture[component] * .5);
    expect(output.subarray(8).every(value => value === 0)).toBe(true);
    reconstruct(output, 4, 2).forEach((value, index) => expect(value).toBe(mixture[index]));
  });

  it('never changes inputs, including overlapping subarray views, and returns an independent buffer', () => {
    const shared = new Float32Array([99, 1, -2, 3, -4, .5, -1, 1.5, -2, 88]);
    const mixture = shared.subarray(1, 5), estimates = shared.subarray(3, 7), before = new Uint8Array(shared.buffer).slice();
    const output = createMixtureMasks(mixture, estimates, shape());
    expect(new Uint8Array(shared.buffer)).toEqual(before); expect(output.buffer).not.toBe(shared.buffer);
    output.fill(123); expect(new Uint8Array(shared.buffer)).toEqual(before);
  });

  it.each([
    { channels: 0 }, { channels: 3 }, { channels: 1.5 }, { sources: 0 }, { sources: 17 },
    { bins: 0 }, { bins: -1 }, { bins: NaN }, { frames: 1.1 }, { frames: Infinity }, { frames: Number.MAX_SAFE_INTEGER + 1 },
  ])('rejects invalid dimensions %j before allocating output', invalid => {
    expect(() => createMixtureMasks(new Float32Array(4), new Float32Array(4), shape(invalid))).toThrow(/dimensions/);
  });

  it('bounds output allocation and rejects unsafe dimension products without allocating enormous arrays', () => {
    const small = new Float32Array(4);
    expect(() => createMixtureMasks(small, small, shape({ sources: 16, bins: 2 ** 24 }))).toThrow(/512 MiB/);
    expect(() => createMixtureMasks(small, small, shape({ bins: Number.MAX_SAFE_INTEGER, frames: 2 }))).toThrow(/512 MiB/);
    expect(() => createMixtureMasks(small, small, null as unknown as SeparationMaskShape)).toThrow(/dimensions/);
  });

  it('rejects mismatched spectra and unsupported array types', () => {
    const small = new Float32Array(4);
    expect(() => createMixtureMasks(small.subarray(1), small, shape())).toThrow(/shapes/);
    expect(() => createMixtureMasks(small, new Float32Array(5), shape())).toThrow(/shapes/);
    expect(() => createMixtureMasks(new Float64Array(4) as unknown as Float32Array, small, shape())).toThrow(/Float32Array/);
    expect(() => createMixtureMasks(small, [1, 2, 3, 4] as unknown as Float32Array, shape())).toThrow(/Float32Array/);
  });

  it.each([NaN, Infinity, -Infinity])('rejects non-finite samples (%s) in either input, including the final estimate', value => {
    const mixture = new Float32Array([1, 2, 3, 4]), estimates = new Float32Array(20);
    estimates[19] = value;
    expect(() => createMixtureMasks(mixture, estimates, shape({ sources: 5 }))).toThrow(/non-finite/);
    estimates[19] = 0; mixture[3] = value;
    expect(() => createMixtureMasks(mixture, estimates, shape({ sources: 5 }))).toThrow(/non-finite/);
  });
});
