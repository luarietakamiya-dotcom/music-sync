export interface SeparationMaskShape {
  readonly channels: number;
  readonly sources: number;
  readonly bins: number;
  readonly frames: number;
}

const MAX_OUTPUT_BYTES = 512 * 1024 ** 2;

/** Convert learned complex estimates into conservative, stereo-linked ratio masks.
 *
 * Mixture: [2 * channels, bins, frames], channel-major real / imaginary planes.
 * Estimates: [sources, 2 * channels, bins, frames].
 * Result: [sources + 1, 2 * channels, bins, frames]. The last source is the
 * unassigned remainder, never an additional learned instrument estimate.
 *
 * Each mask uses the estimate's combined channel magnitude and is applied to
 * the ORIGINAL spectrum. This preserves its phase and pan at each bin, and
 * prevents overlapping estimates from duplicating mixture energy. It discards
 * learned phase / stereo changes and can retain bleed; it is not a guarantee
 * of clean isolation. All sources reconstruct the mixture within Float32 rounding.
 * Input arrays are read-only to this function; the output owns a new buffer.
 */
export function createMixtureMasks(mixture: Float32Array, estimates: Float32Array, shape: SeparationMaskShape): Float32Array {
  if (!shape || typeof shape !== 'object') throw new TypeError('Separation mask dimensions are required.');
  const { channels, sources, bins, frames } = shape;
  if (![channels, sources, bins, frames].every(value => Number.isSafeInteger(value) && value > 0) ||
      channels > 2 || sources > 16) throw new RangeError('Invalid separation mask dimensions.');
  const planes = channels * 2, points = bins * frames, mixtureLength = planes * points;
  const estimatesLength = sources * mixtureLength, outputLength = (sources + 1) * mixtureLength;
  if (![points, mixtureLength, estimatesLength, outputLength].every(Number.isSafeInteger) ||
      outputLength > MAX_OUTPUT_BYTES / Float32Array.BYTES_PER_ELEMENT)
    throw new RangeError('Separation mask output exceeds the 512 MiB limit.');
  if (!(mixture instanceof Float32Array) || !(estimates instanceof Float32Array))
    throw new TypeError('Separation masks require Float32Array spectra.');
  if (mixture.length !== mixtureLength || estimates.length !== estimatesLength)
    throw new RangeError('Separation spectrum shapes do not match their dimensions.');
  for (const value of mixture) if (!Number.isFinite(value)) throw new RangeError('Mixture spectrum contains a non-finite value.');
  for (const value of estimates) if (!Number.isFinite(value)) throw new RangeError('Estimated spectrum contains a non-finite value.');

  const output = new Float32Array(outputLength), amplitudes = new Float64Array(sources);
  for (let point = 0; point < points; point++) {
    // Squaring a finite Float32 value is safe in Float64, including subnormals.
    let mixturePower = 0, amplitudeSum = 0;
    for (let component = 0; component < planes; component++) {
      const value = mixture[component * points + point]; mixturePower += value * value;
    }
    for (let source = 0; source < sources; source++) {
      let power = 0;
      const start = source * mixtureLength;
      for (let component = 0; component < planes; component++) {
        const value = estimates[start + component * points + point]; power += value * value;
      }
      amplitudes[source] = Math.sqrt(power); amplitudeSum += amplitudes[source];
    }
    const denominator = Math.max(Math.sqrt(mixturePower), amplitudeSum);
    if (!Number.isFinite(denominator)) throw new RangeError('Separation mask magnitude overflow.');
    if (denominator === 0) continue;
    let assigned = 0;
    for (let source = 0; source <= sources; source++) {
      const weight = source < sources ? amplitudes[source] / denominator : Math.max(0, 1 - assigned);
      if (source < sources) assigned += weight;
      const start = source * mixtureLength;
      for (let component = 0; component < planes; component++) {
        const index = component * points + point;
        output[start + index] = mixture[index] * weight;
        if (!Number.isFinite(output[start + index])) throw new RangeError('Separation mask output overflow.');
      }
    }
  }
  return output;
}
