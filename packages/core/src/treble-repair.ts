import { TrebleAnalyzer } from '@music-sync/audio-analysis';
import { createTrebleFilter } from '@music-sync/dsp';
import type { AudioData } from '@music-sync/shared';

import { bounded, type RepairControls } from './studio-settings.js';
const grainDepths = { off: 0, auto: 1.8, light: 1, standard: 2, strong: 3 } as const;
const depths = { off: 0, auto: 3, light: 1.5, standard: 3.5, strong: 5 } as const;
export type TrebleMode = keyof typeof depths;
export interface TrebleRepairReport {
  mode: TrebleMode; status: 'skipped' | 'applied' | 'reverted'; seconds: number;
  highReductionDb: number; clarityUsed: boolean; explanation: string;
}
const db = (after: number, before: number) => 10 * Math.log10((after + 1e-18) / (before + 1e-18));

/** One original analysis and an independent measurement of the proposed repair. */
export class TrebleRepair {
  private original?: TrebleAnalyzer;
  private alone?: TrebleAnalyzer;
  private candidate?: TrebleAnalyzer;
  private cut = new Float32Array(0);
  private lift = new Float32Array(0);
  private planned = false;
  report: TrebleRepairReport;
  private depth: number;
  private center: number;
  private boost: number;
  constructor(private rate: number, private channels: number, private mode: TrebleMode, private controls: RepairControls = {}, private grain = false) {
    if (!Object.hasOwn(depths, mode)) throw new Error('不明な高域補修モードです。');
    this.center = grain ? 4050 : bounded(controls.hissHz ?? 9000, 7000, 11000);
    this.depth = grain ? grainDepths[mode] * bounded(controls.amount ?? 100, 0, 100) / 100 : Math.min(depths[mode], bounded(controls.hissDb ?? depths[mode], 0, 6));
    this.boost = grain ? 0 : bounded(controls.clarityDb ?? 1, 0, 3.5);
    this.report = { mode, status: 'skipped', seconds: 0, highReductionDb: 0, clarityUsed: false,
      explanation: mode === 'off' ? '高域補修はオフです。' : rate < 24000 ? 'このサンプルレートでは高域補修を見送りました。' : '持続する高域のざらつきが明確でないため、追加の高域補修を見送りました。' };
    if (mode !== 'off' && rate >= 24000 && this.center <= rate * 0.45) this.original = new TrebleAnalyzer(rate, channels, this.center);
  }
  get needsAnalysis() { return !!this.original; }
  analyze(audio: AudioData) { this.original?.push(audio); }
  plan() {
    if (this.planned) throw new Error('高域補修の計画は作成済みです。');
    this.planned = true;
    const scan = this.original;
    if (!scan) return false;
    const frames = scan.frames;
    this.cut = new Float32Array(frames.length); this.lift = new Float32Array(frames.length);
    const guard = Math.ceil(0.1 * this.rate / scan.size);
    let run = 0;
    for (let i = 0; i <= frames.length; i++) {
      const f = frames[i];
      const stable = f && !f.transient && f.flatness >= 0.4 && f.high > 1e-8 &&
        f.high > 0.012 * (f.body + f.presence) && f.presence < 0.5 * Math.max(1e-8, f.body) &&
        (!run || Math.abs(db(f.high, frames[i - 1].high)) <= 3);
      if (stable) { run++; continue; }
      if (run * scan.size >= 0.38 * this.rate) {
        for (let j = i - run + guard; j < i - guard; j++) {
          const a = frames[j], ratio = a.high / Math.max(1e-10, a.body + a.presence);
          // Decaying cymbals and rising attacks can span many individually stable frames.
          if (Math.abs(db(frames[j + guard].high, frames[j - guard].high)) > 2) continue;
          this.cut[j] = this.mode === 'off' || this.depth === 0 ? 0 : Math.min(1, Math.max(0.35, ratio * 4));
          if (this.boost > 0 && a.body > 1e-6 && a.presence < a.body * 0.02 && ratio < 0.5) this.lift[j] = this.controls.autoClarity === false ? 1 : Math.max(0.35, this.cut[j]) * 0.7;
        }
      }
      run = 0;
    }
    // A quiet but measurable presence band permits clarity-only repair on stable passages.
    if (!this.grain && this.mode !== 'off' && this.controls.clarityDb !== undefined && this.boost > 0) {
      let count = 0;
      for (let i = 0; i <= frames.length; i++) {
        const f = frames[i];
        if (f && !f.transient && f.body > 1e-6 && f.presence > f.body * 0.001 &&
          f.presence < f.body * 0.02 && f.high < f.body * 0.04) { count++; continue; }
        if (count > 2 * guard + 4) for (let j = i - count + guard; j < i - guard; j++)
          this.lift[j] = Math.max(this.lift[j], this.controls.autoClarity === false ? 1 : Math.min(0.7, 1 - frames[j].presence / (0.02 * frames[j].body)));
        count = 0;
      }
    }
    if (!this.cut.some(value => value > 0) && !this.lift.some(value => value > 0)) return false;
    this.candidate = new TrebleAnalyzer(this.rate, this.channels, this.center);
    return true;
  }
  renderer() {
    if (!this.candidate || !this.original) throw new Error('高域補修の候補がありません。');
    return createTrebleFilter(this.rate, this.channels, this.original.size, this.cut, this.lift, this.depth, this.center, this.boost);
  }
  measureAlone(audio: AudioData) {
    this.alone ??= new TrebleAnalyzer(this.rate, this.channels, this.center);
    this.alone.push(audio);
  }
  releaseMeasurements() { this.alone = undefined; if (this.original) this.original.frames.length = 0; if (this.candidate) this.candidate.frames.length = 0; }
  measure(audio: AudioData) { this.candidate?.push(audio); }
  evaluate(alone = false): boolean {
    const a = this.original, b = alone ? this.alone : this.candidate;
    if (!a || !b || !this.planned) return false;
    let highBefore = 0, highAfter = 0, treated = 0, safe = a.frames.length === b.frames.length;
    for (let i = 0; safe && i < a.frames.length; i++) {
      const before = a.frames[i], after = b.frames[i];
      if (!Number.isFinite(after.peak) || (after.peak >= 1 && after.peak > before.peak)) safe = false;
      if (!this.cut[i] && !this.lift[i]) {
        if (before.high > 1e-10 && Math.abs(db(after.high, before.high)) > 0.1) safe = false;
        continue;
      }
      if (this.cut[i]) { highBefore += before.high; highAfter += after.high; }
      treated++;
      const presence = db(after.presence, before.presence);
      if ((before.presence > 1e-9 && (presence < -1.5 || presence > Math.max(1, this.boost) + 0.1)) ||
        (before.body > 1e-9 && Math.abs(db(after.body, before.body)) > 0.8) ||
        db(after.high, before.high) < -this.depth - 0.2) safe = false;
    }
    const reduction = -db(highAfter, highBefore);
    safe &&= treated > 0 && Number.isFinite(reduction) && (this.cut.some(v => v > 0) ? reduction >= 0.2 : b.frames.some((f, i) => this.lift[i] && f.presence > 1e-9 && db(f.presence, a.frames[i].presence) > 0.15));
    this.report = { ...this.report, status: safe ? 'applied' : 'reverted',
      seconds: safe ? treated * a.size / this.rate : 0, highReductionDb: safe ? reduction : 0,
      clarityUsed: safe && this.lift.some(value => value > 0),
      explanation: safe ? (this.grain ? '中高域のざらつきを約' : this.cut.some(v => v > 0) ? '持続する高域のざらつきを約' : '高域の明瞭さを約') + (treated * a.size / this.rate).toFixed(1) + (this.cut.some(v => v > 0) ? '秒で抑えました。' : '秒で整えました。') +
        (this.lift.some(value => value > 0) ? '明瞭さが弱い箇所には軽い補正を加えました。' : '') :
        '高域補修の効果または明瞭さの保護を確認できず、補修を外しました。' };
    return safe;
  }
}
