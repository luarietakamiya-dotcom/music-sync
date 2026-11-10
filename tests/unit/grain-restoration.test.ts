import { expect, it } from 'vitest';
import { applyGrainRestoration, prepareGrainRestoration, autoMixMaster, type AudioData } from '@music-sync/core';
it('applies the same spectral repair to each STEM before aligned summing', async () => {
    const { renderFileStems, mixStems } = await import('@music-sync/core');
    const audio = fixture(), controls = { grain: 'strong' as const, amount: 100 };
    const tracks = ['voice', 'music'].map((id, index) => ({
        descriptor: { id, name: id, role: index === 0 ? 'vocal' as const : 'instrumental' as const, sampleRate: audio.sampleRate,
            channels: 1, frames: audio.channels[0].length, gainDb: -6, pan: 0, muted: false },
        audio,
        async *open() {
            for (let i = 0; i < audio.channels[0].length; i += 65536)
                yield { ...audio, channels: [audio.channels[0].subarray(i, i + 65536)] };
        },
    }));
    const expected = mixStems(tracks.map(track => ({ descriptor: track.descriptor, audio: applyGrainRestoration(audio, controls).audio }))).audio;
    let offset = 0;
    const result = await renderFileStems(tracks, { mode: 'vocal-instrumental', autoBalance: false, blockFrames: 65536,
        studio: { restore: true, treble: 'off', repair: controls, doubleAmount: 0, doubleMs: 30 },
        async write(block) {
            block.channels.forEach((channel, c) => expect(channel).toEqual(expected.channels[c].subarray(offset, offset + channel.length)));
            offset += block.channels[0].length;
        } });
    expect(offset).toBe(audio.channels[0].length);
    expect(result.report.warnings.join(' ')).toContain('音程の芯');
});
function fixture(): AudioData {
    let seed = 31, state = 0;
    const sampleRate = 48000;
    const channel = Float32Array.from({ length: sampleRate * 3 + 317 }, (_, i) => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        const white = (seed / 2 ** 32 - 0.5) * 0.16;
        state += 0.28 * (white - state);
        const t = i / sampleRate, envelope = 0.35 + 0.65 * Math.abs(Math.sin(2 * Math.PI * 3 * t));
        return envelope * (0.11 * Math.sin(2 * Math.PI * 220 * t) + 0.04 * Math.sin(2 * Math.PI * 3300 * t) + 0.024 * Math.sin(2 * Math.PI * 4400 * t) + white - state);
    });
    return { sampleRate, channels: [channel] };
}
it('accepts measured grain correction on a changing musical envelope and preserves the source', async () => {
    const input = fixture(), saved = input.channels[0].slice(), controls = { grain: 'strong' as const, amount: 100 };
    const short = applyGrainRestoration(input, controls);
    expect(short.report.status).toBe('applied');
    expect(short.report.seconds).toBeGreaterThan(1);
    expect(short.report.estimatedResidualReductionDb).toBeGreaterThan(1.5);
    const open = async function* () {
        for (let i = 0; i < saved.length; i += 1177)
            yield { ...input, channels: [saved.subarray(i, i + 1177)] };
    };
    const stream = await prepareGrainRestoration({ sampleRate: input.sampleRate, channels: 1, frames: saved.length, open }, controls);
    expect(stream.report).toEqual(short.report);
    const actual = new Float32Array(saved.length);
    let offset = 0;
    for await (const block of stream.open()) {
        actual.set(block.channels[0], offset);
        offset += block.channels[0].length;
    }
    expect(offset).toBe(saved.length);
    expect(actual).toEqual(short.audio.channels[0]);
    expect(input.channels[0]).toEqual(saved);
});
it('bypasses explicit off and amount zero and cancels a source pass', async () => {
    const input = fixture();
    expect(applyGrainRestoration(input, { grain: 'off' }).audio).toBe(input);
    expect(applyGrainRestoration(input, { grain: 'strong', amount: 0 }).audio).toBe(input);
    const abort = new AbortController();
    const open = async function* () {
        yield { ...input, channels: [input.channels[0].subarray(0, 4096)] };
        abort.abort();
        yield { ...input, channels: [input.channels[0].subarray(4096)] };
    };
    await expect(prepareGrainRestoration({ sampleRate: 48000, channels: 1, frames: input.channels[0].length, open }, { grain: 'strong' }, { signal: abort.signal })).rejects.toThrow();
});
it('reports the actual adopted restoration through the automatic engine', () => {
    const input = fixture(), saved = input.channels[0].slice();
    const result = autoMixMaster(input, 'AUTO', { treble: 'off', repairControls: { grain: 'strong', amount: 100 } });
    expect(result.status).toBe('accepted');
    expect(result.grain?.status).toBe('applied');
    expect(result.explanations.join(' ')).toContain('雑音成分');
    expect(result.processed?.audio.channels[0].length).toBe(saved.length);
    expect(input.channels[0]).toEqual(saved);
});
