import { analyzePerceptualFeatures, type PerceptualFeatures } from '@music-sync/audio-analysis';
import type { AudioData } from '@music-sync/shared';
import { mixStems, planStemMix, type StemDescriptor, type StemMixResult } from './stems.js';

/** A conservative two-source level decision, based on user-assigned roles and measured bands. */
export interface StemBalancePlan {
  version: 1;
  status: 'adjusted' | 'unchanged' | 'skipped';
  relativePresenceDbBefore: number | null;
  relativePresenceDbAfter: number | null;
  confidence: number;
  tracks: readonly { id: string; gainDb: number; adjustmentDb: number }[];
  explanation: string;
}

const presenceDb = (features: PerceptualFeatures): number => {
  const upper = features.bands.upperMid.rmsDb;
  const presence = features.bands.presence.rmsDb;
  return 10 * Math.log10(10 ** (upper / 10) + 10 ** (presence / 10));
};

/** No source recognition is implied: roles are supplied by the caller and can be corrected. */
export function planStemBalance(tracks: readonly StemDescriptor[], features: readonly PerceptualFeatures[], storage: 'memory' | 'file' = 'memory'): StemBalancePlan {
  planStemMix(tracks, 'vocal-instrumental', storage);
  if (features.length !== 2) throw new Error('ボーカルと伴奏の解析結果が2件必要です。');
  const vocalIndex = tracks.findIndex(track => track.role === 'vocal');
  const instrumentalIndex = tracks.findIndex(track => track.role === 'instrumental');
  const vocal = tracks[vocalIndex], instrumental = tracks[instrumentalIndex];
  const voiceFeatures = features[vocalIndex], musicFeatures = features[instrumentalIndex];
  const confidence = Math.min(voiceFeatures?.confidence ?? 0, musicFeatures?.confidence ?? 0);
  const base = (status: StemBalancePlan['status'], explanation: string, relative: number | null, adjustment = 0): StemBalancePlan => ({
    version: 1, status, relativePresenceDbBefore: relative,
    relativePresenceDbAfter: relative === null ? null : relative + adjustment,
    confidence, tracks: tracks.map(track => ({ id: track.id, gainDb: track.gainDb + (track.id === vocal.id ? adjustment : 0),
      adjustmentDb: track.id === vocal.id ? adjustment : 0 })), explanation,
  });
  if (vocal.muted || instrumental.muted) return base('skipped', '含めない素材があります。自動バランスは適用しませんでした。', null);
  if (!Number.isFinite(confidence) || confidence < 0.3) return base('skipped', '素材の帯域を十分に測定できなかったため、元の音量比を保ちました。', null);
  const vocalDb = presenceDb(voiceFeatures), musicDb = presenceDb(musicFeatures);
  if (!Number.isFinite(vocalDb) || !Number.isFinite(musicDb) || vocalDb < -70 || musicDb < -70)
    return base('skipped', '声または伴奏の対象帯域が小さすぎるため、元の音量比を保ちました。', null);
  const relative = vocalDb + vocal.gainDb - musicDb - instrumental.gainDb;
  let adjustment = relative < -4 ? Math.min(3, (-2 - relative) * 0.5) : relative > 7 ? -Math.min(2, (relative - 5) * 0.4) : 0;
  const wantedChange = adjustment;
  adjustment = Math.max(-24 - vocal.gainDb, Math.min(6 - vocal.gainDb, adjustment));
  adjustment = Math.round(adjustment * 10) / 10;
  if (Math.abs(adjustment) < 0.2) return Math.abs(wantedChange) >= 0.2
    ? base('skipped', '声の音量が設定可能な範囲の端に達しているため、追加調整を見送りました。', relative)
    : base('unchanged', '声と伴奏の測定上のバランスは大きく崩れていないため、音量を変えませんでした。', relative);
  return base('adjusted', adjustment > 0
    ? '声の帯域が伴奏に対して控えめだったため、声の素材だけを少し前に出しました。'
    : '声の帯域が強く出ていたため、声の素材だけを少しなじませました。', relative, adjustment);
}

/** Batch Core entry point. Streaming hosts can use planStemBalance before a second decode pass. */
export function mixStemsWithBalance(tracks: readonly { descriptor: StemDescriptor; audio: AudioData }[],
  options: { signal?: AbortSignal; onProgress?: (fraction: number) => void } = {}): StemMixResult {
  const abort = () => { if (options.signal?.aborted) throw new Error('Processing cancelled'); };
  abort();
  const descriptors = tracks.map(track => track.descriptor);
  planStemMix(descriptors, 'vocal-instrumental');
  const features = tracks.map((track, index) => {
    abort();
    const descriptor = descriptors[index];
    if (track.audio.sampleRate !== descriptor.sampleRate || track.audio.channels.length !== descriptor.channels ||
      track.audio.channels[0]?.length !== descriptor.frames) throw new Error('STEMのメタデータと音声が一致しません。');
    const result = analyzePerceptualFeatures(track.audio);
    options.onProgress?.((index + 1) / tracks.length * 0.3);
    abort();
    return result;
  });
  const balance = planStemBalance(descriptors, features);
  const mixed = mixStems(tracks.map((track, index) => ({ audio: track.audio,
    descriptor: { ...track.descriptor, gainDb: balance.tracks[index].gainDb } })), 'vocal-instrumental',
  { signal: options.signal, onProgress: fraction => { options.onProgress?.(0.3 + fraction * 0.7); abort(); } });
  mixed.report.autoBalance = balance;
  return mixed;
}
