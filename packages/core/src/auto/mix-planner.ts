import type { AnalysisResult } from '@music-sync/shared';
import type { AdaptiveFeatures } from '@music-sync/audio-analysis';
import type { MixStage } from '@music-sync/dsp';
import { detectProblems, type AudioProblems } from './problem-detector.js';
import { planLiveSound, LIVE_SPACES, type LiveSelection } from './live-strategy.js';
import type { PerceptualFeatures } from '@music-sync/audio-analysis';
import { refinePerceptualPlan, type PerceptualDecisionReport } from './perceptual-decisions.js';

export const AUTO_MODES = Object.freeze({
  AUTO: Object.freeze({ label: 'AUTO / NATURAL', targetLufs: -16, maxLiftLu: 4, punchDb: 0, width: 1 }),
  IMPACT: Object.freeze({ label: 'IMPACT', targetLufs: -13, maxLiftLu: 6, punchDb: 1, width: 1.06 }),
  LIVE: Object.freeze({ label: 'LIVE', targetLufs: -16, maxLiftLu: 3, punchDb: 0.25, width: 1.03 }),
});
export type AutoMode = keyof typeof AUTO_MODES;
export interface MixCorrectionPlan {
  version: 1; mode: AutoMode; strength: number; stages: MixStage[]; problems: AudioProblems; explanations: string[];
  perceptual?: PerceptualDecisionReport;
  liveSelection?: LiveSelection;
}
export function planMixCorrection(report: AnalysisResult, features: AdaptiveFeatures, mode: AutoMode, strength = 1, perceptual?: PerceptualFeatures, liveSelection?: LiveSelection): MixCorrectionPlan {
  if (!Object.hasOwn(AUTO_MODES, mode) || !Number.isFinite(strength) || strength <= 0 || strength > 1) throw new Error('Invalid auto mode/strength');
  const config = AUTO_MODES[mode], problems = detectProblems(report, features), stages: MixStage[] = [], explanations: string[] = [];
  const eq = (frequencyHz: number, gainDb: number, text: string) => {
    stages.push({ kind: 'eq', frequencyHz: Math.min(frequencyHz, report.sampleRate * 0.4), gainDb: gainDb * strength, q: 0.7 }); explanations.push(text);
  };
  if (problems.dc) { stages.push({ kind: 'dc' }); explanations.push('音の中心のずれ（DC）を取り除きました。'); }
  if (problems.bassExcess) eq(120, -2.4, '低域が前に出すぎないよう、控えめに整理しました。');
  else if (problems.muddy) eq(300, -1.8, '低音まわりの濁りを抑える補正を加えました。');
  if (problems.harsh) eq(3800, -2, '高域の刺さりを抑える補正を加えました。');
  else if (problems.presenceDeficit && mode !== 'LIVE') eq(1800, 0.8, '音の輪郭が出る帯域を少し補いました。');
  if (mode === 'IMPACT' && !problems.dense && !problems.harsh && !problems.presenceDeficit)
    eq(2000, 0.6, '存在感を支える帯域を少し補いました。');
  if (problems.imbalance) {
    const attenuation = -Math.min(1.5, Math.abs(features.channelBalanceDb) * 0.25) * strength;
    stages.push({ kind: 'balance', leftDb: features.channelBalanceDb > 0 ? attenuation : 0, rightDb: features.channelBalanceDb < 0 ? attenuation : 0 });
    explanations.push('左右の音量差を控えめに整えました。');
  }
  const width = problems.wide || problems.unstableStereo ? 1 - 0.15 * strength
    : !problems.centerFocused && !problems.spaceRisk ? 1 + (config.width - 1) * strength : 1;
  if (report.channels === 2 && width !== 1) { stages.push({ kind: 'width', amount: width, crossoverHz: 220 }); explanations.push(width < 1 ? '低域を保ちながら、広がりすぎた成分を控えました。' : '低域を広げずに、上の帯域の広がりを少し加えました。'); }
  if (!problems.dense && report.rmsDbfs !== null) {
    const compression = features.dynamicRangeDb > 12 ? 1.2 * strength : 0;
    const punch = (report.crestFactorDb ?? 0) < 14 ? config.punchDb * strength : 0;
    if (compression || punch) {
      stages.push({ kind: 'dynamics', compressionDb: compression, punchDb: punch, referenceRms: Math.max(1e-8, 10 ** (report.rmsDbfs / 20)) });
      explanations.push(punch ? '抑えすぎない範囲で、音の立ち上がりを少し強調しました。' : '大きな音量の揺れを軽く整えました。');
    }
  }
  if (mode === 'LIVE') {
    const parameters = planLiveSound(problems, strength, liveSelection);
    stages.push({ kind: 'live', parameters });
    explanations.push(liveSelection ? `${LIVE_SPACES[liveSelection.venue].label}の初期反射と、客席へ広がる会場の響き・奥行きを加えました。`
      : parameters.venue === 'intimate-room' ? '音の持続や広がりを考慮し、短い会場感だけを控えめに加えました。' : '原音の手前感を残して、初期反射と小ホールの会場感・奥行きを加えました。');
  }
  if (!stages.length) explanations.push('大きな補正は必要と判断せず、音色と広がりを保ちました。');
  const plan: MixCorrectionPlan = { version: 1, mode, strength, stages, problems, explanations, liveSelection: liveSelection ? { ...liveSelection } : undefined };
  if (perceptual) plan.perceptual = refinePerceptualPlan(plan, perceptual, report.sampleRate);
  return plan;
}
