import { analyzeAudio, analyzeAdaptiveFeatures, analyzePerceptualFeatures, type PerceptualFeatures, type AdaptiveFeatures } from '@music-sync/audio-analysis';
import { renderMix, processAudio, type ProcessingResult } from '@music-sync/dsp';
import type { AudioData, AnalysisResult } from '@music-sync/shared';
import { AUTO_MODES, planMixCorrection, type AutoMode, type MixCorrectionPlan } from './mix-planner.js';
import { planAutoMastering, type AutoMasteringPlan } from './mastering-planner.js';
import { evaluateAutoQuality, type QualityEvaluation } from './quality-evaluator.js';
import { evaluatePerceptualQuality, type ObjectiveEvaluation } from './objective-quality.js';
import { applySoundColor, evaluateSoundColorQuality, type SoundColorResult } from '../sound-color.js';
import { validateSoundColorSelection, type SoundColorSelection } from '../sound-color-presets.js';
import { DEFAULT_LIVE_SELECTION, validateLiveSelection, type LiveSelection } from './live-strategy.js';
import { applyFinishingPreferences, validateFinishingPreferences, type FinishingPreferences, type PreferenceResult } from '../finishing-preferences.js';

import { applyGrainRestoration, type GrainRestorationReport } from '../grain-restoration.js';
import { FinishRepair } from '../finish-repair.js';
import type { RepairControls } from '../studio-settings.js';
import { type TrebleMode, type TrebleRepairReport } from '../treble-repair.js';
import { applyReferenceFinishing, validateReferenceSelection, type ReferenceSelection, type ReferenceResult } from '../reference-finishing.js';

