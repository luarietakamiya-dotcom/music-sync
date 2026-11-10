/** Measurement primitives; independent of Web Audio, DOM and filesystem APIs. */
export { processAudio, defaultProcessingChain, validateProcessingChain, peakingCoefficients } from './processing.js';
export type { ProcessingChain, ProcessingResult } from './processing.js';
export { createVenueStream } from './live-venue.js';
export { renderMix } from './mix.js';
export type { MixStage } from './mix.js';
export type { DynamicEqBand, MultibandParameters } from './band-dynamics.js';
export type { LiveParameters } from './live.js';
export { renderSoundColor, validateSoundColorParameters } from './sound-color.js';
export type { SoundColorParameters, ToneBand } from './sound-color.js';
export { createTrebleFilter } from './treble.js';
export { createGrainProcessor, type GrainSettings, type GrainProcessorReport } from './grain.js';
export { fft } from './fft.js';
export { createStemGain } from './stem-gain.js';
export { createStemDuck } from './stem-duck.js';
export { humanDouble } from './human-double.js';
export type BiquadCoefficients = readonly [number, number, number, number, number];

export function createBiquad([b0, b1, b2, a1, a2]: BiquadCoefficients): (x: number) => number {
  let z1 = 0, z2 = 0;
  return (x) => {
    const y = b0 * x + z1;
    z1 = b1 * x - a1 * y + z2;
    z2 = b2 * x - a2 * y;
    return y;
  };
}

/** Bilinear-transform K weighting; constants reproduce BS.1770 at 48 kHz. */
export function createKWeighting(sampleRate: number): (x: number) => number {
  const k = Math.tan(Math.PI * 1681.974450955533 / sampleRate);
  const q = 0.7071752369554196, vh = 10 ** (3.999843853973347 / 20);
  const vb = vh ** 0.4996667741545416, d = 1 + k / q + k * k;
  const shelf = createBiquad([
    (vh + vb * k / q + k * k) / d, 2 * (k * k - vh) / d,
    (vh - vb * k / q + k * k) / d, 2 * (k * k - 1) / d, (1 - k / q + k * k) / d,
  ]);
  const h = Math.tan(Math.PI * 38.13547087602444 / sampleRate);
  const r = 0.5003270373238773, a = 1 + h / r + h * h;
  const highpass = createBiquad([1, -2, 1, 2 * (h * h - 1) / a, (1 - h / r + h * h) / a]);
  return x => highpass(shelf(x));
}

// Three fractional phases plus the original samples give a 4x estimate.
// 24-tap Lanczos-windowed sinc, zero extension at boundaries. Not a certified meter.
export { createStemAccumulator, AlignedStemMixer, streamStemPresenceDip, validateStemPresenceDip } from './stem-mixer.js';
export type { StemPresenceDip } from './stem-mixer.js';
const radius = 12;
const sinc = (x: number) => Math.abs(x) < 1e-12 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
const phases = [0.25, 0.5, 0.75].map(fraction => {
  const taps = Array.from({ length: radius * 2 }, (_, index) => {
    const x = fraction - (index - radius + 1);
    return sinc(x) * sinc(x / radius);
  });
  const sum = taps.reduce((a, b) => a + b, 0);
  return taps.map(x => x / sum);
});

/** The same 4x estimate with a 24-sample history, so chunk boundaries are exact. */
export class TruePeakEstimator {
  private readonly history = new Float32Array(radius * 2);
  private length = 0;
  private nextPosition = -radius;
  private peak = 0;
  private finished = false;

  push(samples: Float32Array): void {
    if (this.finished) throw new Error('True-peak estimate is already complete.');
    for (const sample of samples) {
      this.history[this.length % this.history.length] = sample;
      this.peak = Math.max(this.peak, Math.abs(sample));
      this.length++;
      this.evaluate(this.length - radius - 1);
    }
  }

  private evaluate(position: number): void {
    for (const taps of phases) {
      let value = 0;
      for (let j = 0; j < taps.length; j++) {
        const index = position + j - radius + 1;
        if (index >= 0 && index < this.length) value += this.history[index % this.history.length] * taps[j];
      }
      this.peak = Math.max(this.peak, Math.abs(value));
    }
    this.nextPosition = position + 1;
  }

  finish(): number {
    if (!this.finished) {
      for (let position = this.nextPosition; position < this.length + radius; position++) this.evaluate(position);
      this.finished = true;
    }
    return this.peak;
  }
}

export function estimateTruePeak(samples: Float32Array): number {
  const estimator = new TruePeakEstimator();
  estimator.push(samples);
  return estimator.finish();
}

export { createReferenceProcessor } from './reference-stream.js';
export type { ReferenceDspPlan, ReferenceStreamProcessor } from './reference-stream.js';
