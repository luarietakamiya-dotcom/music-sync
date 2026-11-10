import { fft } from './fft.js';
import { validateAudio, type AudioData } from '@music-sync/shared';

export const PERCEPTUAL_BANDS = ['sub', 'low', 'lowMid', 'mid', 'upperMid', 'presence', 'high', 'air'] as const;
export type PerceptualBand = typeof PERCEPTUAL_BANDS[number];
export interface Estimate { value: number; confidence: number }
export interface BandDistribution { mean: number; p50: number; p90: number; excessFraction: number; rmsDb: number; rangeDb: number }
export interface PerceptualFeatures {
  version: 1; windows: number; confidence: number;
  bands: Record<PerceptualBand, BandDistribution>;
  centroidHz: number; rolloffHz: number; flux: number; crestDb: number;
  lowSideRatio: number; sideRatio: number; correlation: number;
  features: Record<'muddiness' | 'boxiness' | 'harshness' | 'brightness' | 'dullness' | 'presence' | 'vocalCongestion'
    | 'transientDensity' | 'attack' | 'punch' | 'transientConsistency' | 'dynamicDensity' | 'stereoWidth' | 'stereoInstability'
    | 'centerDominance' | 'sideDominance' | 'ambience' | 'dryTendency' | 'masking' | 'lowEndBuildup', Estimate>;
  ambienceClass: 'Dry' | 'Moderate' | 'Wet';
}
const clamp = (x: number) => Math.max(0, Math.min(1, x));
const edges = [60, 180, 400, 1000, 2500, 5000, 10000, Infinity];
const excess = [0.3, 0.4, 0.38, 0.5, 0.45, 0.35, 0.3, 0.2];
const N = 2048, HOP = N / 2;
class Histogram {
  bins = new Uint32Array(1001); count = 0;
  add(x: number) { this.bins[Math.round(clamp(x) * 1000)]++; this.count++; }
  percentile(p: number): number {
    let sum = 0; for (let i = 0; i <= 1000; i++) { sum += this.bins[i]; if (sum >= Math.max(1, Math.ceil(this.count * p))) return i / 1000; } return 0;
  }
}
/** Chunk-ready, bounded-memory analysis. push() accepts any contiguous chunk size.
 * No audio or per-frame spectrum is retained after finish(). No semantic detection. */
