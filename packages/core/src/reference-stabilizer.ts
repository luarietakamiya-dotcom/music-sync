import type { AudioData } from '@music-sync/shared';
import { bounded } from './studio-settings.js';

export interface StabilizationSettings {
  sensitivityDb: number; repairMs: number; maxDb: number; percent: number; toleranceDb: number;
}
interface Window { difference: number; similar: boolean; }
/** Measure a time-aligned dry stem sum against a reference. The reference is never mixed in. */
export class ReferenceStabilizer {
  private windows: Window[] = [];
  private count = 0;
  private mixPower = 0;
  private refPower = 0;
  private cross = 0;
  private corrections = new Float32Array(0);
  readonly size: number;
  explanation = '';
  constructor(private rate: number, private settings: StabilizationSettings) {
    this.size = Math.round(rate * 0.05);
    bounded(settings.sensitivityDb, 0.1, 3); bounded(settings.repairMs, 50, 1000);
    bounded(settings.maxDb, 0, 3); bounded(settings.percent, 0, 10); bounded(settings.toleranceDb, 0, 2);
  }
  measure(mix: AudioData, ref: AudioData) {
    if (mix.sampleRate !== this.rate || ref.sampleRate !== this.rate || mix.channels[0].length !== ref.channels[0].length)
      throw new Error('比較用原曲はSTEMと同じ長さ・レート・開始位置で書き出してください。');
    for (let i = 0; i < mix.channels[0].length; i++) {
      for (let c = 0; c < 2; c++) {
        const x = mix.channels[c][i], y = ref.channels[Math.min(c, ref.channels.length - 1)][i];
        if (!Number.isFinite(y) || Math.abs(y) > 32) throw new Error('比較用原曲に不正なサンプル値があります。');
        this.mixPower += x * x; this.refPower += y * y; this.cross += x * y;
      }
      if (++this.count < this.size) continue;
      const similar = this.mixPower > 1e-8 * this.count && this.refPower > 1e-8 * this.count &&
        this.cross > 0.92 * Math.sqrt(this.mixPower * this.refPower);
      this.windows.push({ similar, difference: similar ? 10 * Math.log10(this.refPower / this.mixPower) : 0 });
      this.count = this.cross = this.mixPower = this.refPower = 0;
    }
  }
  plan() {
    const w = this.windows, s = this.settings;
    const valid = w.filter(x => x.similar).map(x => x.difference).sort((a,b) => a-b);
    this.corrections = new Float32Array(w.length);
    this.explanation = '原曲との差を確認し、安定化が必要な短い区間は見つかりませんでした。';
    if (!valid.length || valid.length < w.length * 0.65) {
      this.explanation = '原曲とSTEMの波形の一致を確認できず、安定化を見送りました。'; return;
    }
    const baseline = valid[Math.floor(valid.length / 2)];
    const delta = w.map(x => x.difference - baseline);
    let remaining = Math.floor(w.length * s.percent / 100), used = 0;
    for (let i = 1; i < w.length - 1;) {
      const start = i, sign = Math.sign(delta[i]);
      if (!w[i].similar || Math.abs(delta[i]) <= Math.max(s.sensitivityDb, s.toleranceDb)) { i++; continue; }
      while (i < w.length && w[i].similar && Math.sign(delta[i]) === sign && Math.abs(delta[i]) > s.toleranceDb) i++;
      const length = i - start;
      if (i === w.length || !w[start-1].similar || !w[i].similar || Math.abs(delta[start-1]) > s.toleranceDb ||
        Math.abs(delta[i]) > s.toleranceDb || length * this.size > this.rate * s.repairMs / 1000 || length > remaining || !s.maxDb) continue;
      for (let j = start; j < i; j++) this.corrections[j] = sign * Math.min(s.maxDb, Math.abs(delta[j]) - s.toleranceDb);
      remaining -= length; used += length;
    }
    if (used) this.explanation = '原曲との差が急変した約' + (used * this.size / this.rate).toFixed(2) + '秒だけ音量を補修しました。';
  }
  get applied() { return this.corrections.some(gain => gain !== 0); }
  renderer() {
    let offset = 0;
    const gains = this.corrections.map(db => 10 ** (db/20) - 1);
    return (audio: AudioData) => {
      for (let i=0; i<audio.channels[0].length; i++, offset++) {
        const j = Math.floor(offset / this.size), x = offset % this.size, g = gains[j];
        if (!g) continue;
        const edge = (n: number) => g * (gains[n] ?? 0) > 0 ? Math.sign(g) * Math.min(Math.abs(g), Math.abs(gains[n])) : 0;
        const ramp = Math.max(1, Math.round(this.rate * 0.005));
        const gain = 1 + g + (edge(j - 1) - g) * Math.max(0, 1 - x / ramp) + (edge(j + 1) - g) * Math.max(0, 1 - (this.size - 1 - x) / ramp);
        for (const channel of audio.channels) channel[i] *= gain;
      }
    };
  }
}
