import type { StemClarityFeatures } from '@music-sync/audio-analysis';
import { planStemVocalSupport } from './stem-vocal-support.js';
export { createStemClarityAnalyzer } from '@music-sync/audio-analysis';
export type { StemClarityFeatures } from '@music-sync/audio-analysis';
import type { StemDescriptor } from './stems.js';
export interface StemClarityTrackReport {
    id: string;
    supportSeconds?: number;
    maxSupportGainDb?: number;
    presenceSeconds: number;
    lowSeconds: number;
    maxPresenceReductionDb: number;
    maxLowReductionDb: number;
}
export interface StemClarityReport {
    version: 1;
    status: 'applied' | 'skipped' | 'reverted';
    evaluation?: {
        accepted: boolean;
        strength: number;
        rmsChangeDb: number;
        headroomGainChangeDb?: number;
        correlationChange: number | null;
        reasons: string[];
    };
    leadId: string | null;
    tracks: StemClarityTrackReport[];
    activeLeadSeconds: number;
    maskedSeconds: number;
    projectedPresenceImprovementDb: number;
    explanations: string[];
    reasons: string[];
}
export interface StemClarityPlan {
    windowFrames: number;
    tracks: {
        id: string;
        gainDb?: Float32Array;
        presenceDb: Float32Array;
        lowDb: Float32Array;
    }[];
    report: StemClarityReport;
}
type ClarityDescriptor = StemDescriptor & {
    vocalRole?: 'lead' | 'backing';
};
function gainPower(track: ClarityDescriptor) {
    const gain = 10 ** (track.gainDb / 10);
    if (track.channels === 1)
        return gain;
    return gain * (Math.min(1, 1 - track.pan) ** 2 + Math.min(1, 1 + track.pan) ** 2) / 2;
}
function maximum(values: Float32Array) {
    let result = 0;
    for (const value of values)
        result = Math.max(result, value);
    return result;
}
function relativeThreshold(values: Float32Array) {
    const nonzero = Array.from(values).filter(value => value > 1e-6).sort((a, b) => a - b);
    const p95 = nonzero.length ? nonzero[Math.floor((nonzero.length - 1) * 0.95)] : 0;
    return Math.max(1e-5, p95 * 0.1, maximum(values) * 0.025);
}
function validate(tracks: readonly ClarityDescriptor[], features: readonly StemClarityFeatures[]) {
    if (!Array.isArray(tracks) || !Array.isArray(features) || tracks.length < 2 || tracks.length > 16 || tracks.length !== features.length)
        throw new Error('明瞭さ調整には2〜16素材の解析結果が必要です。');
    const ids = new Set<string>();
    for (const [i, track] of tracks.entries()) {
        const data = features[i];
        if (!track || typeof track.id !== 'string' || !track.id || ids.has(track.id) || typeof track.name !== 'string' || !track.name || !data ||
            !Number.isInteger(track.sampleRate) || track.sampleRate < 8000 || track.sampleRate > 192000 ||
            !Number.isInteger(track.frames) || track.frames < 1 || track.frames > track.sampleRate * 1200 ||
            ![1, 2].includes(track.channels) || !Number.isFinite(track.gainDb) || track.gainDb < -24 || track.gainDb > 6 ||
            !Number.isFinite(track.pan) || Math.abs(track.pan) > 1 || typeof track.muted !== 'boolean' ||
            (track.vocalRole !== undefined && !['lead', 'backing'].includes(track.vocalRole)) ||
            !['vocal', 'instrumental', 'drums', 'bass', 'guitar', 'keys', 'other'].includes(track.role) ||
            track.sampleRate !== tracks[0].sampleRate || data.sampleRate !== track.sampleRate ||
            data.channels !== track.channels || data.frames !== track.frames ||
            data.windowFrames !== Math.round(track.sampleRate * 0.05) ||
            (data.clippedSamples !== undefined && (!Number.isInteger(data.clippedSamples) || data.clippedSamples < 0 || data.clippedSamples > track.frames * track.channels)))
            throw new Error('STEMの明瞭さ調整のメタデータが不正です。');
        const count = Math.ceil(track.frames / data.windowFrames);
        if (data.bodyEnergy !== undefined && (!(data.bodyEnergy instanceof Float32Array) || data.bodyEnergy.length !== count || data.bodyEnergy.some((value: number)=>!Number.isFinite(value)||value<0)))
            throw new Error('STEMの声の胴体帯域の解析値が不正です。');
        for (const values of [data.presenceEnergy, data.lowEnergy, data.bodyRms]) {
            if (!(values instanceof Float32Array) || values.length !== count || values.some((value: number) => !Number.isFinite(value) || value < 0))
                throw new Error('STEMの明瞭さ解析値が不正です。');
        }
        if (!(data.attack instanceof Uint8Array) || data.attack.length !== count || data.attack.some((value: number) => value > 1))
            throw new Error('STEMの立ち上がり解析値が不正です。');
        ids.add(track.id);
    }
}
/** Select small, time-local cuts only where the designated lead and masking material overlap. */
export function planStemClarity(tracks: readonly ClarityDescriptor[], features: readonly StemClarityFeatures[], options: {
    signal?: AbortSignal;
    vocalSupport?: boolean;
} = {}): StemClarityPlan {
    options.signal?.throwIfAborted();
    validate(tracks, features);
    const windowFrames = features[0].windowFrames, rate = tracks[0].sampleRate;
    const frames = Math.max(...tracks.map(track => track.frames)), count = Math.ceil(frames / windowFrames);
    const curves: StemClarityPlan['tracks'] = tracks.map(track => ({ id: track.id, presenceDb: new Float32Array(count), lowDb: new Float32Array(count) }));
    const report: StemClarityReport = { version: 1, status: 'skipped', leadId: null,
        tracks: tracks.map(track => ({ id: track.id, presenceSeconds: 0, lowSeconds: 0, maxPresenceReductionDb: 0, maxLowReductionDb: 0 })),
        activeLeadSeconds: 0, maskedSeconds: 0, projectedPresenceImprovementDb: 0, explanations: [], reasons: [] };
    const finish = () => ({ windowFrames, tracks: curves, report });
    const vocals = tracks.map((track, i) => ({ track, i })).filter(item => item.track.role === 'vocal' && !item.track.muted);
    const explicit = vocals.filter(item => item.track.vocalRole === 'lead');
    const implicit = vocals.filter(item => item.track.vocalRole === undefined);
    const lead = explicit.length === 1 ? explicit[0] :
        explicit.length === 0 && vocals.length === 1 && implicit.length === 1 ? implicit[0] : undefined;
    if (!lead) {
        report.reasons.push('メインボーカルを1素材に指定すると、歌が埋もれる箇所を自動で調整できます。');
        return finish();
    }
    report.leadId = lead.track.id;
    if (tracks.some((track, i) => !track.muted && (features[i].clippedSamples ?? 0) > 0)) {
        report.reasons.push('元素材にクリッピングがあるため、明瞭さの追加補正を見送りました。');
        return finish();
    }
    const leadFeatures = features[lead.i], power = tracks.map(gainPower);
    const activity = relativeThreshold(leadFeatures.bodyRms);
    const presenceFloor = Math.max(1e-11, maximum(leadFeatures.presenceEnergy) * 1e-4);
    const maxDrumLow = Math.max(0, ...tracks.map((track, i) => track.role === 'drums' && !track.muted ? maximum(features[i].lowEnergy) * power[i] : 0));
    let improved = 0, improvedWindows = 0;
    const relativeAfter = new Float32Array(leadFeatures.presenceEnergy.length);
    for (let window = 0; window < count; window++) {
        options.signal?.throwIfAborted();
        const duration = Math.min(windowFrames, frames - window * windowFrames) / rate;
        const leadBody = leadFeatures.bodyRms[window] ?? 0, leadPresence = leadFeatures.presenceEnergy[window] ?? 0;
        if (leadBody < activity || leadPresence < presenceFloor || leadBody * Math.sqrt(power[lead.i]) < 1e-5)
            continue;
        report.activeLeadSeconds += duration;
        let accompaniment = 0, allLow = 0, allPower = 0, drumLow = 0, bassLow = 0, drumAttack = false;
        const leadPower = leadPresence * power[lead.i];
        for (const [i, track] of tracks.entries()) {
            if (track.muted)
                continue;
            if (i !== lead.i)
                accompaniment += (features[i].presenceEnergy[window] ?? 0) * power[i];
            const low = (features[i].lowEnergy[window] ?? 0) * power[i];
            allLow += low;
            allPower += (features[i].bodyRms[window] ?? 0) ** 2 * power[i];
            if (track.role === 'drums') {
                drumLow += low;
                drumAttack ||= !!features[i].attack[window];
            }
            if (track.role === 'bass')
                bassLow += low;
        }
        if (accompaniment > 1e-10) relativeAfter[window] = Math.max(-120,Math.min(120,10*Math.log10(Math.max(1e-20,leadPower)/accompaniment)));
        const relativeDb = 10 * Math.log10(Math.max(1e-20, leadPower) / Math.max(1e-20, accompaniment));
        if (relativeDb < -4 && accompaniment > 1e-10) {
            const desired = Math.min(2, (-3 - relativeDb) * 0.4);
            let remaining = 0;
            for (const [i, track] of tracks.entries()) {
                const energy = (features[i].presenceEnergy[window] ?? 0) * power[i];
                let reduction = 0;
                if (!track.muted && i !== lead.i && energy >= accompaniment * 0.04 && track.role !== 'bass') {
                    const backing = track.role === 'vocal' && track.vocalRole === 'backing';
                    const limit = track.role === 'vocal' ? backing ? 1 : 0 :
                        track.role === 'drums' ? features[i].attack[window] ? 0 : 0.7 : 2;
                    reduction = Math.min(limit, desired);
                }
                curves[i].presenceDb[window] = -reduction;
                if (i !== lead.i && !track.muted)
                    remaining += energy * 10 ** (-reduction / 10);
            }
            const improvement = 10 * Math.log10(accompaniment / Math.max(1e-20, remaining));
            relativeAfter[window] = Math.max(-120,Math.min(120,relativeDb+improvement));
            if (improvement > 0.05) {
                report.maskedSeconds += duration;
                improved += improvement;
                improvedWindows++;
            }
            else
                for (const curve of curves)
                    curve.presenceDb[window] = 0;
        }
        // Only a strong kick/bass low-band collision in a sung passage permits a short bass cut.
        if (drumAttack && drumLow > Math.max(1e-10, maxDrumLow * 0.15) &&
            drumLow > allLow * 0.3 && bassLow > allLow * 0.3 && allLow > allPower * 0.4) {
            for (const [i, track] of tracks.entries()) {
                if (track.role === 'bass' && !track.muted && (features[i].lowEnergy[window] ?? 0) * power[i] > bassLow * 0.15)
                    curves[i].lowDb[window] = -Math.min(1, 2 * bassLow / Math.max(1e-20, allLow));
            }
        }
        for (const [i, curve] of curves.entries()) {
            const item = report.tracks[i], p = -curve.presenceDb[window], l = -curve.lowDb[window];
            if (p > 0)
                item.presenceSeconds += duration;
            if (l > 0)
                item.lowSeconds += duration;
            item.maxPresenceReductionDb = Math.max(item.maxPresenceReductionDb, p);
            item.maxLowReductionDb = Math.max(item.maxLowReductionDb, l);
        }
    }
    if (options.vocalSupport !== false) {
        const support = planStemVocalSupport(leadFeatures,relativeAfter,{signal:options.signal});
        if (support.seconds > 0) {
            curves[lead.i].gainDb = support.gainDb;
            report.tracks[lead.i].supportSeconds = support.seconds;
            report.tracks[lead.i].maxSupportGainDb = support.maxGainDb;
            report.explanations.push('短く引っ込む歌声を約' + support.seconds.toFixed(1) + '秒、控えめに支える計画を作りました。');
        } else if (leadFeatures.bodyEnergy) {
            report.reasons.push('歌声を追加で持ち上げる必要を確認できず、歌声の音量を保ちました。');
        }
    }
    report.projectedPresenceImprovementDb = improvedWindows ? improved / improvedWindows : 0;
    const changed = report.tracks.some(track => track.presenceSeconds > 0 || track.lowSeconds > 0 || (track.supportSeconds ?? 0) > 0);
    report.status = changed ? 'applied' : 'skipped';
    if (report.maskedSeconds > 0)
        report.explanations.push('歌が埋もれる約' + report.maskedSeconds.toFixed(1) + '秒で、重なる伴奏の帯域を控えめに整理する計画を作りました。');
    if (report.tracks.some(track => track.lowSeconds > 0))
        report.explanations.push('歌のある区間でキックとベースの低域が重なる立ち上がりだけ、ベースの低域を少し控える計画を作りました。');
    if (!changed)
        report.reasons.push(report.activeLeadSeconds ? 'メインボーカルと伴奏の重なりに大きな偏りがないため、音量比を保ちました。' : '十分なメインボーカルの活動を測れず、音量比を保ちました。');
    return finish();
}