export class PerceptualAnalyzer {
  private pcm: Float64Array[]; private re: Float64Array[]; private im: Float64Array[];
  private fill = 0; private frames = 0; private samples = 0; private totalPower = 0; private peak = 0;
  private window = Float64Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1)));
  private energies = new Float64Array(8);
  private previous = new Float64Array(HOP + 1); private ratios = PERCEPTUAL_BANDS.map(() => new Histogram());
  private levels = PERCEPTUAL_BANDS.map(() => new Histogram()); private sums = new Float64Array(8); private powers = new Float64Array(8);
  private exceed = new Float64Array(8); private centroid = 0; private rolloff = 0; private flux = 0;
  private mid = 0; private side = 0; private lowMid = 0; private lowSide = 0; private l2 = 0; private r2 = 0; private cross = 0;
  private negative = 0; private onsets = 0; private attackSum = 0; private attackSquared = 0; private decay = 0; private decayOpportunities = 0;
  private lastRms = 0; private lastFlux = 0; private completed = false;
  constructor(readonly sampleRate: number, readonly channels: number) {
    if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 192000 || ![1, 2].includes(channels)) throw new Error('Invalid perceptual format');
    this.pcm = Array.from({ length: channels }, () => new Float64Array(N));
    this.re = this.pcm.map(() => new Float64Array(N)); this.im = this.pcm.map(() => new Float64Array(N));
  }
  push(chunk: readonly Float32Array[]): void {
    if (this.completed || chunk.length !== this.channels || chunk.some(c => c.length !== chunk[0].length)) throw new Error('Invalid perceptual chunk/state');
    for (let i = 0; i < chunk[0].length; i++) {
      for (let c = 0; c < this.channels; c++) {
        const x = chunk[c][i]; if (!Number.isFinite(x)) throw new Error('Invalid audio sample');
        this.pcm[c][this.fill] = x; this.totalPower += x * x; this.peak = Math.max(this.peak, Math.abs(x));
      }
      this.fill++; this.samples++;
      if (this.fill === N) { this.measure(); for (const channel of this.pcm) channel.copyWithin(0, HOP); this.fill = HOP; }
    }
  }
  private measure(): void {
    let power = 0, left = 0, right = 0, cross = 0;
    for (let c = 0; c < this.channels; c++) {
      this.im[c].fill(0);
      for (let i = 0; i < N; i++) { const x = this.pcm[c][i]; power += x * x; this.re[c][i] = x * this.window[i]; }
      fft(this.re[c], this.im[c]);
    }
    const rms = Math.sqrt(power / (N * this.channels));
    if (rms < 1e-6) { this.previous.fill(0); this.lastRms = 0; return; }
    for (let i = 0; i < N; i++) { const l = this.pcm[0][i], r = this.pcm[this.channels - 1][i]; left += l*l; right += r*r; cross += l*r; }
    this.l2 += left; this.r2 += right; this.cross += cross;
    if (cross / Math.sqrt(Math.max(1e-30, left * right)) < -0.1) this.negative++;
    const energies = this.energies; energies.fill(0); let total = 0, weighted = 0, flux = 0, cumulative = 0, rolloff = 0;
    // Reuse the first imaginary spectrum as power storage after both channels' complex terms are read.
    for (let k = 1; k <= HOP; k++) {
      const lr = this.re[0][k], li = this.im[0][k], rr = this.re[this.channels - 1][k], ri = this.im[this.channels - 1][k];
      const energy = (lr*lr + li*li + rr*rr + ri*ri) / 2, f = k * this.sampleRate / N;
      let b = 0; while (f >= edges[b]) b++;
      energies[b] += energy; total += energy; weighted += f * energy;
      const m = ((lr+rr)**2 + (li+ri)**2)/4, s = ((lr-rr)**2 + (li-ri)**2)/4;
      this.mid += m; this.side += s; if (f < 180) { this.lowMid += m; this.lowSide += s; }
      this.im[0][k] = energy;
    }
    for (let k = 1; k <= HOP; k++) {
      const ratio = this.im[0][k] / Math.max(total, 1e-30);
      flux += Math.max(0, Math.sqrt(ratio) - this.previous[k]); this.previous[k] = Math.sqrt(ratio);
      cumulative += ratio; if (!rolloff && cumulative >= 0.85) rolloff = k * this.sampleRate / N;
    }
    flux /= Math.sqrt(HOP);
    for (let b = 0; b < 8; b++) {
      const ratio = energies[b] / Math.max(total, 1e-30), bandPower = rms*rms*ratio;
      this.sums[b] += ratio; this.powers[b] += bandPower; this.ratios[b].add(ratio);
      this.levels[b].add((10*Math.log10(Math.max(1e-12,bandPower))+120)/120);
      if (ratio > excess[b]) this.exceed[b]++;
    }
    const attack = Math.max(0, 20*Math.log10(rms / Math.max(this.lastRms, 1e-6)));
    if (this.lastRms > 1e-6 && attack > 3 && (flux > 0.002 || attack > 6)) { this.onsets++; this.attackSum += attack; this.attackSquared += attack*attack; }
    if (this.lastRms > 1e-6 && rms < this.lastRms) {
      // Ignore near-steady amplitude drift: sustained notes alone are not reverb.
      this.decayOpportunities++; const ratio = rms / this.lastRms;
      const decayPerSecond = -Math.log(ratio) * this.sampleRate / HOP;
      if (decayPerSecond > 0.7 && decayPerSecond < 8 && flux < 0.02 && this.lastFlux < 0.03) this.decay++;
    }
    this.lastRms = rms; this.lastFlux = flux; this.centroid += weighted / Math.max(total,1e-30); this.rolloff += rolloff; this.flux += flux; this.frames++;
  }
  finish(): PerceptualFeatures {
    if (this.completed) throw new Error('Analyzer already finished'); this.completed = true;
    if (!this.frames && this.fill) { for (const c of this.pcm) c.fill(0, this.fill); this.measure(); }
    const n = Math.max(1,this.frames), bands = Object.fromEntries(PERCEPTUAL_BANDS.map((name,b) => [name, {
      mean: this.sums[b]/n, p50: this.ratios[b].percentile(0.5), p90: this.ratios[b].percentile(0.9), excessFraction:this.exceed[b]/n,
      rmsDb:10*Math.log10(Math.max(1e-12,this.powers[b]/n)), rangeDb:120*(this.levels[b].percentile(0.9)-this.levels[b].percentile(0.1)),
    }])) as Record<PerceptualBand,BandDistribution>;
    const spread = PERCEPTUAL_BANDS.filter(b => bands[b].mean > 0.025).length;
    const activeSeconds = Math.min(this.samples / this.sampleRate, (this.frames * HOP + N) / this.sampleRate);
    const confidence = clamp(activeSeconds / 2)*Math.min(1,spread/4)* (this.frames ? 0.9 : 0);
    const estimate = (value:number, reliability=1): Estimate => ({value:clamp(value),confidence:confidence*reliability});
    const bass=bands.sub.mean+bands.low.mean, mud=bands.lowMid.mean, upper=bands.upperMid.mean+bands.presence.mean, high=bands.high.mean+bands.air.mean;
    const centroid=this.centroid/n, rolloff=this.rolloff/n, flux=this.flux/n;
    const crestDb=20*Math.log10(Math.max(1e-12,this.peak)/Math.max(1e-12,Math.sqrt(this.totalPower/Math.max(1,this.samples*this.channels))));
    const sideRatio=this.side/Math.max(1e-30,this.mid+this.side), lowSideRatio=this.lowSide/Math.max(1e-30,this.lowMid+this.lowSide);
    const tail=this.decay/Math.max(1,this.decayOpportunities), onsetRate=this.onsets/Math.max(0.1,this.samples/this.sampleRate);
    const ambience=clamp(tail*0.7+sideRatio*0.6), punch=clamp((crestDb-5)/15)*0.6+clamp(this.attackSum/Math.max(1,this.onsets)/12)*0.4;
    return {version:1,windows:this.frames,confidence,bands,centroidHz:centroid,rolloffHz:rolloff,flux,crestDb,sideRatio,lowSideRatio,
      correlation:this.cross/Math.max(1e-30,Math.sqrt(this.l2*this.r2)),ambienceClass:ambience>0.62?'Wet':ambience<0.28?'Dry':'Moderate',features:{
        lowEndBuildup:estimate(clamp((bass-0.4)/0.5)*(0.6+0.4*clamp((1500-centroid)/1500))),
        muddiness:estimate(clamp((mud-0.2)/0.5)*(0.65+0.35*clamp((1800-centroid)/1800))),
        boxiness:estimate(clamp((mud+bands.mid.mean-0.6)/0.35)*(1-clamp(high*2))),
        harshness:estimate(clamp((upper-0.32)/0.55)*(0.6+0.4*clamp(centroid/4000))),
        brightness:estimate(clamp((high-0.25)/0.6)*clamp(rolloff/8000),clamp((this.sampleRate/2-5000)/5000)),
        dullness:estimate(clamp((0.05-high)/0.05)*clamp((3500-rolloff)/2500)*(1-clamp(bass*1.2)),clamp((this.sampleRate/2-5000)/5000)),
        presence:estimate(clamp((bands.upperMid.mean+bands.presence.mean)*2)),
        vocalCongestion:estimate(clamp((bands.mid.mean+bands.upperMid.mean-0.55)/0.4)*(1-clamp(flux*10)),0.65),
        transientDensity:estimate(clamp(onsetRate/8)),attack:estimate(clamp(this.attackSum/Math.max(1,this.onsets)/15),this.onsets>2?1:0.2),punch:estimate(punch),
        transientConsistency:estimate(this.onsets>2?1-clamp(Math.sqrt(Math.max(0,this.attackSquared/this.onsets-(this.attackSum/this.onsets)**2))/12):0,this.onsets>2?1:0.2),
        dynamicDensity:estimate(clamp((10-crestDb)/7)*(1-clamp(onsetRate/10))),stereoWidth:estimate(sideRatio,this.channels===2?1:0),
        stereoInstability:estimate(this.negative/n,this.channels===2?1:0),centerDominance:estimate(1-sideRatio),sideDominance:estimate(clamp((sideRatio-0.3)/0.5)),
        ambience:estimate(ambience,this.decayOpportunities>5?0.8:0.25),dryTendency:estimate(1-ambience,0.6),
        masking:estimate(clamp((mud+bands.mid.mean+bands.upperMid.mean-0.65)/0.35)*(1-clamp(flux*10)),0.65),
      }};
  }
}
export function analyzePerceptualFeatures(audio: AudioData): PerceptualFeatures {
  validateAudio(audio); const analyzer=new PerceptualAnalyzer(audio.sampleRate,audio.channels.length);
  // Views avoid PCM copies; the same streaming API is available to external callers.
  for(let offset=0;offset<audio.channels[0].length;offset+=16384) analyzer.push(audio.channels.map(c=>c.subarray(offset,offset+16384)));
  return analyzer.finish();
}
