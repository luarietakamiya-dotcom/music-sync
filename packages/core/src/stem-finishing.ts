import { validateAudio, type AudioData } from '@music-sync/shared';
import { planStemMix, type StemMixReport, type StemMixResult } from './stems.js';
import { autoMixMaster, type AutoFinishOptions } from './auto/engine.js';
import type { AutoMode } from './auto/mix-planner.js';
import { resolveStemGrainRestoration } from './stem-restoration-policy.js';
import { masterAudio, type MasteringOptions } from './mastering.js';

/** Preserve pre-sum source evidence: attenuation cannot repair clipped sources. */
function validateSourceMix(audio: AudioData, report: StemMixReport): void {
  validateAudio(audio);
  if (!report || report.version !== 1 || !report.plan || !Array.isArray(report.tracks)) throw new Error('STEMの品質情報が不正です。');
  const plan = planStemMix(report.plan.tracks, report.plan.mode);
  if (audio.sampleRate !== plan.sampleRate || audio.channels.length !== 2 || audio.channels[0].length !== plan.frames || report.tracks.length !== plan.tracks.length)
    throw new Error('STEMの品質情報と合成音声が一致しません。');
  for (const [i, track] of report.tracks.entries()) {
    const descriptor = plan.tracks[i], analysis = track?.analysis;
    if (!analysis || track.descriptor.id !== descriptor.id || track.descriptor.muted !== descriptor.muted ||
      analysis.sampleRate !== descriptor.sampleRate || analysis.frames !== descriptor.frames || analysis.channels !== descriptor.channels ||
      !Number.isInteger(analysis.clippedSamples) || analysis.clippedSamples < 0 || analysis.clippedSamples > descriptor.frames * descriptor.channels)
      throw new Error('STEMの素材解析が不正です。');
    if (!descriptor.muted && analysis.clippedSamples > 0)
      throw new Error('元のSTEMにクリッピングがあります。歪みを復元できないため自動採用を保留します。');
  }
}

/** Preferred automatic entry point for a STEM mix, in both Web and external apps. */
export function finishStemMix(mix: Pick<StemMixResult, 'audio' | 'report'>, mode: AutoMode = 'AUTO', options: AutoFinishOptions = {}) {
  if (options.signal?.aborted) throw new Error('Processing cancelled');
  validateSourceMix(mix.audio, mix.report);
  const decision = resolveStemGrainRestoration(mix.report, options.repairControls);
  const result = autoMixMaster(mix.audio, mode, { ...options, repairControls: decision.controls,
    treble:decision.suppressTreble ? 'off' : options.treble });
  if (decision.report) { result.grain = decision.report; result.explanations = [decision.report.explanation, ...result.explanations]; }
  if (decision.preservationExplanation) {
    if (!result.explanations.includes(decision.preservationExplanation)) result.explanations.unshift(decision.preservationExplanation);
    if (result.treble) result.treble = {...result.treble,explanation:decision.preservationExplanation};
  }
  return { ...result, sourceMix: mix.report };
}

/** Numeric mastering uses the same source-quality policy as automatic finishing. */
export function masterStemMix(mix: Pick<StemMixResult, 'audio' | 'report'>, options: MasteringOptions, onProgress?: (fraction: number) => void) {
  validateSourceMix(mix.audio, mix.report);
  return { ...masterAudio(mix.audio, options, onProgress), sourceMix: mix.report };
}
