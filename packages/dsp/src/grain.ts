import type { AudioData } from '@music-sync/shared';
import { fft } from './fft.js';
export interface GrainSettings {
    mode: 'light' | 'standard' | 'strong';
    amount: number;
}
export interface GrainProcessorReport {
    affectedSeconds: number;
    analyzedSeconds: number;
    estimatedResidualReductionDb: number;
    maximumAttenuationDb: number;
}
const clamp = (value: number) => Math.max(0, Math.min(1, value));
const depths = { light: 2, standard: 4, strong: 6 } as const;
/** Offline streaming WOLA. Outputs retain original sample positions after finish().
 * Retained PCM is bounded by the transform and output block sizes. Callers should
 * consume each push result before supplying another bounded input block.
 */
export function createGrainProcessor(rate: number, channels: number, settings: GrainSettings, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (!Number.isInteger(rate) || rate < 8000 || rate > 192000 || ![1, 2].includes(channels) ||
        !settings || !Object.hasOwn(depths, settings.mode) || !Number.isFinite(settings.amount) ||
        settings.amount < 0 || settings.amount > 100)
        throw new Error('Invalid grain processing format or settings');
    const size = 2 ** Math.round(Math.log2(rate * 0.04)), hop = size / 4;
    const maximumAttenuationDb = depths[settings.mode] * settings.amount / 100;
    const bypass = rate < 16000 || maximumAttenuationDb === 0;
    const pcm = Array.from({ length: channels }, () => new Float32Array(size));
    const real = pcm.map(() => new Float64Array(size)), imag = pcm.map(() => new Float64Array(size));
    const delta = pcm.map(() => new Float64Array(size));
    const norm = new Float64Array(size), coverage = new Float64Array(size);
    const window = Float64Array.from({ length: size }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / size));
    const powers = new Float64Array(size / 2 + 1), protectedBins = new Uint8Array(size / 2 + 1);
    const minimumBin = Math.max(1, Math.ceil(2000 * size / rate));
    const maximumBin = Math.min(size / 2 - 1, Math.floor(Math.min(11500, rate * 0.45) * size / rate));
    const bandBins = maximumBin - minimumBin + 1;
    const sorted = new Float64Array(Math.max(1, bandBins));
    const history = new Float64Array(Math.max(2, Math.ceil(rate * 0.08 / hop)));
    let historyCount = 0, received = 0, emitted = 0, fill = 0, position = -(size - hop), ended = false;
    let hold = 0, sustained = 0, wet = 0, affected = 0, noiseBefore = 0, noiseAfter = 0;
    let output = Array.from({ length: channels }, () => new Float32Array(4096)), outputFill = 0;
    let ready: AudioData[] = [];
    function emit(values: readonly Float32Array[], count: number) {
        for (let offset = 0; offset < count;) {
            const n = Math.min(4096 - outputFill, count - offset);
            values.forEach((ch, c) => output[c].set(ch.subarray(offset, offset + n), outputFill));
            outputFill += n;
            offset += n;
            if (outputFill === 4096) {
                ready.push({ sampleRate: rate, channels: output });
                output = Array.from({ length: channels }, () => new Float32Array(4096));
                outputFill = 0;
            }
        }
    }
    function processWindow() {
        signal?.throwIfAborted();
        const quarters = [0, 0, 0, 0];
        for (let c = 0; c < channels; c++) {
            imag[c].fill(0);
            for (let i = 0; i < size; i++) {
                real[c][i] = pcm[c][i] * window[i];
                if (i)
                    quarters[Math.floor(i * 4 / size)] += (pcm[c][i] - pcm[c][i - 1]) ** 2;
            }
            fft(real[c], imag[c]);
        }
        powers.fill(0);
        for (let k = 1; k <= size / 2; k++)
            for (let c = 0; c < channels; c++)
                powers[k] += real[c][k] ** 2 + imag[c][k] ** 2;
        let bandPower = 0, bodyPower = 0;
        for (let k = 1; k < minimumBin; k++)
            bodyPower += powers[k];
        for (let k = minimumBin; k <= maximumBin; k++) {
            bandPower += powers[k];
            sorted[k - minimumBin] = powers[k];
        }
        sorted.sort();
        const floor = sorted[Math.floor(sorted.length * 0.3)] * 2.8;
        const floorPower = floor * bandBins;
        protectedBins.fill(0);
        for (let k = minimumBin; k <= maximumBin; k++) {
            if (powers[k] < floor * 16 || powers[k] < powers[k - 1] || powers[k] < powers[k + 1])
                continue;
            for (let j = Math.max(1, k - 3); j <= Math.min(size / 2 - 1, k + 3); j++)
                protectedBins[j] = 1;
        }
        let harmonicPower = 0;
        for (let k = minimumBin; k <= maximumBin; k++)
            if (protectedBins[k])
                harmonicPower += powers[k];
        // Follow voiced/instrumental phrasing faster while leaving noise-only consonants and cymbals guarded.
        const tonal = harmonicPower > bandPower * 0.25;
        const profile = tonal ? ({ light: [0.1, 0.08, 0.3, 3], standard: [0.06, 0.04, 0.2, 5], strong: [0.025, 0.02, 0.08, 12] } as const)[settings.mode] : [0.18, 0.1, 0.55, 1.8];
        // Normalize to the musical body so ordinary phrasing does not resemble a new noise burst.
        const relative = bodyPower > bandPower * 0.05 ? floorPower / Math.max(1e-20, bodyPower) : floor / size ** 2;
        const previous = history[historyCount % history.length];
        const stable = historyCount < history.length || relative >= previous * profile[2] && relative <= previous * profile[3];
        history[historyCount++ % history.length] = relative;
        const transient = quarters.some((power, i) => i > 0 &&
            (power > 4.5 * Math.max(1e-20, quarters[i - 1]) || quarters[i - 1] > 4.5 * Math.max(1e-20, power)));
        if (tonal)
            hold = Math.min(hold, Math.ceil(rate * profile[0] / hop));
        if (transient)
            hold = Math.ceil(rate * profile[0] / hop);
        else
            hold = Math.max(0, hold - 1);
        const noisy = floor / size ** 2 > 1e-11 && floorPower > bodyPower * 0.0025 && stable && !hold;
        sustained = noisy ? sustained + 1 : 0;
        const targetWet = sustained * hop / rate >= profile[1] ? 1 : 0;
        wet += (targetWet > wet ? 0.35 : 1) * (targetWet - wet);
        let active = false;
        const lowerGain = 10 ** (-maximumAttenuationDb / 20);
        for (let k = 1; k < size / 2; k++) {
            let weight = 0;
            if (k >= minimumBin && k <= maximumBin && !protectedBins[k] && wet > 1e-6) {
                const hz = k * rate / size;
                const bandEdge = Math.min(clamp((hz - 1800) / 700), clamp((Math.min(12500, rate * 0.48) - hz) / 1500));
                // Smooth attenuation of bins near the estimated floor; high harmonics stay dry.
                weight = wet * bandEdge * clamp((floor * 16 - powers[k]) / Math.max(floor * 12, 1e-30));
            }
            const gain = 1 - (1 - lowerGain) * weight;
            if (weight > 0) {
                active = true;
                noiseBefore += Math.min(floor, powers[k]);
                noiseAfter += Math.min(floor, powers[k]) * gain * gain;
            }
            for (let c = 0; c < channels; c++) {
                real[c][k] *= gain - 1;
                imag[c][k] *= gain - 1;
                real[c][size - k] *= gain - 1;
                imag[c][size - k] *= gain - 1;
            }
        }
        for (let c = 0; c < channels; c++) {
            real[c][0] = imag[c][0] = real[c][size / 2] = imag[c][size / 2] = 0;
            if (active) {
                for (let i = 0; i < size; i++)
                    imag[c][i] = -imag[c][i];
                fft(real[c], imag[c]);
                for (let i = 0; i < size; i++)
                    delta[c][i] += real[c][i] / size * window[i];
            }
        }
        for (let i = 0; i < size; i++) {
            const power = window[i] ** 2;
            norm[i] += power;
            if (active)
                coverage[i] += power * wet;
        }
        if (position >= 0) {
            const n = Math.min(hop, received - position);
            if (n > 0) {
                const block = pcm.map(() => new Float32Array(n));
                for (let i = 0; i < n; i++) {
                    const denominator = Math.max(norm[i], 1e-20);
                    for (let c = 0; c < channels; c++)
                        block[c][i] = pcm[c][i] + delta[c][i] / denominator;
                    if (coverage[i] / denominator > 0.02)
                        affected++;
                }
                emit(block, n);
                emitted += n;
            }
        }
        for (let c = 0; c < channels; c++) {
            pcm[c].copyWithin(0, hop);
            pcm[c].fill(0, size - hop);
            delta[c].copyWithin(0, hop);
            delta[c].fill(0, size - hop);
        }
        norm.copyWithin(0, hop);
        norm.fill(0, size - hop);
        coverage.copyWithin(0, hop);
        coverage.fill(0, size - hop);
        position += hop;
    }
    return {
        push(audio: AudioData): AudioData[] {
            signal?.throwIfAborted();
            if (ended)
                throw new Error('Grain processor already finalized');
            const frames = audio.channels[0]?.length ?? 0;
            if (audio.sampleRate !== rate || audio.channels.length !== channels || !frames ||
                audio.channels.some(ch => !(ch instanceof Float32Array) || ch.length !== frames))
                throw new Error('Grain input format changed');
            for (const channel of audio.channels)
                for (const value of channel)
                    if (!Number.isFinite(value) || Math.abs(value) > 32)
                        throw new Error('Invalid grain input sample');
            ready = [];
            if (bypass) {
                received += frames;
                emitted += frames;
                emit(audio.channels, frames);
                return ready;
            }
            for (let offset = 0; offset < frames;) {
                const n = Math.min(hop - fill, frames - offset);
                for (let c = 0; c < channels; c++)
                    pcm[c].set(audio.channels[c].subarray(offset, offset + n), size - hop + fill);
                fill += n;
                offset += n;
                received += n;
                if (fill === hop) {
                    processWindow();
                    fill = 0;
                }
            }
            return ready;
        },
        finish(): AudioData[] {
            signal?.throwIfAborted();
            if (ended)
                throw new Error('Grain processor already finalized');
            ended = true;
            ready = [];
            if (!bypass) {
                if (fill) {
                    processWindow();
                    fill = 0;
                }
                while (emitted < received)
                    processWindow();
            }
            if (outputFill) {
                ready.push({ sampleRate: rate, channels: output.map(ch => ch.slice(0, outputFill)) });
                outputFill = 0;
            }
            return ready;
        },
        report(): GrainProcessorReport {
            return { affectedSeconds: affected / rate, analyzedSeconds: received / rate, maximumAttenuationDb,
                estimatedResidualReductionDb: noiseBefore > 0 ? -10 * Math.log10(Math.max(1e-20, noiseAfter / noiseBefore)) : 0 };
        },
    };
}
