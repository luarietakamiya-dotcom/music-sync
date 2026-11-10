import { analyzeAudio } from '@music-sync/audio-analysis';
import { defaultProcessingChain, processAudio, renderSoundColor, type ProcessingResult, type SoundColorParameters } from '@music-sync/dsp';
import { validateAudio, type AudioData, type AnalysisResult } from '@music-sync/shared';
import { planSoundColor, validateSoundColorSelection, SOUND_COLOR_PRESETS, type SoundColorSelection } from './sound-color-presets.js';

export interface SoundColorAttempt { amountScale: number; plan: SoundColorParameters; after: AnalysisResult; reasons: string[] }
export interface SoundColorResult {
  version: 1; selection: SoundColorSelection; status: 'accepted' | 'rejected'; before: AnalysisResult;
  attempts: SoundColorAttempt[]; explanations: string[]; reasons: string[]; processed?: ProcessingResult;
}
export interface SoundColorOptions { signal?: AbortSignal; onProgress?: (fraction: number) => void }
export const SOUND_COLOR_POLICY = Object.freeze({ maxIterations: 3, maxInputBytes: 96 * 1024 * 1024, ceilingDb: -1 });
/** Intent-aware gate: deliberate colour/mono/noise are allowed; physical safety is not waived. */
export function evaluateSoundColorQuality(before: AnalysisResult, after: AnalysisResult, reductionDb: number, neutral = false): string[] {
  const reasons: string[] = [];
  if (after.frames !== before.frames || after.channels !== before.channels || after.sampleRate !== before.sampleRate) reasons.push('長さ・音声形式が変化しました。');
  const metrics = [after.integratedLufs, after.truePeakDbtp, after.samplePeakDbfs, after.rmsDbfs, after.crestFactorDb];
  if (metrics.some(x => x === null || !Number.isFinite(x)) || !Number.isFinite(reductionDb)) reasons.push('比較に必要な測定値を確認できません。');
  if (!neutral && (after.truePeakDbtp ?? Infinity) > SOUND_COLOR_POLICY.ceilingDb + 0.0001 || after.clippedSamples !== 0) reasons.push('ピーク保護条件を満たしません。');
  if (reductionDb > 4) reasons.push('ピークを抑える量が大きすぎます。');
  if (before.crestFactorDb !== null && after.crestFactorDb !== null && before.crestFactorDb - after.crestFactorDb > 4) reasons.push('音の強弱を抑えすぎています。');
  for (const [a, b] of [[before.integratedLufs, after.integratedLufs], [before.rmsDbfs, after.rmsDbfs]]) {
    if (a !== null && b !== null && (b - a > 6 || a - b > 24)) reasons.push('音量の変化が大きすぎます。');
  }
  if (after.dcOffset.length !== after.channels || after.dcOffset.some((x, c) => !Number.isFinite(x) || Math.abs(x) > Math.max(0.003, Math.abs(before.dcOffset[c]) + 0.001))) reasons.push('DCオフセットが悪化しました。');
  if (after.channels === 2 && (after.stereoCorrelation === null || !Number.isFinite(after.stereoCorrelation) ||
    after.stereoCorrelation < (before.stereoCorrelation ?? 0) - 0.1 || after.sideEnergyPercent === null || !Number.isFinite(after.sideEnergyPercent) || after.sideEnergyPercent > (before.sideEnergyPercent ?? 0) + 8)) reasons.push('ステレオの安定性が悪化しました。');
  return [...new Set(reasons)];
}
/** Sequential retries always start from input. Caller retains A and prior B on rejection. */
export function applySoundColor(input: AudioData, selection: SoundColorSelection, options: SoundColorOptions = {}): SoundColorResult {
  validateAudio(input); validateSoundColorSelection(selection);
  if (input.channels.reduce((n, c) => n + c.byteLength, 0) > SOUND_COLOR_POLICY.maxInputBytes) throw new Error('音色処理は展開後96 MiBまでです。');
  const progress = (fraction: number) => {
    if (options.signal?.aborted) throw new Error('Processing cancelled');
    options.onProgress?.(fraction);
    if (options.signal?.aborted) throw new Error('Processing cancelled');
  };
  progress(0);
  const before = analyzeAudio(input), neutral = selection.preset === 'none';
  const result: SoundColorResult = { version: 1, selection: { ...selection }, status: 'rejected', before, attempts: [], explanations: [], reasons: [] };
  if (before.integratedLufs === null || before.clippedSamples) {
    result.reasons = ['無音・短い音源、または元音源のクリッピングがあるため候補を保留します。']; progress(1); return result;
  }
  for (const [iteration, amountScale] of [1, 0.5, 0.25].entries()) {
    progress(0.05 + iteration * 0.3);
    const plan = planSoundColor(before, selection, amountScale);
    const coloured = renderSoundColor(input, plan, f => progress(0.05 + iteration * 0.3 + f * 0.15));
    const chain = defaultProcessingChain(); chain.bypass = neutral;
    // No forced loudness target: this is a timbre choice, with peak protection only.
    const processed = processAudio(coloured, chain);
    progress(0.23 + iteration * 0.3);
    const after = analyzeAudio(processed.audio);
    const reasons = evaluateSoundColorQuality(before, after, processed.maxReductionDb - processed.peakGuardDb, neutral);
    result.attempts.push({ amountScale, plan, after, reasons }); result.reasons = reasons;
    if (!reasons.length) {
      result.status = 'accepted'; result.processed = processed;
      result.explanations = [SOUND_COLOR_PRESETS[selection.preset].description];
      if (iteration) result.explanations.push('測定条件に合わせ、選んだ音色の効果を弱めました。');
      progress(1); return result;
    }
  }
  progress(1); return result;
}
