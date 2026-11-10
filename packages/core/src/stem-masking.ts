import type { PerceptualBand, PerceptualFeatures } from '@music-sync/audio-analysis';
import type { StemPresenceDip } from '@music-sync/dsp';
import type { StemDescriptor } from './stems.js';
import type { StemBalancePlan } from './stem-balance.js';

export interface StemMaskingEvaluation {
  accepted: boolean;
  presenceReductionDb: number;
  lowChangeDb: number;
  highChangeDb: number;
  samplePeak: number;
  reasons: string[];
}
export interface StemMaskingPlan {
  version: 1;
  status: 'proposed' | 'applied' | 'unchanged' | 'skipped' | 'reverted';
  instrumentalId: string;
  confidence: number;
  relativePresenceDbBefore: number | null;
  relativePresenceDbAfter: number | null;
  dip?: StemPresenceDip;
  evaluation?: StemMaskingEvaluation;
  explanation: string;
}

function combinedDb(features: PerceptualFeatures, bands: readonly PerceptualBand[]): number {
  return 10 * Math.log10(bands.reduce((power, band) => power + 10 ** (features.bands[band].rmsDb / 10), 0));
}

/** Role labels and measured overlap generate a proposal, never a semantic vocal claim. */
export function planStemMasking(tracks: readonly StemDescriptor[], features: readonly PerceptualFeatures[], balance: StemBalancePlan): StemMaskingPlan {
  if (tracks.length !== 2 || features.length !== 2 || tracks.filter(track => track.role === 'vocal').length !== 1 ||
    tracks.filter(track => track.role === 'instrumental').length !== 1 || balance.tracks.length !== 2 ||
    tracks.some((track, index) => track.id !== balance.tracks[index].id)) throw new Error('ボーカル＋伴奏の補正計画が不正です。');
  const voiceIndex = tracks.findIndex(track => track.role === 'vocal'), musicIndex = 1 - voiceIndex;
  const voice = features[voiceIndex], music = features[musicIndex];
  const confidence = Math.min(voice?.confidence ?? 0, music?.confidence ?? 0);
  const relative = balance.relativePresenceDbAfter;
  const base = (status: StemMaskingPlan['status'], explanation: string): StemMaskingPlan => ({ version: 1, status,
    instrumentalId: tracks[musicIndex].id, confidence, relativePresenceDbBefore: relative,
    relativePresenceDbAfter: relative, explanation });
  if (tracks.some(track => track.muted)) return base('skipped', '含めない素材があるため、伴奏の帯域補正を見送りました。');
  if (!Number.isFinite(confidence) || confidence < 0.55 || relative === null || !Number.isFinite(relative))
    return base('skipped', '帯域の測定に十分な確かさがないため、伴奏の音色を保ちました。');
  const voiceShare = voice.bands.upperMid.mean + voice.bands.presence.mean;
  const musicShare = music.bands.upperMid.mean + music.bands.presence.mean;
  if (voiceShare < 0.12 || musicShare < 0.12 || combinedDb(voice, ['upperMid', 'presence']) < -65)
    return base('skipped', '声と伴奏の対象帯域が小さく、重なりを判断できませんでした。');
  if (relative >= -5) return base('unchanged', '声の帯域が伴奏に対して十分に聞こえる測定結果のため、伴奏の音色を変えませんでした。');
  const frequencyHz = music.bands.upperMid.mean > music.bands.presence.mean * 1.2 ? 1800 : 3200;
  const gainDb = -Math.min(2, Math.max(1, (-4 - relative) * 0.18));
  return { ...base('proposed', '声と重なる伴奏の帯域を少し空ける候補を作りました。'),
    dip: { frequencyHz: Math.min(frequencyHz, tracks[0].sampleRate * 0.4), gainDb, q: 0.85 } };
}

/** Accept only a measured, localized cut that leaves the surrounding source intact. */
export function evaluateStemMasking(plan: StemMaskingPlan, before: PerceptualFeatures, after: PerceptualFeatures,
  signal: { samplePeak: number; clippedSamples: number }): StemMaskingPlan {
  if (plan.status !== 'proposed' || !plan.dip) return plan;
  const reduction = combinedDb(before, ['upperMid', 'presence']) - combinedDb(after, ['upperMid', 'presence']);
  const lowChange = combinedDb(after, ['sub', 'low', 'lowMid']) - combinedDb(before, ['sub', 'low', 'lowMid']);
  const highChange = combinedDb(after, ['high', 'air']) - combinedDb(before, ['high', 'air']);
  const reasons: string[] = [];
  if (![reduction, lowChange, highChange, signal.samplePeak, after.confidence, after.correlation, after.sideRatio,
    before.crestDb, after.crestDb, before.correlation, before.sideRatio].every(Number.isFinite))
    reasons.push('補正後の測定値が不正です。');
  if (reduction < 0.15 || reduction > 2.5) reasons.push('声と重なる帯域への効果が小さいか、大きすぎます。');
  if (Math.abs(lowChange) > 0.3 || Math.abs(highChange) > 0.6) reasons.push('対象外の低域または高域が変化しすぎました。');
  if (Math.abs(after.crestDb - before.crestDb) > 1 || after.correlation < before.correlation - 0.03 ||
    Math.abs(after.sideRatio - before.sideRatio) > 0.03) reasons.push('強弱またはステレオの安定性が変化しすぎました。');
  if (signal.samplePeak >= 1 || signal.clippedSamples !== 0) reasons.push('素材のピーク保護条件を満たしません。');
  const evaluation: StemMaskingEvaluation = { accepted: !reasons.length, presenceReductionDb: reduction,
    lowChangeDb: lowChange, highChangeDb: highChange, samplePeak: signal.samplePeak, reasons };
  return { ...plan, status: evaluation.accepted ? 'applied' : 'reverted', evaluation,
    relativePresenceDbAfter: plan.relativePresenceDbBefore === null ? null : plan.relativePresenceDbBefore + (evaluation.accepted ? reduction : 0),
    explanation: evaluation.accepted ? '声と重なる伴奏の帯域を控えめに整理し、低音と高音への影響を確認しました。'
      : '伴奏の帯域補正は測定で効果や安全性を確認できず、適用せずにミックスしました。' };
}
