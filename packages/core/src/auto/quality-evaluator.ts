import type { AnalysisResult } from '@music-sync/shared';
import type { AdaptiveFeatures } from '@music-sync/audio-analysis';
import type { AutoMode } from './mix-planner.js';

export interface QualityEvaluation { accepted: boolean; reasons: string[] }
/** Technical degradation proxies, not a guarantee of subjective improvement. */
export function evaluateAutoQuality(before: AnalysisResult, after: AnalysisResult, a: AdaptiveFeatures, b: AdaptiveFeatures,
  mode: AutoMode, reductionDb: number): QualityEvaluation {
  const reasons: string[] = [];
  const featureValues = [b.dynamicRangeDb, b.sustainRatio, b.channelBalanceDb, b.negativeCorrelationFraction, ...Object.values(b.bandEnergy)];
  if (!featureValues.every(Number.isFinite) || [after.crestFactorDb, after.stereoCorrelation, after.sideEnergyPercent].some(x => x !== null && !Number.isFinite(x)))
    reasons.push('特徴量が不正です。');
  if (after.integratedLufs === null || after.rmsDbfs === null || after.truePeakDbtp === null || after.samplePeakDbfs === null ||
    ![after.integratedLufs, after.rmsDbfs, after.truePeakDbtp, after.samplePeakDbfs, reductionDb].every(Number.isFinite)) reasons.push('処理後の測定値が不正です。');
  if ((after.truePeakDbtp ?? Infinity) > -1 + 0.0001 || after.clippedSamples !== 0) reasons.push('ピーク保護条件を満たしません。');
  if (after.frames !== before.frames || after.channels !== before.channels || after.sampleRate !== before.sampleRate) reasons.push('音源の長さ・形式が変化しました。');
  if (after.integratedLufs !== null && before.integratedLufs !== null && (after.integratedLufs - before.integratedLufs > 6.5 || before.integratedLufs - after.integratedLufs > 12.5)) reasons.push('音量の変化が大きすぎます。');
  if (after.rmsDbfs !== null && before.rmsDbfs !== null && (after.rmsDbfs - before.rmsDbfs > 6.5 || before.rmsDbfs - after.rmsDbfs > 12.5)) reasons.push('平均音量の変化が大きすぎます。');
  if (reductionDb > 3) reasons.push('ピークを抑える量が3 dBを超えました。');
  if (before.crestFactorDb !== null && after.crestFactorDb !== null && before.crestFactorDb - after.crestFactorDb > (mode === 'IMPACT' ? 2 : 1.5)) reasons.push('音の強弱を抑えすぎています。');
  if (a.dynamicRangeDb - b.dynamicRangeDb > 2) reasons.push('音量の抑揚が小さくなりすぎました。');
  if (after.dcOffset.length !== after.channels || after.dcOffset.some((x, i) => !Number.isFinite(x) || Math.abs(x) > Math.max(0.003, Math.abs(before.dcOffset[i]) + 0.001))) reasons.push('DCオフセットが悪化しました。');
  if (before.stereoCorrelation !== null && (after.stereoCorrelation === null || after.stereoCorrelation < before.stereoCorrelation - (mode === 'LIVE' ? 0.12 : 0.06))) reasons.push('ステレオの安定性が下がりました。');
  if (b.negativeCorrelationFraction > a.negativeCorrelationFraction + 0.05) reasons.push('逆相になる区間が増えました。');
  if ((after.sideEnergyPercent ?? 0) > (before.sideEnergyPercent ?? 0) + (mode === 'LIVE' ? 6 : 4) ||
    (before.sideEnergyPercent ?? 0) - (after.sideEnergyPercent ?? 0) > 12) reasons.push('広がりの変化が大きすぎます。');
  if (Math.abs(b.channelBalanceDb) > Math.abs(a.channelBalanceDb) + 0.5) reasons.push('左右の偏りが増えました。');
  if (b.bandEnergy.bass > a.bandEnergy.bass + 0.06 || b.bandEnergy.highMid + b.bandEnergy.air > a.bandEnergy.highMid + a.bandEnergy.air + 0.06)
    reasons.push('低域または高域の偏りが増えました。');
  if (a.bandEnergy.presence > 0.15 && b.bandEnergy.presence < a.bandEnergy.presence * 0.7) reasons.push('主要な中域が後退しました。');
  return { accepted: reasons.length === 0, reasons };
}
