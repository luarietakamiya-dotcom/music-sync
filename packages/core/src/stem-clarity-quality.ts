import type { AnalysisResult } from '@music-sync/shared';
import type { StemClarityReport } from './stem-clarity.js';

/** Both meters use one shared constant attenuation, so comparisons retain the mix dynamics. */
export function evaluateStemClarityQuality(before: AnalysisResult, after: AnalysisResult, strength: number, levels = { beforeGain: 1, afterGain: 1, measurementGain: 1 }): NonNullable<StemClarityReport['evaluation']> {
  const reasons: string[] = [];
  const headroomGainChangeDb = 20 * Math.log10(levels.afterGain / levels.beforeGain);
  if (Object.values(levels).some(value => !Number.isFinite(value) || value <= 0)) reasons.push('検証用のゲインが不正です。');
  const rmsChangeDb = before.rmsDbfs !== null && after.rmsDbfs !== null ? after.rmsDbfs - before.rmsDbfs + headroomGainChangeDb : NaN;
  const correlationChange = before.stereoCorrelation !== null && after.stereoCorrelation !== null ? after.stereoCorrelation - before.stereoCorrelation : null;
  if (!Number.isFinite(rmsChangeDb) || rmsChangeDb < -1.5 || rmsChangeDb > 0.15) reasons.push('ミックス全体の平均音量が変化しすぎました。');
  if (before.frames !== after.frames || before.sampleRate !== after.sampleRate || before.channels !== after.channels) reasons.push('音源の長さ・形式が変わりました。');
  if (before.crestFactorDb === null || after.crestFactorDb === null || before.crestFactorDb - after.crestFactorDb > 1)
    reasons.push('立ち上がりの強弱が減りすぎました。');
  if (correlationChange !== null && correlationChange < -0.04) reasons.push('ステレオの安定性が低下しました。');
  if (Math.abs((after.sideEnergyPercent ?? 0) - (before.sideEnergyPercent ?? 0)) > 3) reasons.push('ステレオの広がりが変化しすぎました。');
  if (after.dcOffset.some((value,c) => !Number.isFinite(value) || Math.abs(value * levels.afterGain / levels.measurementGain) > Math.max(0.003, Math.abs(before.dcOffset[c] * levels.beforeGain / levels.measurementGain) + 0.001)))
    reasons.push('DCオフセットが増えました。');
  return { accepted: reasons.length === 0, strength, rmsChangeDb, headroomGainChangeDb, correlationChange, reasons };
}
