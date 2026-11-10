import { createBiquad } from '@music-sync/dsp';
import type { AudioData } from '@music-sync/shared';
export interface StemClarityFeatures {
    sampleRate: number;
    channels: number;
    frames: number;
    windowFrames: number;
    presenceEnergy: Float32Array;
    /** Midbody energy; absent in legacy feature objects. */
    bodyEnergy?: Float32Array;
    lowEnergy: Float32Array;
    bodyRms: Float32Array;
    attack: Uint8Array;
    clippedSamples?: number;
}
function bandpass(rate: number, frequency: number, q: number) {
    const w = 2 * Math.PI * frequency / rate;
    const alpha = Math.sin(w) / (2 * q), divisor = 1 + alpha;
    return createBiquad([alpha / divisor, 0, -alpha / divisor, -2 * Math.cos(w) / divisor, (1 - alpha) / divisor]);
}
/** Incremental role-neutral measurements. A song retains only 20 energy windows per second. */
export function createStemClarityAnalyzer(sampleRate: number, channels: number, frames: number) {
    if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000 ||
        ![1, 2].includes(channels) || !Number.isInteger(frames) || frames < 1 || frames > sampleRate * 1200)
        throw new Error('STEMの明瞭さ解析の形式が不正です。');
    const windowFrames = Math.round(sampleRate * 0.05), count = Math.ceil(frames / windowFrames);
    const presenceEnergy = new Float32Array(count), lowEnergy = new Float32Array(count), bodyEnergy = new Float32Array(count);
    const bodyRms = new Float32Array(count), attack = new Uint8Array(count);
    const filters = Array.from({ length: channels }, () => ({
        presence: bandpass(sampleRate, Math.min(2300, sampleRate * 0.3), 0.65),
        low: bandpass(sampleRate, 100, 0.9),
        body: bandpass(sampleRate, 700, 0.5),
    }));
    let offset = 0, fill = 0, index = 0, presence = 0, low = 0, body = 0, power = 0, previous = 0, clippedSamples = 0, ended = false;
    function flush() {
        const rms = Math.sqrt(power / (fill * channels));
        presenceEnergy[index] = presence / (fill * channels);
        lowEnergy[index] = low / (fill * channels);
        bodyRms[index] = rms;
        bodyEnergy[index] = body / (fill * channels);
        attack[index] = rms > 1e-5 && rms > previous * 1.8 ? 1 : 0;
        previous = rms;
        index++;
        fill = 0;
        presence = low = body = power = 0;
    }
    return {
        push(audio: AudioData) {
            const length = audio.channels[0]?.length ?? 0;
            if (ended || audio.sampleRate !== sampleRate || audio.channels.length !== channels || !length ||
                offset + length > frames || audio.channels.some(channel => !(channel instanceof Float32Array) || channel.length !== length))
                throw new Error('STEMの明瞭さ解析のチャンクが不正です。');
            for (let i = 0; i < length; i++) {
                for (let c = 0; c < channels; c++) {
                    const value = audio.channels[c][i];
                    if (!Number.isFinite(value) || Math.abs(value) > 32)
                        throw new Error('STEMに不正なサンプル値があります。');
                    if (Math.abs(value) >= 1)
                        clippedSamples++;
                    const p = filters[c].presence(value), l = filters[c].low(value), b = filters[c].body(value);
                    presence += p * p;
                    low += l * l;
                    body += b * b;
                    power += value * value;
                }
                offset++;
                fill++;
                if (fill === windowFrames)
                    flush();
            }
        },
        finish(): StemClarityFeatures {
            if (ended || offset !== frames)
                throw new Error('STEMの明瞭さ解析が完了していません。');
            if (fill)
                flush();
            ended = true;
            return { sampleRate, channels, frames, windowFrames, presenceEnergy, lowEnergy, bodyEnergy, bodyRms, attack, clippedSamples };
        },
    };
}
