import { amplitudeToDb, type AnalysisResult, type AudioData } from '@music-sync/shared';
import { createKWeighting, TruePeakEstimator } from '@music-sync/dsp';

/** Incremental equivalent of basic analysis. Holds only LUFS blocks and waveform bins. */
export class StreamingAudioAnalyzer {
  private readonly blockFrames: number;
  private readonly hopFrames: number;
  private readonly blockPowers: Float64Array;
  private readonly filters: ((sample: number) => number)[];
  private readonly rings: Float64Array[];
  private readonly ringEnergy: Float64Array;
  private readonly peaks: TruePeakEstimator[];
  private readonly sums: Float64Array;
  private readonly squares: Float64Array;
  private readonly waveformMin: Float32Array[];
  private readonly waveformMax: Float32Array[];
  private readonly bins: number;
  private offset = 0;
  private peak = 0;
  private energy = 0;
  private clipped = 0;
  private lr = 0;
  private mid = 0;
  private side = 0;
  private complete = false;

  constructor(readonly sampleRate: number, readonly channelCount: number, readonly frames: number, waveformBins = 1000) {
    if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000 ||
      !Number.isInteger(channelCount) || channelCount < 1 || channelCount > 2 ||
      !Number.isSafeInteger(frames) || frames < 1 || frames > sampleRate * 3600 ||
      !Number.isInteger(waveformBins) || waveformBins < 1 || waveformBins > 4096)
      throw new Error('Invalid streaming audio dimensions.');
    this.bins = Math.min(frames, waveformBins);
    this.blockFrames = Math.round(sampleRate * 0.4);
    this.hopFrames = Math.round(sampleRate * 0.1);
    this.blockPowers = new Float64Array(frames < this.blockFrames ? 0 : 1 + Math.floor((frames - this.blockFrames) / this.hopFrames));
    this.filters = Array.from({ length: channelCount }, () => createKWeighting(sampleRate));
    this.rings = Array.from({ length: channelCount }, () => new Float64Array(this.blockFrames));
    this.ringEnergy = new Float64Array(channelCount);
    this.peaks = Array.from({ length: channelCount }, () => new TruePeakEstimator());
    this.sums = new Float64Array(channelCount);
    this.squares = new Float64Array(channelCount);
    this.waveformMin = Array.from({ length: channelCount }, () => new Float32Array(this.bins).fill(Infinity));
    this.waveformMax = Array.from({ length: channelCount }, () => new Float32Array(this.bins).fill(-Infinity));
  }

  push(audio: AudioData): void {
    if (this.complete || audio.sampleRate !== this.sampleRate || audio.channels.length !== this.channelCount)
      throw new Error('Streaming analysis format changed or was already completed.');
    const count = audio.channels[0]?.length ?? 0;
    if (!count || this.offset + count > this.frames || audio.channels.some(channel => !(channel instanceof Float32Array) || channel.length !== count))
      throw new Error('Streaming analysis received invalid chunk dimensions.');
    for (let channel = 0; channel < this.channelCount; channel++) this.peaks[channel].push(audio.channels[channel]);
    for (let i = 0; i < count; i++) {
      const frame = this.offset + i;
      const bin = Math.floor(((frame + 1) * this.bins - 1) / this.frames);
      for (let channel = 0; channel < this.channelCount; channel++) {
        const value = audio.channels[channel][i];
        if (!Number.isFinite(value) || Math.abs(value) > 32) throw new Error('音声に不正なサンプル値が含まれています。');
        this.peak = Math.max(this.peak, Math.abs(value));
        this.energy += value * value;
        this.sums[channel] += value;
        this.squares[channel] += value * value;
        if (Math.abs(value) >= 1) this.clipped++;
        this.waveformMin[channel][bin] = Math.min(this.waveformMin[channel][bin], value);
        this.waveformMax[channel][bin] = Math.max(this.waveformMax[channel][bin], value);
        const weighted = this.filters[channel](value);
        const square = weighted * weighted;
        const position = frame % this.blockFrames;
        this.ringEnergy[channel] += square - this.rings[channel][position];
        this.rings[channel][position] = square;
        if (frame + 1 >= this.blockFrames && (frame + 1 - this.blockFrames) % this.hopFrames === 0)
          this.blockPowers[(frame + 1 - this.blockFrames) / this.hopFrames] += Math.max(0, this.ringEnergy[channel]) / this.blockFrames;
      }
      if (this.channelCount === 2) {
        const left = audio.channels[0][i], right = audio.channels[1][i];
        this.lr += left * right;
        this.mid += ((left + right) / 2) ** 2;
        this.side += ((left - right) / 2) ** 2;
      }
    }
    this.offset += count;
  }

  finish(): AnalysisResult {
    if (this.offset !== this.frames) throw new Error('Streaming analysis did not receive the complete audio.');
    this.complete = true;
    const absolutePower = 10 ** ((-70 + 0.691) / 10);
    const aboveAbsolute = Array.from(this.blockPowers).filter(power => power >= absolutePower);
    let integratedLufs: number | null = null;
    if (aboveAbsolute.length) {
      const mean = aboveAbsolute.reduce((sum, power) => sum + power, 0) / aboveAbsolute.length;
      const gated = aboveAbsolute.filter(power => power >= mean / 10);
      integratedLufs = -0.691 + 10 * Math.log10(gated.reduce((sum, power) => sum + power, 0) / gated.length);
    }
    const dcOffset = Array.from(this.sums, sum => sum / this.frames);
    let stereoCorrelation: number | null = null;
    let sideEnergyPercent: number | null = null;
    if (this.channelCount === 2) {
      const ll = Math.max(0, this.squares[0] - this.sums[0] ** 2 / this.frames);
      const rr = Math.max(0, this.squares[1] - this.sums[1] ** 2 / this.frames);
      const lr = this.lr - this.sums[0] * this.sums[1] / this.frames;
      if (ll > 0 && rr > 0) stereoCorrelation = Math.max(-1, Math.min(1, lr / Math.sqrt(ll * rr)));
      if (this.mid + this.side > 0) sideEnergyPercent = 100 * this.side / (this.mid + this.side);
    }
    const rms = Math.sqrt(this.energy / (this.frames * this.channelCount));
    const truePeak = Math.max(...this.peaks.map(estimator => estimator.finish()));
    const warnings: string[] = [];
    if (this.frames / this.sampleRate < 0.4) warnings.push('400 ms未満のためIntegrated LUFSは測定できません。');
    else if (integratedLufs === null) warnings.push('無音またはゲート閾値未満のためIntegrated LUFSは測定できません。');
    if (this.clipped) warnings.push('0 dBFS以上のサンプルがあります。');
    if (stereoCorrelation !== null && stereoCorrelation < 0) warnings.push('逆相成分があります。モノラル再生で音が弱くなる可能性があります。');
    if (dcOffset.some(offset => Math.abs(offset) > 0.01)) warnings.push('DCオフセットが検出されました。');
    return {
      schemaVersion: 1, algorithmVersion: '0.1.0', sampleRate: this.sampleRate, channels: this.channelCount,
      frames: this.frames, durationSeconds: this.frames / this.sampleRate,
      samplePeakDbfs: amplitudeToDb(this.peak), rmsDbfs: amplitudeToDb(rms), integratedLufs,
      truePeakDbtp: amplitudeToDb(truePeak), truePeakMethod: '4x-windowed-sinc-estimate',
      crestFactorDb: rms > 0 ? amplitudeToDb(this.peak / rms) : null,
      stereoCorrelation, sideEnergyPercent, clippedSamples: this.clipped, dcOffset,
      waveform: this.waveformMin.map((min, channel) => ({ min: Array.from(min), max: Array.from(this.waveformMax[channel]) })), warnings,
    };
  }
}