export const AUTO_ENGINE_LIMITS = Object.freeze({ maxIterations: 3, maxInputBytes: 96 * 1024 * 1024 });
export type AutoStage = 'Analyzing' | 'Creating candidate' | 'Evaluating' | 'Finalizing';
export interface AutoProgress { stage: AutoStage; iteration: number; fraction: number }
export interface AutoAttempt { iteration: number; mix: MixCorrectionPlan; master: AutoMasteringPlan; intermediate: AnalysisResult; after: AnalysisResult; features: AdaptiveFeatures; quality: QualityEvaluation; perceptual: PerceptualFeatures; objectiveQuality: ObjectiveEvaluation }
export interface AutoFinishResult {
  version: 1; mode: AutoMode; status: 'accepted' | 'rejected'; before: AnalysisResult; features: AdaptiveFeatures;
  attempts: AutoAttempt[]; reasons: string[]; explanations: string[]; processed?: ProcessingResult;
  perceptual: PerceptualFeatures;
  soundColor?: Omit<SoundColorResult, 'processed'>;
  grain?: GrainRestorationReport;
  treble?: TrebleRepairReport;
  finalAfter?: AnalysisResult;
  preferences?: Omit<PreferenceResult, 'processed'>;
  reference?: Omit<ReferenceResult, 'processed'>;
}
export interface AutoFinishOptions { treble?: TrebleMode; repairControls?: RepairControls; aggression?: number; maxIterations?: number; signal?: AbortSignal; onProgress?: (progress: AutoProgress) => void; soundColor?: SoundColorSelection; live?: LiveSelection; preferences?: FinishingPreferences; reference?: ReferenceSelection }
/** Bounded, sequential candidate generation. Every retry starts from Original. */
export function autoMixMaster(input: AudioData, mode: AutoMode = 'AUTO', options: AutoFinishOptions = {}): AutoFinishResult {
  const count = options.maxIterations ?? AUTO_ENGINE_LIMITS.maxIterations;
  if (!Object.hasOwn(AUTO_MODES, mode) || !Number.isInteger(count) || count < 1 || count > AUTO_ENGINE_LIMITS.maxIterations) throw new Error('Invalid mode/iteration limit');
  if (options.soundColor) validateSoundColorSelection(options.soundColor);
  if (options.live) validateLiveSelection(options.live);
  if (options.preferences) validateFinishingPreferences(options.preferences);
  if (options.reference) validateReferenceSelection(options.reference);
  const abort = () => { if (options.signal?.aborted) throw new Error('Processing cancelled'); };
  const progress = (stage: AutoStage, iteration: number, fraction: number) => { abort(); options.onProgress?.({ stage, iteration, fraction }); abort(); };
  abort();
  if (input.channels.reduce((sum, c) => sum + c.byteLength, 0) > AUTO_ENGINE_LIMITS.maxInputBytes) throw new Error('自動仕上げは展開後96 MiBまでです。長い音源は分割してください。');
  progress('Analyzing', 0, 0);
  const before = analyzeAudio(input), features = analyzeAdaptiveFeatures(input), perceptual = analyzePerceptualFeatures(input);
  const base: AutoFinishResult = { version: 1, mode, status: 'rejected', before, features, perceptual, attempts: [], reasons: [], explanations: [] };
  if (before.integratedLufs === null || before.rmsDbfs === null) base.reasons.push('無音・短い音源など、比較に必要な音量を測定できません。');
  if (before.clippedSamples) base.reasons.push('0 dBFS以上のサンプルがあります。歪み修復を保証できないため自動採用を保留します。');
  if (base.reasons.length) { progress('Finalizing', 0, 1); return base; }
  const grain = applyGrainRestoration(input, options.repairControls, {signal:options.signal,before});
  let workingInput = grain.audio;
  let grainApplied = grain.report.status === 'applied';
  const grainFeatures = grainApplied ? analyzeAdaptiveFeatures(workingInput) : features;
  const grainPerceptual = grainApplied ? analyzePerceptualFeatures(workingInput) : perceptual;
  if (options.repairControls?.grain && options.repairControls.grain !== 'off') base.grain = grain.report;
  const repair = new FinishRepair(input.sampleRate, input.channels.length, options.treble ?? 'off', { ...options.repairControls, grain: 'off' });
  repair.analyze(workingInput);
  let useRepair = repair.plan();
  if (useRepair) {
    const filter = repair.previewer();
    for (let offset = 0; offset < workingInput.channels[0].length; offset += 65536) {
      abort();
      const chunk = { sampleRate: input.sampleRate, channels: workingInput.channels.map(ch => ch.slice(offset, offset + 65536)) };
      filter(chunk);
    }
    useRepair = repair.evaluate();
  }
  if (options.treble || options.repairControls) base.treble = repair.report;
  for (let iteration = 1; iteration <= count; iteration++) {
    progress('Creating candidate', iteration, 0.1 + (iteration - 1) / count * 0.85);
    // Retry simplifies the chain as well as reducing parameters. Descriptions
    // reflect only the stages actually applied on the final candidate.
    if (iteration > 1 && grainApplied) {
      grainApplied = false; workingInput = input;
      base.grain = { ...grain.report, status:'reverted', seconds:0, estimatedResidualReductionDb:0, explanation:'全体の品質判定に合わせ、ジャリつき補修を外して再調整しました。' };
    }
    const processingFeatures = grainApplied ? grainFeatures : features, processingPerceptual = grainApplied ? grainPerceptual : perceptual;
    const mix = planMixCorrection(before, processingFeatures, mode, [1, 0.5, 0.25][iteration - 1], processingPerceptual, mode === 'LIVE' ? options.live ?? DEFAULT_LIVE_SELECTION : undefined);
    if (iteration > 1) {
      mix.stages = mix.stages.filter(s => s.kind !== 'dynamics' && !(s.kind === 'eq' && s.gainDb > 0));
      if (mix.perceptual) mix.perceptual.decisions = mix.perceptual.decisions.filter(d => d.targetIssue !== 'dullness');
      mix.explanations = ['初回の候補を採用せず、強調と追加ダイナミクスを外して控えめに再調整しました。',
        ...mix.explanations.filter(x => !x.includes('補いました') && !x.includes('立ち上がり') && !x.includes('揺れ'))];
    }
    if (iteration === 3 && base.attempts.some(a => !a.objectiveQuality.accepted)) {
      // No convincing correction benefit: preserve timbre instead of forcing a fix.
      mix.stages = mix.stages.filter(s => s.kind === 'dc' || s.kind === 'balance' || s.kind === 'live');
      mix.perceptual!.skippedProcessing.push('Corrective DSP removed after unproven objective improvement');
      mix.perceptual!.decisions = [];
      mix.explanations = ['音色補正の効果を十分に確認できなかったため、追加の音色・帯域補正を見送りました。',
        ...mix.explanations.filter(x => x.includes('DC') || x.includes('左右') || x.includes('会場') || x.includes('初期反射'))];
    }
    if (iteration > 1 && useRepair) {
      useRepair = false;
      base.treble = { ...repair.report, status: 'reverted', seconds: 0, highReductionDb: 0, clarityUsed: false,
        explanation: '仕上がり全体の再評価で、高域補修を外して作り直しました。' };
    }
    const intermediateAudio = renderMix(workingInput, mix.stages, useRepair ? repair.renderer() : undefined);
    const intermediate = analyzeAudio(intermediateAudio);
    abort();
    if (intermediate.integratedLufs === null) { base.reasons = ['補正後の音量を測定できません。']; break; }
    const master = planAutoMastering(before, intermediate, mode, mix.strength, options.aggression);
    const processed: ProcessingResult = processAudio(intermediateAudio, master.chain);
    progress('Evaluating', iteration, 0.1 + (iteration - 0.3) / count * 0.85);
    const after = analyzeAudio(processed.audio), afterFeatures = analyzeAdaptiveFeatures(processed.audio), afterPerceptual = analyzePerceptualFeatures(processed.audio);
    const quality = evaluateAutoQuality(before, after, processingFeatures, afterFeatures, mode, processed.maxReductionDb - processed.peakGuardDb);
    const objectiveQuality = evaluatePerceptualQuality(processingPerceptual, afterPerceptual, mix.perceptual!);
    quality.reasons.push(...objectiveQuality.reasons); quality.accepted &&= objectiveQuality.accepted;
    base.attempts.push({ iteration, mix, master, intermediate, after, features: afterFeatures, quality, perceptual: afterPerceptual, objectiveQuality });
    if (quality.accepted) {
      let finalProcessed = processed;
      let soundColor: Omit<SoundColorResult, 'processed'> | undefined;
      if (options.soundColor && options.soundColor.preset !== 'none') {
        const coloured = applySoundColor(processed.audio, options.soundColor, { signal: options.signal,
          onProgress: f => progress('Creating candidate', iteration, 0.96 + f * 0.03) });
        const { processed: colourProcessed, ...summary } = coloured;
        soundColor = summary;
        if (!colourProcessed) {
          progress('Finalizing', iteration, 1);
          return { ...base, soundColor, reasons: ['選んだ音色の候補を安全に生成できませんでした。', ...summary.reasons] };
        }
        const overallReasons = evaluateSoundColorQuality(before, summary.attempts.at(-1)!.after,
          processed.maxReductionDb - processed.peakGuardDb + colourProcessed.maxReductionDb - colourProcessed.peakGuardDb);
        if (overallReasons.length) {
          progress('Finalizing', iteration, 1);
          return { ...base, soundColor, reasons: ['補正と音色を合わせた変化が大きいため候補を保留します。', ...overallReasons] };
        }
        finalProcessed = colourProcessed;
      }
      let preferences: Omit<PreferenceResult, 'processed'> | undefined;
      if (options.preferences && (options.preferences.output !== 'auto' || Object.values(options.preferences.controls).some(x => x !== 0))) {
        const finishing = applyFinishingPreferences(finalProcessed.audio, options.preferences, { signal: options.signal, aggression: options.aggression,
          reference: { before, features, mode, reductionDb: processed.maxReductionDb - processed.peakGuardDb + (soundColor ? finalProcessed.maxReductionDb - finalProcessed.peakGuardDb : 0) },
          onProgress: f => progress('Evaluating', iteration, 0.96 + f * 0.03) });
        const { processed: finishedAudio, ...summary } = finishing;
        preferences = summary;
        if (!finishedAudio) { progress('Finalizing', iteration, 1); return { ...base, soundColor, preferences, reasons: ['選んだ調整を安全に適用できないため候補を保留します。', ...summary.reasons] }; }
        finalProcessed = finishedAudio;
      }
      let reference: Omit<ReferenceResult, 'processed'> | undefined;
      let finalAfter = preferences?.attempts.at(-1)?.after ?? soundColor?.attempts.at(-1)?.after ?? after;
      if (options.reference) {
        // Match only tone/density after the selected destination; reference LUFS never changes the target.
        const reduced = preferences?.attempts.at(-1)?.reductionDb ?? (processed.maxReductionDb - processed.peakGuardDb + (soundColor ? finalProcessed.maxReductionDb - finalProcessed.peakGuardDb : 0));
        const matched = applyReferenceFinishing(finalProcessed.audio, options.reference, { signal: options.signal, originalAnalysis: before, originalFeatures: features,
          mode, reductionDb: reduced, targetLufs: finalAfter.integratedLufs ?? undefined,
          ceilingDb: finalProcessed.chain.limiter.ceilingDb, onProgress: f => progress('Evaluating', iteration, 0.97 + f * 0.02) });
        const { processed: referenceProcessed, ...summary } = matched; reference = summary;
        if (referenceProcessed) { finalProcessed = referenceProcessed; finalAfter = summary.attempts.at(-1)!.after; }
      }
      progress('Finalizing', iteration, 1);
      return { ...base, soundColor, preferences, reference, finalAfter, status: 'accepted', reasons: [], explanations: [...new Set([...(base.grain ? [base.grain.explanation] : []), ...(base.treble ? [base.treble.explanation] : []), ...mix.explanations, ...(soundColor?.explanations ?? []), ...(preferences?.explanations ?? []), ...(reference?.explanations ?? []), finalProcessed.chain.bypass
        ? 'ピークと音量に大きな問題がないため、最後の音量処理は加えていません。'
        : 'ピークを保護しながら、控えめな範囲で音量を調整しました。'])], processed: finalProcessed };
    }
    base.reasons = quality.reasons; abort();
  }
  progress('Finalizing', base.attempts.length, 1); return base;
}
