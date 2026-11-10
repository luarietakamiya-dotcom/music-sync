import { analyzeAudio, analyzePerceptualFeatures, PerceptualAnalyzer } from '@music-sync/audio-analysis';
import { AlignedStemMixer, streamStemPresenceDip, validateStemPresenceDip, type StemPresenceDip } from '@music-sync/dsp';
import { LIMITS, type AudioData, type AnalysisResult } from '@music-sync/shared';
import type { StemBalancePlan } from './stem-balance.js';
import { evaluateStemMasking, type StemMaskingPlan } from './stem-masking.js';

export const STEM_LIMITS = Object.freeze({ maxTracks: 16, maxFileBytes: LIMITS.maxFileBytes, maxTotalFileBytes: 400 * 1024 * 1024,
  maxTotalDecodedBytes: 384 * 1024 * 1024, maxBusBytes: 96 * 1024 * 1024, ceilingDb: -3 });
export const STEM_ROLES = Object.freeze({ vocal: 'ボーカル', instrumental: '伴奏（それ以外）', drums: 'ドラム', bass: 'ベース', guitar: 'ギター', keys: '鍵盤', other: 'その他' });
export type StemRole = keyof typeof STEM_ROLES;
export type StemMode = 'stems' | 'vocal-instrumental';
export interface StemDescriptor { id: string; name: string; role: StemRole; vocalRole?: 'lead' | 'backing'; restorationEnabled?: boolean; sampleRate: number; channels: number; frames: number; gainDb: number; pan: number; muted: boolean; presenceDip?: StemPresenceDip }
export interface StemMixPlan { version: 1; mode: StemMode; sampleRate: number; frames: number; sourceBytes: number; busBytes: number; tracks: readonly Readonly<StemDescriptor>[] }
export interface StemTrackReport { descriptor: StemDescriptor; analysis: AnalysisResult; restoration?: { enabled?: boolean; grain?: import('./grain-restoration.js').GrainRestorationReport; treble?: import('./treble-repair.js').TrebleRepairReport } }
export interface StemMixReport { version: 1; plan: StemMixPlan; tracks: StemTrackReport[]; attenuationDb: number; warnings: string[]; autoBalance?: StemBalancePlan; masking?: StemMaskingPlan; clarity?: import('./stem-clarity.js').StemClarityReport }
export interface StemMixResult { audio: AudioData; analysis: AnalysisResult; report: StemMixReport }
export function suggestStemRole(name: string): StemRole {
  const text = name.normalize('NFKC').toLowerCase().replace(/\.(wav|flac)$/i, '');
  if (/(?:no[\s_-]*vocals?|vocals?[\s_-]*removed|without[\s_-]*(?:vocals?|voice)|(?:ボーカル|ヴォーカル|歌声)(?:なし|無し|除去))/.test(text)) return 'instrumental';
  if (/(?:vocal|voice|ボーカル|ヴォーカル|歌声|chorus|choir|harmony|コーラス|ハモリ)/.test(text)) return 'vocal';
  if (/(?:instrumental|accompaniment|karaoke|(?:^|[\s_-])inst(?:$|[\s_-])|伴奏|オケ|それ以外)/.test(text)) return 'instrumental';
  if (/(?:drum|percussion|ドラム)/.test(text)) return 'drums';
  if (/(?:bass|ベース)/.test(text)) return 'bass';
  if (/(?:guitar|ギター)/.test(text)) return 'guitar';
  if (/(?:piano|keys|keyboard|ピアノ|鍵盤)/.test(text)) return 'keys';
  return 'other';
}
export function suggestStemVocalRole(name: string): StemDescriptor['vocalRole'] {
  if (suggestStemRole(name) !== 'vocal') return undefined;
  const text = name.normalize('NFKC').toLowerCase();
  if (/(?:back(?:ing|ground)?[\s_-]*vocals?|chorus|choir|harmony|コーラス|ハモリ)/.test(text)) return 'backing';
  if (/(?:lead[\s_-]*vocals?|main[\s_-]*(?:vocal|voice)|メイン|主旋律)/.test(text)) return 'lead';
  return undefined;
}
/** Metadata-only preflight: validate the entire project before allocating its bus. */
export function planStemMix(tracks: readonly StemDescriptor[], mode: StemMode = 'stems', storage: 'memory' | 'file' = 'memory'): StemMixPlan {
  if (!['stems', 'vocal-instrumental'].includes(mode) || !Array.isArray(tracks) || tracks.length < 2 || tracks.length > STEM_LIMITS.maxTracks)
    throw new Error('STEMは2〜16素材、ボーカル＋伴奏は2素材で読み込んでください。');
  const ids = new Set<string>();
  for (const t of tracks) {
    if (!t || typeof t.id !== 'string' || !t.id || ids.has(t.id) || typeof t.name !== 'string' || !t.name || !Object.hasOwn(STEM_ROLES, t.role) ||
      (t.vocalRole !== undefined && (t.role !== 'vocal' || !['lead', 'backing'].includes(t.vocalRole))) ||
      (t.restorationEnabled !== undefined && typeof t.restorationEnabled !== 'boolean') ||
      !Number.isInteger(t.sampleRate) || t.sampleRate < LIMITS.minSampleRate || t.sampleRate > LIMITS.maxSampleRate || ![1, 2].includes(t.channels) ||
      !Number.isInteger(t.frames) || t.frames < 1 || t.frames / t.sampleRate > (storage === 'file' ? 1200 : LIMITS.maxSeconds) ||
      !Number.isFinite(t.gainDb) || t.gainDb < -24 || t.gainDb > 6 || !Number.isFinite(t.pan) || Math.abs(t.pan) > 1 || typeof t.muted !== 'boolean')
      throw new Error('STEMの形式・役割・音量設定が不正です。');
    if (t.sampleRate !== tracks[0].sampleRate) throw new Error('素材のサンプルレートが異なります。同じレートで書き出したSTEMを使ってください。');
    if (t.presenceDip !== undefined) validateStemPresenceDip(t.presenceDip, t.sampleRate);
    ids.add(t.id);
  }
  if (mode === 'vocal-instrumental' && (tracks.length !== 2 || tracks.filter(t => t.role === 'vocal').length !== 1 || tracks.filter(t => t.role === 'instrumental').length !== 1))
    throw new Error('ボーカル＋伴奏は、ボーカル1素材と伴奏1素材に役割を設定してください。');
  const frames = Math.max(...tracks.map(t => t.frames)), sourceBytes = tracks.reduce((n, t) => n + t.frames * t.channels * 4, 0), busBytes = frames * 8;
  if (storage === 'file' && busBytes + 56 > 512 * 1024 * 1024) throw new Error('合成WAVが512 MiBを超えます。サンプルレートまたは長さを下げてください。');
  if (storage === 'memory' && (sourceBytes > STEM_LIMITS.maxTotalDecodedBytes || busBytes > STEM_LIMITS.maxBusBytes))
    throw new Error(`STEMが大きすぎます。合計PCMは384 MiB、合成音声は96 MiBまでです。このレートの合成上限は約${Math.floor(STEM_LIMITS.maxBusBytes / 8 / tracks[0].sampleRate)}秒です。長い素材を短く分けてください。`);
  const plan: StemMixPlan = { version: 1, mode, sampleRate: tracks[0].sampleRate, frames, sourceBytes, busBytes,
    tracks: Object.freeze(tracks.map(t => Object.freeze({ ...t, ...(t.presenceDip ? { presenceDip: Object.freeze({ ...t.presenceDip }) } : {}) }))) };
  return Object.freeze(plan);
}
/** A sequential session lets the browser release each decoded track after adding it. */
export function createStemMixSession(tracks: readonly StemDescriptor[], mode: StemMode = 'stems', signal?: AbortSignal, maskingPlan?: StemMaskingPlan) {
  const abort = () => { if (signal?.aborted) throw new Error('Processing cancelled'); };
  abort(); const plan = planStemMix(tracks, mode), mixer = new AlignedStemMixer(plan.sampleRate, plan.frames);
  if (maskingPlan?.status === 'proposed' && (!maskingPlan.dip ||
    plan.tracks.filter(track => track.id === maskingPlan.instrumentalId && track.role === 'instrumental' &&
      track.presenceDip?.frequencyHz === maskingPlan.dip?.frequencyHz &&
      track.presenceDip?.gainDb === maskingPlan.dip?.gainDb && track.presenceDip?.q === maskingPlan.dip?.q).length !== 1))
    throw new Error('伴奏の帯域補正計画と素材設定が一致しません。');
  if (maskingPlan?.status !== 'proposed' && maskingPlan && plan.tracks.some(track => track.presenceDip))
    throw new Error('伴奏の帯域補正計画と素材設定が一致しません。');
  const reports: StemTrackReport[] = []; let finished = false, masking = maskingPlan;
  return {
    plan,
    addTrack(id: string, audio: AudioData): void {
      abort(); if (finished) throw new Error('STEM session already finalized');
      const descriptor = plan.tracks[reports.length];
      if (!descriptor || descriptor.id !== id || audio.sampleRate !== descriptor.sampleRate || audio.channels.length !== descriptor.channels || audio.channels[0]?.length !== descriptor.frames)
        throw new Error('STEMの順序またはメタデータと音声が一致しません。');
      const analysis = analyzeAudio(audio);
      let effectiveDip = descriptor.presenceDip;
      if (effectiveDip && !descriptor.muted) {
        const proposed: StemMaskingPlan = masking ?? { version: 1, status: 'proposed', instrumentalId: descriptor.id,
          confidence: 0, relativePresenceDbBefore: null, relativePresenceDbAfter: null,
          dip: effectiveDip, explanation: '素材別の帯域補正候補を確認しています。' };
        if (analysis.clippedSamples) {
          masking = { ...proposed, status: 'reverted', explanation: '元素材にクリッピングがあるため、帯域補正を適用しませんでした。' };
          effectiveDip = undefined;
        } else {
          const before = analyzePerceptualFeatures(audio), analyzer = new PerceptualAnalyzer(audio.sampleRate, audio.channels.length);
          const metrics = streamStemPresenceDip(audio, effectiveDip, chunk => { analyzer.push(chunk); abort(); }, signal);
          masking = evaluateStemMasking(proposed, before, analyzer.finish(), metrics);
          if (masking.status !== 'applied') effectiveDip = undefined;
        }
      }
      mixer.add(audio, descriptor.gainDb, descriptor.pan, descriptor.muted, effectiveDip);
      reports.push({ descriptor: effectiveDip === descriptor.presenceDip ? { ...descriptor } : { ...descriptor, presenceDip: undefined }, analysis }); abort();
    },
    finish(): StemMixResult {
      abort(); if (finished || reports.length !== plan.tracks.length) throw new Error('すべてのSTEMを読み込んでから合成してください。');
      const { audio, attenuationDb } = mixer.finish(STEM_LIMITS.ceilingDb), analysis = analyzeAudio(audio), warnings: string[] = [];
      if (plan.tracks.some(t => t.frames !== plan.frames)) warnings.push('短い素材の末尾を無音で補いました。先頭は同じ時刻にそろえています。');
      if (reports.some(t => t.analysis.clippedSamples)) warnings.push('元の素材にクリッピングがあります。合成時のピーク保護では、その歪みは復元されません。');
      if (attenuationDb < 0) warnings.push(`合算ピークを保護するため全体を${(-attenuationDb).toFixed(1)} dB下げました。素材同士の音量比と強弱は保っています。`);
      analysis.warnings.push(...warnings); finished = true; abort();
      const appliedPlan = planStemMix(reports.map(report => report.descriptor), mode);
      return { audio, analysis, report: { version: 1, plan: appliedPlan, tracks: reports, attenuationDb, warnings,
        ...(masking ? { masking } : {}) } };
    },
  };
}
export function mixStems(tracks: readonly { descriptor: StemDescriptor; audio: AudioData }[], mode: StemMode = 'stems', options: { signal?: AbortSignal; onProgress?: (fraction: number) => void; maskingPlan?: StemMaskingPlan } = {}): StemMixResult {
  const session = createStemMixSession(tracks.map(t => t.descriptor), mode, options.signal, options.maskingPlan);
  tracks.forEach((t, i) => { options.onProgress?.(i / tracks.length * 0.9); session.addTrack(t.descriptor.id, t.audio); });
  options.onProgress?.(0.95); const result = session.finish(); options.onProgress?.(1);
  if (options.signal?.aborted) throw new Error('Processing cancelled');
  return result;
}
