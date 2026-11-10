import { TrebleRepair, type TrebleMode, type TrebleRepairReport } from './treble-repair.js';
import type { RepairControls } from './studio-settings.js';
import type { AudioData } from '@music-sync/shared';

/** Compare the full selected chain against dry PCM, retaining both measurements. */
export class FinishRepair {
  private simplified = false;
  private stages: TrebleRepair[];
  private active: TrebleRepair[] = [];
  constructor(rate: number, channels: number, mode: TrebleMode, settings?: RepairControls) {
    this.stages = [new TrebleRepair(rate, channels, mode, settings)];
    if (settings?.grain && settings.grain !== 'off') this.stages.unshift(new TrebleRepair(rate, channels, settings.grain, settings, true));
  }
  get needsAnalysis() { return this.stages.some(stage => stage.needsAnalysis); }
  analyze(audio: AudioData) { this.stages.forEach(stage => stage.analyze(audio)); }
  plan() { this.active = this.stages.filter(stage => stage.plan()); return this.active.length > 0; }
  renderer() {
    const filters = this.active.map(stage => stage.renderer());
    return (audio: AudioData) => filters.forEach(filter => filter(audio));
  }
  measure(audio: AudioData) { this.active.forEach(stage => stage.measure(audio)); }
  previewer() {
    const combined = this.renderer();
    const singles = this.active.length > 1 ? this.active.map(stage => ({ stage, filter: stage.renderer() })) : [];
    return (owned: AudioData) => {
      for (const {stage, filter} of singles) {
        const copy = { ...owned, channels: owned.channels.map(ch => ch.slice()) };
        filter(copy); stage.measureAlone(copy);
      }
      combined(owned); this.measure(owned);
    };
  }
  evaluate() {
    if (!this.active.length) return false;
    if (this.active.map(stage => stage.evaluate()).every(Boolean)) return true;
    if (this.active.length > 1) {
      const single = this.active.find(stage => stage.evaluate(true));
      if (single) { this.active = [single]; this.simplified = true; return true; }
    }
    return false;
  }
  releaseMeasurements() { this.stages.forEach(stage => stage.releaseMeasurements()); }
  get report(): TrebleRepairReport {
    if (this.stages.length === 1) return this.stages[0].report;
    if (this.active.some(stage => stage.report.status === 'reverted')) return { ...this.stages[0].report, status: 'reverted', seconds: 0, highReductionDb: 0, clarityUsed: false, explanation: 'ざらつき・高域補修の組み合わせを測定し、補修を見送りました。' };
    const reports = this.active.map(stage => stage.report);
    return { ...(reports[0] ?? this.stages[0].report), clarityUsed: reports.some(r => r.clarityUsed),
      explanation: reports.length ? reports.map(r => r.explanation).join(' ') + (this.simplified ? ' 併用時の変化が大きいため、単独で検証した補修だけを使いました。' : '') : 'ざらつき・高域補修が必要な区間は見つかりませんでした。' };
  }
}
