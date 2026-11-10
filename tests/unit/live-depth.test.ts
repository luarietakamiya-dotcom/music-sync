import { describe, it, expect } from 'vitest';
import { analyzeAudio, analyzeAdaptiveFeatures, analyzePerceptualFeatures, autoMixMaster, createComparisonPlan, planMixCorrection } from '@music-sync/core';
import { renderMix, type LiveParameters } from '@music-sync/dsp';
import { tone } from '../helpers/audio';
import { perceptualFixture } from '../fixtures/perceptual';

const room: LiveParameters = { venue: 'intimate-room', wet: 0.14, preDelayMs: 22, highpassHz: 200, decaySeconds: 0.65 };
const hall: LiveParameters = { venue: 'small-hall', wet: 0.28, preDelayMs: 24, highpassHz: 200, decaySeconds: 1.1 };
const energy = (samples: Float32Array, from: number, to: number) => samples.slice(from, to).reduce((sum, x) => sum + x * x, 0);

describe('LIVE small-hall depth', () => {
  it.each([8000, 48000, 192000])('adds a denser late tail at %i Hz while keeping direct timing and Original', sampleRate => {
    const impulse = new Float32Array(sampleRate); impulse[0] = 0.5;
    const input = { sampleRate, channels: [impulse, impulse.slice()] };
    const old = renderMix(input, [{ kind: 'live', parameters: room }]);
    const next = renderMix(input, [{ kind: 'live', parameters: hall }]);
    const from = Math.floor(sampleRate * 0.15), to = Math.floor(sampleRate * 0.45);
    expect(energy(next.channels[0], from, to)).toBeGreaterThan(energy(old.channels[0], from, to) * 5);
    expect(next.channels[0][0]).toBe(0.5);
    expect(next.channels[0].slice(1, Math.floor(sampleRate * 0.024)).every(x => x === 0)).toBe(true);
    expect(next.channels[0].at(-1)).toBe(0);
    expect(next.channels.every(c => c.every(Number.isFinite))).toBe(true);
    expect(next.channels[0]).not.toEqual(next.channels[1]);
    expect(impulse[0]).toBe(0.5); expect(impulse.slice(1).every(x => x === 0)).toBe(true);
  });

  it('rejects unsafe/unknown venue parameters and keeps zero-wet a bit-exact bypass', () => {
    const input = tone({ sampleRate: 16000 });
    expect(renderMix(input, [{ kind: 'live', parameters: { ...hall, wet: 0 } }])).toEqual(input);
    for (const bad of [{ wet: 0.31 }, { decaySeconds: 1.5 }, { wet: NaN }, { venue: 'unknown' }])
      expect(() => renderMix(input, [{ kind: 'live', parameters: { ...hall, ...bad } as LiveParameters }])).toThrow('Invalid live');
  });

  it('keeps bass out of the added space instead of widening the dry low end', () => {
    const deltaRms = (frequency: number) => {
      const input = tone({ sampleRate: 16000, seconds: 2, frequency, amplitude: 0.15 });
      const next = renderMix(input, [{ kind: 'live', parameters: { ...hall, highpassHz: 360 } }]);
      let sum = 0;
      for (let i = 8000; i < 24000; i++) sum += (next.channels[0][i] - input.channels[0][i]) ** 2;
      return Math.sqrt(sum / 16000);
    };
    expect(deltaRms(60)).toBeLessThan(deltaRms(1200) * 0.5);
  });

  it('adapts the venue for existing space and reduces effect on bounded retries', () => {
    const input = tone({ sampleRate: 16000, frequency: 700, stereo: true });
    const report = analyzeAudio(input), features = analyzeAdaptiveFeatures(input);
    const get = (side: number, sustain: number, strength = 1) => {
      const plan = planMixCorrection({ ...report, sideEnergyPercent: side }, { ...features, sustainRatio: sustain }, 'LIVE', strength);
      const live = plan.stages.find(s => s.kind === 'live');
      if (live?.kind !== 'live') throw new Error('Missing LIVE');
      return live.parameters;
    };
    const dry = get(15, 0.2), wet = get(40, 0.9), retry = get(15, 0.2, 0.5);
    expect(dry.venue).toBe('small-hall'); expect(wet.venue).toBe('intimate-room');
    expect(wet.wet).toBeLessThan(dry.wet); expect(wet.decaySeconds).toBeLessThan(dry.decaySeconds);
    expect(retry.wet).toBe(dry.wet * 0.5);
  });

  it('does not mistake confidently dry sustained notes for an already reverberant recording', () => {
    const input = perceptualFixture('balanced'), p = analyzePerceptualFeatures(input);
    expect(p.ambienceClass).toBe('Dry'); expect(p.features.ambience.confidence).toBeGreaterThanOrEqual(0.55);
    const mix = planMixCorrection(analyzeAudio(input), { ...analyzeAdaptiveFeatures(input), sustainRatio: 0.9 }, 'LIVE', 1, p);
    const live = mix.stages.find(s => s.kind === 'live');
    if (live?.kind !== 'live') throw new Error('Missing LIVE');
    expect(live.parameters.venue).toBe('small-hall'); expect(live.parameters.wet).toBeGreaterThan(0.18);
  });

  it('retains measurable space after matched A/B without clipping or forcing corrective DSP', () => {
    const input = perceptualFixture('balanced');
    // A dry rhythmic arrangement, rather than a sustained calibration tone.
    for (const channel of input.channels) for (let i = 0; i < channel.length; i++) {
      const beat = (i / input.sampleRate) % 0.5;
      const pulse = Math.max(0, Math.min(1, beat / 0.005, (0.15 - beat) / 0.005));
      channel[i] *= 0.3 + 0.7 * pulse;
    }
    const original = input.channels.map(c => c.slice()), result = autoMixMaster(input, 'LIVE');
    expect(result.status, result.reasons.join(' ')).toBe('accepted');
    const final = result.attempts.at(-1)!, next = result.processed!.audio;
    const comparison = createComparisonPlan(result.before, final.after);
    const gainA = 10 ** (comparison.match.gainsDb.a / 20), gainB = 10 ** (comparison.match.gainsDb.b / 20);
    let difference = 0, direct = 0;
    for (let i = input.sampleRate / 2; i < input.channels[0].length - input.sampleRate / 2; i++) {
      difference += (input.channels[0][i] * gainA - next.channels[0][i] * gainB) ** 2;
      direct += (input.channels[0][i] * gainA) ** 2;
    }
    const ratio = Math.sqrt(difference / direct);
    const oldRoom = renderMix(input, [{ kind: 'live', parameters: room }]);
    const oldMatch = createComparisonPlan(result.before, analyzeAudio(oldRoom)).match;
    let oldDifference = 0, oldDirect = 0;
    for (let i = input.sampleRate / 2; i < input.channels[0].length - input.sampleRate / 2; i++) {
      const a = input.channels[0][i] * 10 ** (oldMatch.gainsDb.a / 20);
      const b = oldRoom.channels[0][i] * 10 ** (oldMatch.gainsDb.b / 20);
      oldDifference += (a - b) ** 2; oldDirect += a * a;
    }
    // A measurable difference, not a claim of preference or perceptual quality.
    expect(ratio).toBeGreaterThan(0.06);
    expect(ratio).toBeGreaterThan(Math.sqrt(oldDifference / oldDirect) * 1.8);
    expect(comparison.match.available).toBe(true);
    expect(final.after.clippedSamples).toBe(0); expect(final.after.truePeakDbtp!).toBeLessThanOrEqual(-1);
    expect(final.mix.stages.map(s => s.kind)).toEqual(['live']);
    expect(input.channels).toEqual(original);
  });
});
