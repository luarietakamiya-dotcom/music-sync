import { expect, it } from 'vitest';
import type { AudioData } from '@music-sync/shared';
import { createGrainProcessor, type GrainSettings } from '../../packages/dsp/src/grain';
import { fft } from '../../packages/dsp/src/fft';
const rate = 48000;
function fixture(noisy = true, moving = false) {
    const n = 4096, re = new Float64Array(n), im = new Float64Array(n);
    let seed = 37;
    for (let k = 1; k < n / 2; k++) {
        const hz = k * rate / n;
        if (hz < 2500 || hz > 10500)
            continue;
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        const phase = 2 * Math.PI * seed / 2 ** 32;
        re[k] = re[n - k] = Math.cos(phase);
        im[k] = Math.sin(phase);
        im[n - k] = -im[k];
    }
    fft(re, im);
    const rms = Math.sqrt(re.reduce((sum, v) => sum + v * v, 0) / n);
    const clean = new Float32Array(rate * 3 + 317), dry = new Float32Array(clean.length);
    for (let i = 0; i < clean.length; i++) {
        const t = i / rate, envelope = moving ? .35 + .65 * Math.abs(Math.sin(2 * Math.PI * 3 * t)) : 1;
        clean[i] = envelope * (.1 * Math.sin(2 * Math.PI * 220 * t) + .04 * Math.sin(2 * Math.PI * 3300 * t) + .024 * Math.sin(2 * Math.PI * 4400 * t));
        dry[i] = clean[i] + (noisy ? envelope * re[i % n] / rms * .023 : 0);
    }
    return { clean, audio: { sampleRate: rate, channels: [dry] } };
}
function run(input: AudioData, mode: GrainSettings['mode'] = 'strong', amount = 100, step = 65536) {
    const processor = createGrainProcessor(input.sampleRate, input.channels.length, { mode, amount });
    const channels = input.channels.map(ch => new Float32Array(ch.length));
    let offset = 0;
    const copy = (blocks: AudioData[]) => {
        for (const block of blocks) {
            expect(block.channels[0].length).toBeLessThanOrEqual(4096);
            block.channels.forEach((ch, c) => channels[c].set(ch, offset));
            offset += block.channels[0].length;
        }
    };
    for (let i = 0; i < input.channels[0].length; i += step)
        copy(processor.push({ sampleRate: input.sampleRate, channels: input.channels.map(ch => ch.subarray(i, i + step)) }));
    copy(processor.finish());
    expect(offset).toBe(input.channels[0].length);
    return { channels, report: processor.report() };
}
function projection(samples: Float32Array, hz: number) {
    let re = 0, im = 0;
    for (let i = rate; i < rate * 2; i++) {
        re += samples[i] * Math.cos(2 * Math.PI * hz * i / rate);
        im += samples[i] * Math.sin(2 * Math.PI * hz * i / rate);
    }
    return Math.hypot(re, im);
}
function residual(samples: Float32Array, clean: Float32Array) {
    let energy = 0;
    for (let i = 0; i < samples.length; i++)
        energy += (samples[i] - clean[i]) ** 2;
    return energy;
}
it('reduces mixed harmonic grain while protecting wanted partials and natural phrasing', () => {
    for (const moving of [false, true]) {
        const { audio, clean } = fixture(true, moving), original = audio.channels[0].slice();
        const wet = run(audio);
        const reduction = 10 * Math.log10(residual(original, clean) / residual(wet.channels[0], clean));
        expect(reduction).toBeGreaterThan(1.5);
        for (const hz of [220, 3300, 4400])
            expect(Math.abs(20 * Math.log10(projection(wet.channels[0], hz) / projection(original, hz)))).toBeLessThan(.5);
        expect(audio.channels[0]).toEqual(original);
        expect(wet.report.affectedSeconds).toBeGreaterThan(2);
        expect(wet.report.affectedSeconds).toBeLessThanOrEqual(original.length / rate);
        expect(wet.report.estimatedResidualReductionDb).toBeGreaterThan(2);
    }
});
it('is sample-identical across arbitrary chunks and preserves stereo timing and mono compatibility', () => {
    const { audio } = fixture();
    const stereo = { sampleRate: rate, channels: [audio.channels[0], audio.channels[0].map(v => v * .6)] };
    const a = run(stereo, 'strong', 100, 317), b = run(stereo, 'strong', 100, 65536);
    expect(a.channels).toEqual(b.channels);
    for (let i = 0; i < a.channels[0].length; i += 997)
        expect(Math.abs(a.channels[1][i] - a.channels[0][i] * .6)).toBeLessThan(1e-7);
});
it('keeps clean harmonics, impulses, silence, zero amount and low-rate inputs dry through the last sample', () => {
    const clean = fixture(false).audio;
    expect(run(clean).channels).toEqual(clean.channels);
    const impulse = new Float32Array(12347);
    impulse[0] = .5;
    impulse[613] = -.3;
    impulse[impulse.length - 1] = .4;
    for (const samples of [impulse, new Float32Array(317)])
        expect(run({ sampleRate: rate, channels: [samples] }, 'strong', 100, 53).channels[0]).toEqual(samples);
    const noisy = fixture().audio;
    expect(run(noisy, 'strong', 0, 499).channels).toEqual(noisy.channels);
    expect(run({ ...noisy, sampleRate: 8000 }, 'strong', 100, 499).channels).toEqual(noisy.channels);
    let seed = 17, previous = 0;
    const cymbal = Float32Array.from({ length: rate * 2 }, (_, i) => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        const random = seed / 2 ** 32 - .5;
        const sample = .12 * Math.sin(2 * Math.PI * 220 * i / rate) + .35 * (random - previous) * Math.exp(-i / (rate * .16));
        previous = random;
        return sample;
    });
    expect(run({ sampleRate: rate, channels: [cymbal] }, 'strong', 100, 317).channels[0]).toEqual(cymbal);
});
it('orders attenuation modes within their caps and supports cancellation', () => {
    const { audio, clean } = fixture();
    const reductions = (['light', 'standard', 'strong'] as const).map(mode => {
        const result = run(audio, mode);
        expect(result.report.estimatedResidualReductionDb).toBeLessThanOrEqual(result.report.maximumAttenuationDb + 1e-6);
        return residual(result.channels[0], clean);
    });
    expect(reductions[2]).toBeLessThan(reductions[1]);
    expect(reductions[1]).toBeLessThan(reductions[0]);
    const abort = new AbortController();
    const processor = createGrainProcessor(rate, 1, { mode: 'strong', amount: 100 }, abort.signal);
    processor.push({ sampleRate: rate, channels: [audio.channels[0].subarray(0, 4000)] });
    abort.abort();
    expect(() => processor.push(audio)).toThrow();
    expect(() => processor.finish()).toThrow();
});
