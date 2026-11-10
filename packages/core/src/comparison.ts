import type { AnalysisResult } from '@music-sync/shared';

export type ComparisonSlot = 'a' | 'b';
export interface MatchPlan {
  readonly available: boolean;
  readonly reason: string | null;
  readonly gainsDb: Readonly<Record<ComparisonSlot, number>>;
  readonly targetLufs: number | null;
  readonly sharedAttenuationDb: number;
}
export interface ComparisonPlan {
  readonly durationSeconds: number;
  readonly lengthMismatch: boolean;
  readonly rawGainsDb: Readonly<Record<ComparisonSlot, number>>;
  readonly match: MatchPlan;
}

export const COMPARISON_POLICY = Object.freeze({ ceilingDb: -1, maxLoudnessDifferenceLu: 24, rampSeconds: 0.02 });

function validateReport(report: AnalysisResult): void {
  if (!Number.isInteger(report.sampleRate) || report.sampleRate < 8000 || report.sampleRate > 192000 ||
    !Number.isInteger(report.frames) || report.frames < 1 || ![1, 2].includes(report.channels) ||
    !Number.isFinite(report.durationSeconds) || Math.abs(report.durationSeconds - report.frames / report.sampleRate) > 1e-6)
    throw new Error('比較する解析結果の形式が不正です。');
  for (const metric of [report.integratedLufs, report.samplePeakDbfs, report.truePeakDbtp]) {
    if (metric !== null && (!Number.isFinite(metric) || metric < -1000 || metric > 100))
      throw new Error('比較する解析値が範囲外です。');
  }
  if (report.integratedLufs !== null && (report.samplePeakDbfs === null || report.truePeakDbtp === null))
    throw new Error('音量補正に必要なピーク値がありません。');
}

function peak(report: AnalysisResult): number {
  return Math.max(report.samplePeakDbfs ?? -Infinity, report.truePeakDbtp ?? -Infinity);
}

/** Monitoring gains only. Does not process PCM or change source reports. */
export function createComparisonPlan(a: AnalysisResult, b: AnalysisResult): ComparisonPlan {
  validateReport(a); validateReport(b);
  if (a.sampleRate !== b.sampleRate) throw new Error('A/B比較には同じサンプルレートの音源を選んでください。');
  if (a.channels !== b.channels) throw new Error('A/B比較には同じチャンネル数の音源を選んでください。');
  const commonRaw = Math.min(0, COMPARISON_POLICY.ceilingDb - Math.max(peak(a), peak(b)));
  const rawGainsDb = { a: commonRaw, b: commonRaw };
  let reason: string | null = null;
  if (a.integratedLufs === null || b.integratedLufs === null)
    reason = '無音・短い音源など、LUFSを測定できない音源があるため音量補正は利用できません。';
  else if (Math.abs(a.integratedLufs - b.integratedLufs) > COMPARISON_POLICY.maxLoudnessDifferenceLu)
    reason = '音量差が24 LUを超えるため自動補正を無効にしました。音源を確認してください。';
  let match: MatchPlan;
  if (reason) {
    match = { available: false, reason, gainsDb: rawGainsDb, targetLufs: null, sharedAttenuationDb: commonRaw };
  } else {
    const target = Math.min(a.integratedLufs!, b.integratedLufs!);
    const aGain = target - a.integratedLufs!, bGain = target - b.integratedLufs!;
    const common = Math.min(0, COMPARISON_POLICY.ceilingDb - Math.max(peak(a) + aGain, peak(b) + bGain));
    match = { available: true, reason: null, gainsDb: { a: aGain + common, b: bGain + common },
      targetLufs: target + common, sharedAttenuationDb: common };
  }
  return { durationSeconds: Math.min(a.frames, b.frames) / a.sampleRate,
    lengthMismatch: a.frames !== b.frames, rawGainsDb, match };
}

export function singleSourceGainDb(report: AnalysisResult): number {
  validateReport(report);
  return Math.min(0, COMPARISON_POLICY.ceilingDb - peak(report));
}
