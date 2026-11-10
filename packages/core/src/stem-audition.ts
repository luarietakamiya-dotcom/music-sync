import { analyzeAudio } from '@music-sync/audio-analysis';
import { createComparisonPlan } from './comparison.js';
import type { AnalysisResult, AudioData } from '@music-sync/shared';

export interface StemAudition {
  startFrame: number;
  dry: AudioData;
  studio: AudioData;
  before: AnalysisResult;
  after: AnalysisResult;
}
type Stereo = [Float32Array, Float32Array];
const stereo = (length: number): Stereo => [new Float32Array(length), new Float32Array(length)];

/** Keep the best excerpt and one scratch excerpt, independent of the song length. */
export class StemAuditionSelector {
  private readonly capacity: number;
  private readonly dry: Stereo;
  private readonly wet: Stereo;
  private best?: { start: number; dry: Stereo; wet: Stereo };
  private score = 1e-9;
  private start = 0;
  private fill = 0;

  constructor(private rate: number, frames: number) {
    this.capacity = Math.min(frames, 8 * rate, 384000);
    this.dry = stereo(this.capacity);
    this.wet = stereo(this.capacity);
  }
  push(dry: readonly Float32Array[], wet: readonly Float32Array[]) {
    for (let offset = 0; offset < wet[0].length;) {
      const n = Math.min(this.capacity - this.fill, wet[0].length - offset);
      for (let c = 0; c < 2; c++) {
        this.dry[c].set(dry[c].subarray(offset, offset + n), this.fill);
        this.wet[c].set(wet[c].subarray(offset, offset + n), this.fill);
      }
      this.fill += n; offset += n;
      if (this.fill === this.capacity) this.consider();
    }
  }
  private consider() {
    const n = this.fill, start = this.start;
    this.start += n; this.fill = 0;
    if (n < 0.4 * this.rate) return;
    let a = 0, b = 0, ab = 0;
    for (let c = 0; c < 2; c++) for (let i = 0; i < n; i++) {
      const dry = this.dry[c][i], wet = this.wet[c][i];
      a += dry * dry; b += wet * wet; ab += dry * wet;
    }
    if (Math.min(a, b) < 2 * n * 1e-7) return;
    // Ignore a constant gain difference; prefer changes with energy above the noise floor.
    const difference = Math.max(0, 1 - ab / Math.sqrt(a * b));
    const score = difference * Math.min(1, Math.min(a, b) / (2 * n * 1e-4)) * Math.min(1, n / this.rate);
    if (score <= this.score) return;
    this.score = score;
    this.best = { start, dry: [this.dry[0].slice(0, n), this.dry[1].slice(0, n)],
      wet: [this.wet[0].slice(0, n), this.wet[1].slice(0, n)] };
  }
  finish(): StemAudition | undefined {
    if (this.fill && this.fill < this.capacity && this.start >= this.capacity) {
      // Prefix the final partial window with preceding samples that still occupy the scratch buffers.
      // A correction in the last 100 ms should have enough context to audition and measure.
      for (const channel of [...this.dry, ...this.wet]) {
        const tail = channel.slice(0, this.fill);
        channel.copyWithin(0, this.fill);
        channel.set(tail, this.capacity - this.fill);
      }
      this.start -= this.capacity - this.fill;
      this.fill = this.capacity;
    }
    this.consider();
    if (!this.best) return;
    const dry = { sampleRate: this.rate, channels: this.best.dry };
    const studio = { sampleRate: this.rate, channels: this.best.wet };
    // A reference sum can exceed unity. Scale both identically before measuring for playback.
    let peak = 1;
    for (const channel of [...dry.channels, ...studio.channels]) for (const x of channel) peak = Math.max(peak, Math.abs(x));
    if (peak > 1) for (const channel of [...dry.channels, ...studio.channels]) for (let i=0; i<channel.length; i++) channel[i] /= peak;
    const before = analyzeAudio(dry), after = analyzeAudio(studio);
    if (!createComparisonPlan(before, after).match.available) return;
    return { startFrame: this.best.start, dry, studio, before, after };
  }
}
