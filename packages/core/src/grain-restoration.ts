import { analyzeAudio, StreamingAudioAnalyzer } from '@music-sync/audio-analysis';
import { createGrainProcessor, type GrainProcessorReport, type GrainSettings } from '@music-sync/dsp';
import { validateAudio, type AnalysisResult, type AudioData } from '@music-sync/shared';
import { bounded, type RepairControls } from './studio-settings.js';
export interface GrainRestorationReport {
    inheritedTracks?: number;
    mode: RepairControls['grain'];
    status: 'skipped' | 'applied' | 'reverted';
    seconds: number;
    estimatedResidualReductionDb: number;
    rmsChangeDb: number;
    explanation: string;
    reasons: string[];
}
export interface GrainSource {
    sampleRate: number;
    channels: number;
    frames: number;
    open(): AsyncIterable<AudioData>;
}
function configuration(controls: RepairControls = {}): GrainSettings | undefined {
    if (!['off', 'light', 'standard', 'strong'].includes(controls.grain ?? 'off'))
        throw new Error('ざらつき除去のモードが不正です。');
    const amount = bounded(controls.amount ?? 100, 0, 100);
    return controls.grain && controls.grain !== 'off' && amount > 0 ? { mode: controls.grain, amount } : undefined;
}
function skipped(controls?: RepairControls): GrainRestorationReport {
    return { mode: controls?.grain ?? 'off', status: 'skipped', seconds: 0, estimatedResidualReductionDb: 0, rmsChangeDb: 0,
        explanation: 'ジャリつきのスペクトル補修は適用していません。', reasons: [] };
}
function evaluate(before: AnalysisResult, after: AnalysisResult, stats: GrainProcessorReport, mode: RepairControls['grain']): GrainRestorationReport {
    const rmsChangeDb = after.rmsDbfs !== null && before.rmsDbfs !== null ? after.rmsDbfs - before.rmsDbfs : 0;
    const reasons: string[] = [];
    if (after.frames !== before.frames || after.channels !== before.channels || after.sampleRate !== before.sampleRate)
        reasons.push('音源の長さ・形式が変わりました。');
    if (after.clippedSamples > before.clippedSamples || (before.clippedSamples === 0 && (after.truePeakDbtp ?? 0) > 0))
        reasons.push('新しいクリッピングやピーク超過を検出しました。');
    if (rmsChangeDb < -3 || rmsChangeDb > 0.25)
        reasons.push('平均レベルの変化が大きすぎました。');
    if (after.crestFactorDb !== null && before.crestFactorDb !== null && after.crestFactorDb < before.crestFactorDb - 2)
        reasons.push('立ち上がりの強弱が減りすぎました。');
    if (before.stereoCorrelation !== null && (after.stereoCorrelation ?? -1) < before.stereoCorrelation - 0.06)
        reasons.push('ステレオの安定性が低下しました。');
    if (Math.abs((before.sideEnergyPercent ?? 0) - (after.sideEnergyPercent ?? 0)) > 4)
        reasons.push('広がりが変化しすぎました。');
    if (after.dcOffset.some((x, c) => !Number.isFinite(x) || Math.abs(x) > Math.max(0.003, Math.abs(before.dcOffset[c]) + 0.001)))
        reasons.push('DCオフセットが増えました。');
    if (![rmsChangeDb, stats.affectedSeconds, stats.estimatedResidualReductionDb].every(Number.isFinite))
        reasons.push('補修の測定値が不正です。');
    const affected = stats.affectedSeconds >= Math.min(0.1, before.durationSeconds * 0.1) && stats.estimatedResidualReductionDb >= 0.15;
    const status = reasons.length ? 'reverted' : affected ? 'applied' : 'skipped';
    return { mode, status, seconds: status === 'applied' ? stats.affectedSeconds : 0,
        estimatedResidualReductionDb: status === 'applied' ? stats.estimatedResidualReductionDb : 0, rmsChangeDb,
        reasons, explanation: status === 'applied' ? '音程の芯の周囲にある雑音成分を約' + stats.affectedSeconds.toFixed(1) + '秒で抑えました。' :
            status === 'reverted' ? 'ジャリつき補修後の保護条件を満たさず、補修を見送りました。' : 'ジャリつき補修が必要な成分を十分に検出できず、補修を見送りました。' };
}
/** New aligned chunks with constant bounded memory. Processor latency is trimmed by its finish(). */
async function* restoredChunks(source: GrainSource, settings: GrainSettings, signal?: AbortSignal): AsyncGenerator<AudioData> {
    const processor = createGrainProcessor(source.sampleRate, source.channels, settings, signal);
    const blockFrames = 65536;
    let output = Array.from({ length: source.channels }, () => new Float32Array(blockFrames)), fill = 0, written = 0;
    function* pack(chunks: AudioData[]) {
        for (const chunk of chunks)
            for (let offset = 0; offset < chunk.channels[0].length;) {
                const count = Math.min(blockFrames - fill, chunk.channels[0].length - offset);
                chunk.channels.forEach((ch, c) => output[c].set(ch.subarray(offset, offset + count), fill));
                fill += count;
                offset += count;
                written += count;
                if (fill === blockFrames) {
                    yield { sampleRate: source.sampleRate, channels: output };
                    output = Array.from({ length: source.channels }, () => new Float32Array(blockFrames));
                    fill = 0;
                }
            }
    }
    for await (const input of source.open()) {
        signal?.throwIfAborted();
        yield* pack(processor.push(input));
    }
    yield* pack(processor.finish());
    if (written !== source.frames)
        throw new Error('ジャリつき補修の出力長が一致しません。');
    if (fill)
        yield { sampleRate: source.sampleRate, channels: output.map(ch => ch.subarray(0, fill)) };
}
/** Measure one full candidate first. Every later read deterministically replays the accepted repair. */
export async function prepareGrainRestoration(source: GrainSource, controls?: RepairControls, options: {
    signal?: AbortSignal;
    onProgress?: (fraction: number) => void;
} = {}) {
    const settings = configuration(controls);
    const base = skipped(controls);
    const original = () => source.open();
    options.signal?.throwIfAborted();
    if (!settings || source.sampleRate < 16000)
        return { report: base, open: original };
    const processor = createGrainProcessor(source.sampleRate, source.channels, settings, options.signal);
    const before = new StreamingAudioAnalyzer(source.sampleRate, source.channels, source.frames);
    const after = new StreamingAudioAnalyzer(source.sampleRate, source.channels, source.frames);
    let read = 0;
    for await (const chunk of source.open()) {
        options.signal?.throwIfAborted();
        before.push(chunk);
        for (const output of processor.push(chunk))
            after.push(output);
        read += chunk.channels[0].length;
        options.onProgress?.(read / source.frames);
    }
    for (const output of processor.finish())
        after.push(output);
    options.signal?.throwIfAborted();
    const report = evaluate(before.finish(), after.finish(), processor.report(), settings.mode);
    return { report, open: report.status === 'applied' ? () => restoredChunks(source, settings, options.signal) : original };
}
export function applyGrainRestoration(input: AudioData, controls?: RepairControls, options: {
    signal?: AbortSignal;
    before?: AnalysisResult;
} = {}) {
    validateAudio(input);
    options.signal?.throwIfAborted();
    const settings = configuration(controls), base = skipped(controls);
    if (!settings || input.sampleRate < 16000)
        return { audio: input, report: base };
    const before = options.before ?? analyzeAudio(input), frames = input.channels[0].length;
    const processor = createGrainProcessor(input.sampleRate, input.channels.length, settings, options.signal);
    const channels = input.channels.map(() => new Float32Array(frames));
    let written = 0;
    const append = (chunks: AudioData[]) => {
        for (const chunk of chunks) {
            if (written + chunk.channels[0].length > frames)
                throw new Error('ジャリつき補修の出力長が不正です。');
            chunk.channels.forEach((ch, c) => channels[c].set(ch, written));
            written += chunk.channels[0].length;
        }
    };
    for (let offset = 0; offset < frames; offset += 65536) {
        options.signal?.throwIfAborted();
        append(processor.push({ sampleRate: input.sampleRate, channels: input.channels.map(ch => ch.subarray(offset, offset + 65536)) }));
    }
    append(processor.finish());
    options.signal?.throwIfAborted();
    if (written !== frames)
        throw new Error('ジャリつき補修の出力長が一致しません。');
    const audio = { sampleRate: input.sampleRate, channels };
    const report = evaluate(before, analyzeAudio(audio), processor.report(), settings.mode);
    return { audio: report.status === 'applied' ? audio : input, report };
}
