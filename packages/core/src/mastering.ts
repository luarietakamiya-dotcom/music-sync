import { analyzeAudio } from '@music-sync/audio-analysis';
import { defaultProcessingChain, processAudio, type ProcessingChain, type ProcessingResult } from '@music-sync/dsp';
import type { AudioData, AnalysisResult } from '@music-sync/shared';
import { createComparisonPlan } from './comparison.js';

export interface MasteringOptions { targetLufs: number; ceilingDb: number }
export const MASTERING_POLICY = Object.freeze({ targetToleranceLu: 0.5, maxReductionDb: 3,
  maxCrestLossDb: 3, maxCorrelationChange: 0.05, maxDcOffset: 0.05, minGainDb: -24, maxGainDb: 12 });
export interface MasteringPlan {
  version: 1;
  available: boolean;
  options: MasteringOptions;
  requestedGainDb: number | null;
  chain: ProcessingChain;
  reasons: string[];
}
export type MasteringResult = {
  status: 'accepted' | 'rejected';
  plan: MasteringPlan;
  before: AnalysisResult;
  after: AnalysisResult | null;
  reasons: string[];
  /** Present only when every quality gate passes. Rejected candidate PCM is not exposed. */
  processed?: ProcessingResult;
};
export function validateMasteringOptions(options: MasteringOptions): void {
  if (!options || !Number.isFinite(options.targetLufs) || options.targetLufs < -24 || options.targetLufs > -9 ||
    !Number.isFinite(options.ceilingDb) || options.ceilingDb < -6 || options.ceilingDb > -0.5)
    throw new Error('自動マスタリングの範囲は目標 -24〜-9 LUFS、上限 -6〜-0.5 dBです。');
}
/** Advisory plan from measured input; masterAudio always re-measures actual PCM. */
export function planMastering(report: AnalysisResult, options: MasteringOptions): MasteringPlan {
  validateMasteringOptions(options);
  createComparisonPlan(report, report);
  const chain = defaultProcessingChain(); chain.limiter.ceilingDb = options.ceilingDb;
  const reasons: string[] = [];
  if (report.integratedLufs === null) reasons.push('LUFSを測定できないため処理を保留します（無音・短い音源など）。');
  if (!Number.isInteger(report.clippedSamples) || report.clippedSamples < 0 || report.clippedSamples > report.frames * report.channels ||
    report.dcOffset.length !== report.channels || report.dcOffset.some(x => !Number.isFinite(x)) ||
    (report.crestFactorDb !== null && !Number.isFinite(report.crestFactorDb)) ||
    (report.stereoCorrelation !== null && (!Number.isFinite(report.stereoCorrelation) || Math.abs(report.stereoCorrelation) > 1)))
    throw new Error('品質判定に必要な解析値が不正です。');
  if (report.clippedSamples > 0) reasons.push('0 dBFS以上のサンプルがあります。自動処理では歪みを復元できないため保留します。');
  if (report.dcOffset.some(x => Math.abs(x) > MASTERING_POLICY.maxDcOffset)) reasons.push('DCオフセットが大きいため保留します。');
  const requestedGainDb = report.integratedLufs === null ? null : options.targetLufs - report.integratedLufs;
  if (requestedGainDb !== null) {
    chain.gainDb = Math.max(MASTERING_POLICY.minGainDb, Math.min(MASTERING_POLICY.maxGainDb, requestedGainDb));
    if (requestedGainDb < MASTERING_POLICY.minGainDb || requestedGainDb > MASTERING_POLICY.maxGainDb)
      reasons.push('必要なゲインが -24〜+12 dBを超えるため保留します。');
    const peak = Math.max(report.samplePeakDbfs ?? -Infinity, report.truePeakDbtp ?? -Infinity);
    if (Math.abs(requestedGainDb) <= MASTERING_POLICY.targetToleranceLu && peak <= options.ceilingDb) {
      chain.bypass = true; chain.gainDb = 0;
    }
  }
  return { version: 1, available: reasons.length === 0, options: { ...options }, requestedGainDb, chain, reasons };
}

/** One deterministic render from original PCM. No retry loop or accumulating gain. */
export function masterAudio(input: AudioData, options: MasteringOptions, onProgress?: (fraction: number) => void): MasteringResult {
  validateMasteringOptions(options);
  const before = analyzeAudio(input, { onProgress: f => onProgress?.(f * 0.25) });
  const plan = planMastering(before, options);
  if (!plan.available) { onProgress?.(1); return { status: 'rejected', plan, before, after: null, reasons: plan.reasons }; }
  const processed = processAudio(input, plan.chain, f => onProgress?.(0.25 + f * 0.4));
  const after = analyzeAudio(processed.audio, { onProgress: f => onProgress?.(0.65 + f * 0.35) });
  const reasons: string[] = [];
  if (after.integratedLufs === null || Math.abs(after.integratedLufs - options.targetLufs) > MASTERING_POLICY.targetToleranceLu)
    reasons.push('再測定したLUFSが目標の±0.5 LU以内に届かなかったため採用しません。');
  if (after.truePeakDbtp === null || after.truePeakDbtp > options.ceilingDb + 0.0001 || after.clippedSamples)
    reasons.push('処理後の推定ピークが上限条件を満たしません。');
  if (processed.maxReductionDb - processed.peakGuardDb > MASTERING_POLICY.maxReductionDb)
    reasons.push('リミッターと追加減衰の合計が3 dBを超えたため採用しません。');
  if (before.crestFactorDb !== null && after.crestFactorDb !== null && before.crestFactorDb - after.crestFactorDb > MASTERING_POLICY.maxCrestLossDb)
    reasons.push('クレストファクターの低下が3 dBを超えたため採用しません。');
  if (before.stereoCorrelation !== null && (after.stereoCorrelation === null || Math.abs(before.stereoCorrelation - after.stereoCorrelation) > MASTERING_POLICY.maxCorrelationChange))
    reasons.push('ステレオ相関の変化が大きいため採用しません。');
  if (after.dcOffset.some(x => Math.abs(x) > MASTERING_POLICY.maxDcOffset)) reasons.push('処理後のDCオフセットが大きいため採用しません。');
  onProgress?.(1);
  return reasons.length ? { status: 'rejected', plan, before, after, reasons }
    : { status: 'accepted', plan, before, after, reasons, processed };
}
