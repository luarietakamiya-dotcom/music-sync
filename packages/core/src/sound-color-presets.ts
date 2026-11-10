import type { AnalysisResult } from '@music-sync/shared';
import type { SoundColorParameters, ToneBand } from '@music-sync/dsp';

export type SoundColorId = 'none' | 'warm' | 'clear' | 'vocal' | 'bass' | 'am-radio' | 'old-record' | 'cassette' | 'telephone' | 'next-room';
export type SoundColorIntensity = 'gentle' | 'standard' | 'vivid';
export interface SoundColorSelection { preset: SoundColorId; intensity: SoundColorIntensity }
interface Preset {
  label: string; group: 'そのまま' | '音色EQ' | '古い音源風' | '空間・機材'; description: string;
  bands: readonly Readonly<ToneBand>[]; highpassHz?: number; lowpassHz?: number; drive?: number;
  noiseDb?: number; crackleDb?: number; wowDepthMs?: number; mono?: number;
}
const band = (frequencyHz: number, gainDb: number, q = 0.7): ToneBand => ({ frequencyHz, gainDb, q });
const definitions: Record<SoundColorId, Preset> = {
  none: { label: '原音の音色', group: 'そのまま', description: '音色・演出を加えません。', bands: [] },
  warm: { label: '暖かい音', group: '音色EQ', description: '低中域に温かさを加え、高域を柔らかくします。', bands: [band(180, 2.5), band(3500, -1), band(10000, -2)] },
  clear: { label: 'クリア', group: '音色EQ', description: '低中域をすっきりさせ、輪郭を明るくします。', bands: [band(280, -2.5), band(3000, 2), band(8000, 1.5)] },
  vocal: { label: 'ボーカルを聴きやすく', group: '音色EQ', description: '声が聞こえやすい帯域を強調します。声だけを分離する処理ではありません。', bands: [band(150, -1), band(450, -2), band(2600, 3)] },
  bass: { label: '低音に厚み', group: '音色EQ', description: '低域に厚みを加え、こもりやすい帯域を少し引きます。', bands: [band(90, 3), band(300, -1.5)] },
  'am-radio': { label: 'AMラジオ', group: '古い音源風', description: '帯域を狭め、軽い歪みとノイズでラジオらしくします。', bands: [band(1600, 2)], highpassHz: 300, lowpassHz: 3200, drive: 0.35, noiseDb: -48, mono: 1 },
  'old-record': { label: '古いレコード', group: '古い音源風', description: '丸い高域、針のパチパチ音、ごく軽い回転の揺れを加えます。', bands: [band(700, 1.5)], highpassHz: 70, lowpassHz: 6500, drive: 0.2, noiseDb: -49, crackleDb: -34, wowDepthMs: 0.35, mono: 0.25 },
  cassette: { label: 'カセットテープ', group: '古い音源風', description: '柔らかい高域、ヒス、ゆるやかな揺れでテープの質感を作ります。', bands: [band(180, 1.5)], highpassHz: 40, lowpassHz: 8500, drive: 0.25, noiseDb: -44, wowDepthMs: 0.7 },
  telephone: { label: '電話の向こう', group: '空間・機材', description: '声の帯域に絞り、中央にまとまった電話の音にします。', bands: [band(1800, 2)], highpassHz: 500, lowpassHz: 2800, drive: 0.2, mono: 1 },
  'next-room': { label: '隣の部屋', group: '空間・機材', description: '高域を遮り、壁越しに聞こえるこもった音にします。', bands: [band(500, 1)], highpassHz: 100, lowpassHz: 1500, mono: 0.45 },
};
// Deeply frozen public metadata: preset callers cannot change future renders.
export const SOUND_COLOR_PRESETS = Object.freeze(Object.fromEntries(
  Object.entries(definitions).map(([id, p]) => [id, Object.freeze({ ...p, bands: Object.freeze(p.bands.map(b => Object.freeze(b))) })]),
) as Record<SoundColorId, Readonly<Preset>>);
export const SOUND_COLOR_INTENSITIES = Object.freeze({ gentle: 0.4, standard: 0.7, vivid: 1 });
export function validateSoundColorSelection(selection: SoundColorSelection): void {
  if (!selection || !Object.hasOwn(SOUND_COLOR_PRESETS, selection.preset) || !Object.hasOwn(SOUND_COLOR_INTENSITIES, selection.intensity))
    throw new Error('音色の種類または強さが不正です。');
}
/** Intent data + measured input -> bounded DSP plan; presets contain no kernels. */
export function planSoundColor(before: AnalysisResult, selection: SoundColorSelection, retryScale = 1): SoundColorParameters {
  validateSoundColorSelection(selection);
  if (!Number.isFinite(retryScale) || retryScale < 0.25 || retryScale > 1) throw new Error('Invalid sound-color retry');
  const p = SOUND_COLOR_PRESETS[selection.preset], amount = SOUND_COLOR_INTENSITIES[selection.intensity] * retryScale;
  const referenceRms = Math.max(1e-8, 10 ** ((before.rmsDbfs ?? -160) / 20));
  // Quiet recordings get proportionally quieter texture. Noise cannot dominate programme.
  const noise = (db?: number) => db === undefined ? 0 : Math.min(10 ** (db / 20), referenceRms * 0.035) * amount;
  return {
    bands: p.bands.map(b => ({ ...b, frequencyHz: Math.min(b.frequencyHz, before.sampleRate * 0.4), gainDb: b.gainDb * amount })),
    highpassHz: Math.min((p.highpassHz ?? 0) * amount, before.sampleRate * 0.4),
    lowpassHz: p.lowpassHz ? Math.min(p.lowpassHz / Math.max(amount, 0.1), before.sampleRate * 0.45) : 0,
    drive: (p.drive ?? 0) * amount, noiseAmplitude: noise(p.noiseDb),
    crackleAmplitude: p.crackleDb === undefined ? 0 : Math.min(10 ** (p.crackleDb / 20), referenceRms * 0.2) * amount,
    wowDepthMs: (p.wowDepthMs ?? 0) * amount, wowRateHz: 1.1, monoAmount: (p.mono ?? 0) * amount, referenceRms,
  };
}
