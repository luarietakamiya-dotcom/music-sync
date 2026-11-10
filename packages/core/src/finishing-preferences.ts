import { analyzeAudio, analyzeAdaptiveFeatures } from '@music-sync/audio-analysis';
import { defaultProcessingChain, processAudio, renderMix, type MixStage, type ProcessingResult } from '@music-sync/dsp';
import type { AudioData, AnalysisResult } from '@music-sync/shared';
import type { AdaptiveFeatures } from '@music-sync/audio-analysis';
import { evaluateAutoQuality } from './auto/quality-evaluator.js';
import type { AutoMode } from './auto/mix-planner.js';

export type FinishLevel = 0 | 1 | 2 | 3;
export interface FinishControls { vocal: FinishLevel; bass: FinishLevel; clarity: FinishLevel; warmth: FinishLevel; punch: FinishLevel; width: FinishLevel; density: FinishLevel }
export const DEFAULT_FINISH_CONTROLS: Readonly<FinishControls> = Object.freeze({ vocal: 0, bass: 0, clarity: 0, warmth: 0, punch: 0, width: 0, density: 0 });
export const FINISH_CONTROL_LABELS = Object.freeze({ vocal: 'ボーカルの存在感', bass: '低音の厚み', clarity: '明るさ・明瞭さ', warmth: '暖かさ', punch: 'パンチ・立ち上がり', width: '音の広がり', density: '音圧・密度' });
export type OutputProfileId = 'auto' | 'youtube' | 'streaming' | 'cd' | 'dynamic';
// YouTube/CD values are MusicSync house targets, not claimed delivery standards.
export const OUTPUT_PROFILES = Object.freeze({
  auto: Object.freeze({ label: 'おまかせ', targetLufs: null, ceilingDb: -1, description: '曲とモードに合わせた音量。音圧を上げるときも強弱とピークを保護します。' }),
  youtube: Object.freeze({ label: 'YouTube向け（目安）', targetLufs: -14, ceilingDb: -1, description: '動画・配信用の音量目安。YouTubeの必須規格ではありません。' }),
  streaming: Object.freeze({ label: '音楽ストリーミング向け', targetLufs: -14, ceilingDb: -1, description: 'Spotifyの推奨音量を参考に、変換に備えてピークの余裕を残します。' }),
  cd: Object.freeze({ label: 'CD向け（音量の目安）', targetLufs: -12, ceilingDb: -1, description: '少し大きめの音量を目指します。CD共通のLUFS規格ではなく、CD用形式への変換も行いません。' }),
  dynamic: Object.freeze({ label: '強弱を残す仕上がり', targetLufs: -18, ceilingDb: -1, description: '余裕のある音量で、曲の強弱を残す方向です。' }),
});
export interface FinishingPreferences { controls: FinishControls; output: OutputProfileId }
export interface FinishControlPlan { strength: number; requested: FinishControls; stages: MixStage[]; explanations: string[]; skipped: string[]; compressionBudgetDb: number }
export interface PreferenceAttempt { plan: FinishControlPlan; after: AnalysisResult; reductionDb: number; reasons: string[] }
export interface PreferenceResult {
  version: 1; status: 'accepted' | 'rejected'; selection: FinishingPreferences; attempts: PreferenceAttempt[];
  requestedLufs: number; actualLufs: number | null; targetReached: boolean; explanations: string[]; reasons: string[]; processed?: ProcessingResult;
}
import { liftAllowance } from './studio-settings.js';
export interface PreferenceOptions { aggression?: number;
  signal?: AbortSignal; onProgress?: (fraction: number) => void;
  /** Whole-chain reference, used by the automatic engine to retain its original gates. */
  reference?: { before: AnalysisResult; features: AdaptiveFeatures; reductionDb: number; mode: AutoMode };
}
export function validateFinishingPreferences(p: FinishingPreferences): void {
  if (!p || !p.controls || !Object.hasOwn(OUTPUT_PROFILES, p.output) ||
    Object.keys(DEFAULT_FINISH_CONTROLS).some(key => ![0, 1, 2, 3].includes(p.controls[key as keyof FinishControls])))
    throw new Error('仕上がり調整または出力先の設定が不正です。');
}
/** User intent -> bounded generic stages. Analysis prevents indiscriminate boosts. */
export function planFinishControls(before: AnalysisResult, features: AdaptiveFeatures, controls: FinishControls, strength = 1): FinishControlPlan {
  validateFinishingPreferences({ controls, output: 'auto' });
  if (![1, 0.5, 0.25].includes(strength)) throw new Error('Invalid finishing strength');
  const stages: MixStage[] = [], explanations: string[] = [], skipped: string[] = [];
  const amount = (key: keyof FinishControls) => controls[key] / 3 * strength;
  const eq = (hz: number, gainDb: number) => { if (gainDb) stages.push({ kind: 'eq', frequencyHz: Math.min(hz, before.sampleRate * 0.4), gainDb, q: 0.7 }); };
  if (controls.vocal) {
    eq(2600, 1.8 * amount('vocal') * (features.bandEnergy.highMid > 0.3 ? 0.45 : 1)); eq(450, -0.6 * amount('vocal'));
    explanations.push('ボーカルの存在感を支える帯域を整えました（声だけを分離する処理ではありません）。');
  }
  if (controls.bass) {
    eq(95, 2 * amount('bass') * (features.bandEnergy.bass > 0.55 ? 0.35 : 1));
    explanations.push(features.bandEnergy.bass > 0.55 ? '低音がすでに多いため、厚みの追加を控えました。' : '低音に厚みを加えました。');
  }
  if (controls.clarity) {
    eq(6500, 1.6 * amount('clarity') * (features.bandEnergy.highMid + features.bandEnergy.air > 0.35 ? 0.35 : 1));
    explanations.push('高域の偏りを見ながら、明るさと輪郭を加えました。');
  }
  if (controls.warmth) { eq(220, 1.4 * amount('warmth') * (features.bandEnergy.lowMid > 0.35 ? 0.4 : 1)); explanations.push('低中域に控えめな暖かさを加えました。'); }
  if (controls.width) {
    if (before.channels !== 2 || (before.stereoCorrelation ?? 0) < 0.25 || (before.sideEnergyPercent ?? 0) > 30 || features.negativeCorrelationFraction > 0.1)
      skipped.push('広がりは、モノラルまたはステレオの安定性を考慮して追加しませんでした。');
    else { stages.push({ kind: 'width', amount: 1 + 0.06 * amount('width'), crossoverHz: 220 }); explanations.push('低音を中央に保ちながら、上の帯域の広がりを加えました。'); }
  }
  const dense = (before.crestFactorDb ?? 0) < 6 || features.dynamicRangeDb < 3;
  const compressionDb = dense ? 0 : 1.2 * amount('density');
  const punchDb = (before.crestFactorDb ?? 0) < 4 ? 0 : amount('punch');
  if (compressionDb || punchDb) {
    stages.push({ kind: 'dynamics', compressionDb, punchDb, referenceRms: Math.max(1e-8, 10 ** ((before.rmsDbfs ?? -160) / 20)) });
    if (punchDb) explanations.push('音の立ち上がりを強調しました。');
    if (compressionDb) explanations.push('強弱を抑えすぎない範囲で、音の密度を加えました。');
  }
  if (controls.density && dense) skipped.push('すでに密度が高いため、追加の圧縮は行いませんでした。');
  if (controls.punch && !punchDb) skipped.push('強弱の余裕が小さいため、立ち上がりの追加を見送りました。');
  return { strength, requested: { ...controls }, stages, explanations, skipped, compressionBudgetDb: compressionDb };
}
/** Final EQ/dynamics and destination loudness after colour/LIVE. No accumulating retries. */
export function applyFinishingPreferences(input: AudioData, selection: FinishingPreferences, options: PreferenceOptions = {}): PreferenceResult {
  validateFinishingPreferences(selection);
  const progress = (fraction: number) => {
    if (options.signal?.aborted) throw new Error('Processing cancelled');
    options.onProgress?.(fraction);
    if (options.signal?.aborted) throw new Error('Processing cancelled');
  };
  progress(0);
  if (input.channels.reduce((n, c) => n + c.byteLength, 0) > 96 * 1024 * 1024) throw new Error('仕上がり調整は展開後96 MiBまでです。');
  const before = analyzeAudio(input), features = analyzeAdaptiveFeatures(input);
  const reference = options.reference ?? { before, features, reductionDb: 0, mode: 'AUTO' };
  const profile = OUTPUT_PROFILES[selection.output];
  const requestedLufs = profile.targetLufs ?? (selection.controls.density ? Math.min(-9, (before.integratedLufs ?? -16) + selection.controls.density * 1.5) : before.integratedLufs ?? -16);
  const result: PreferenceResult = { version: 1, status: 'rejected', selection: { output: selection.output, controls: { ...selection.controls } },
    attempts: [], requestedLufs, actualLufs: null, targetReached: false, explanations: [], reasons: [] };
  if (before.integratedLufs === null || before.clippedSamples) { result.reasons = ['音量を測定できない音源、または元音源のクリッピングがあるため保留します。']; progress(1); return result; }
  for (const [i, strength] of [1, 0.5, 0.25].entries()) {
    progress(0.05 + i * 0.3);
    const plan = planFinishControls(before, features, selection.controls, strength);
    const adjusted = plan.stages.length ? renderMix(input, plan.stages) : input;
    const intermediate = analyzeAudio(adjusted);
    if (intermediate.integratedLufs === null) { result.reasons = ['調整後の音量を測定できません。']; break; }
    const chain = defaultProcessingChain(); chain.limiter.ceilingDb = profile.ceilingDb;
    const headroom = profile.ceilingDb - Math.max(intermediate.truePeakDbtp ?? Infinity, intermediate.samplePeakDbfs ?? Infinity);
    const remainingReduction = Math.max(0, 3 - reference.reductionDb - plan.compressionBudgetDb) * strength;
    const liftLimit = (reference.before.integratedLufs ?? before.integratedLufs) + liftAllowance(6, options.aggression) - intermediate.integratedLufs;
    chain.gainDb = Math.max(-24, Math.min(12, requestedLufs - intermediate.integratedLufs, headroom + remainingReduction, liftLimit));
    if (Math.abs(chain.gainDb) < 0.05 && headroom >= 0) { chain.bypass = true; chain.gainDb = 0; }
    const processed = processAudio(adjusted, chain);
    progress(0.23 + i * 0.3);
    const after = analyzeAudio(processed.audio), afterFeatures = analyzeAdaptiveFeatures(processed.audio);
    const reductionDb = reference.reductionDb + plan.compressionBudgetDb + processed.maxReductionDb - processed.peakGuardDb;
    const quality = evaluateAutoQuality(reference.before, after, reference.features, afterFeatures, reference.mode, reductionDb);
    result.attempts.push({ plan, after, reductionDb, reasons: quality.reasons }); result.reasons = quality.reasons;
    if (!quality.accepted) continue;
    result.status = 'accepted'; result.processed = processed; result.actualLufs = after.integratedLufs;
    result.targetReached = Math.abs(after.integratedLufs! - requestedLufs) <= 0.5;
    result.explanations = [...plan.explanations, ...plan.skipped];
    if (i) result.explanations.push('測定条件に合わせて、仕上がり調整を弱めました。');
    result.explanations.push(result.targetReached ? `${profile.label}の音量目標に合わせました。` : '強弱とピークを保護するため、目標音量より控えめな候補にしました。');
    progress(1); return result;
  }
  progress(1); return result;
}
