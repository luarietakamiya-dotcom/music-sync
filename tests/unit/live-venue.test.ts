import { describe, it, expect } from 'vitest';
import { autoMixMaster, analyzeAudio, analyzeAdaptiveFeatures, analyzePerceptualFeatures, planMixCorrection, createComparisonPlan, LIVE_SPACES, validateLiveSelection, type LiveSelection } from '@music-sync/core';
import { renderMix, type LiveParameters } from '@music-sync/dsp';
import { tone } from '../helpers/audio';
import { perceptualFixture } from '../fixtures/perceptual';

const oldHall: LiveParameters = { venue: 'small-hall', wet: 0.28, preDelayMs: 24, highpassHz: 200, decaySeconds: 1.1 };
const hall: LiveParameters = { venue: 'concert-hall', wet: 0.56, preDelayMs: 24, highpassHz: 160, decaySeconds: 1.5 };
const sumEnergy = (c: Float32Array, from: number, to: number) => c.subarray(from, to).reduce((sum, x) => sum + x * x, 0);
function rhythmic() {
  const audio = perceptualFixture('balanced');
  for (const c of audio.channels) for (let i = 0; i < c.length; i++) {
    const beat = i / audio.sampleRate % 0.5;
    c[i] *= 0.2 + 0.8 * Math.max(0, Math.min(1, beat / 0.005, (0.13 - beat) / 0.005));
  }
  return audio;
}
function matchedDifference(a: ReturnType<typeof rhythmic>, b: typeof a) {
  const match = createComparisonPlan(analyzeAudio(a), analyzeAudio(b)).match;
  const ga = 10 ** (match.gainsDb.a / 20), gb = 10 ** (match.gainsDb.b / 20);
  let delta = 0, reference = 0;
  for (let i = a.sampleRate / 2; i < a.channels[0].length - a.sampleRate / 2; i++) {
    delta += (a.channels[0][i] * ga - b.channels[0][i] * gb) ** 2; reference += (a.channels[0][i] * ga) ** 2;
  }
  return Math.sqrt(delta / reference);
}

describe('LIVE venue response and purpose selection', () => {
  it.each([8000, 48000, 192000])('has a stronger late room field at %i Hz, preserving direct timing and source', sampleRate => {
    const input = { sampleRate, channels: [new Float32Array(sampleRate * 2), new Float32Array(sampleRate * 2)] };
    input.channels.forEach(c => { c[0] = 0.5; });
    const snapshot = input.channels.map(c => c.slice());
    const old = renderMix(input, [{ kind: 'live', parameters: oldHall }]);
    const next = renderMix(input, [{ kind: 'live', parameters: hall }]);
    const from = Math.floor(sampleRate * 0.15), to = Math.floor(sampleRate * 0.8);
    const ratio = sumEnergy(next.channels[0], from, to) / sumEnergy(old.channels[0], from, to);
    expect(ratio).toBeGreaterThan(2);
    expect(next.channels[0][0]).toBe(0.5); expect(next.channels[0].slice(1, sampleRate * 0.024).every(x => x === 0)).toBe(true);
    expect(next.channels[0].at(-1)).toBe(0); expect(next.channels.every(c => c.every(Number.isFinite))).toBe(true);
    expect(next.channels[0]).not.toEqual(next.channels[1]); expect(input.channels).toEqual(snapshot);
  });
  it('supports distinct stage/hall/arena responses and rejects invalid settings', () => {
    const input = tone({ sampleRate: 16000, seconds: 0.1 });
    expect(renderMix(input, [{ kind: 'live', parameters: { ...hall, wet: 0 } }])).toEqual(input);
    for (const bad of [{ wet: 0.61 }, { decaySeconds: 2.6 }, { highpassHz: NaN }, { preDelayMs: 0 }])
      expect(() => renderMix(input, [{ kind: 'live', parameters: { ...hall, ...bad } }])).toThrow('Invalid live');
    expect(() => validateLiveSelection({ venue: 'unknown', intensity: 'vivid' } as unknown as LiveSelection)).toThrow();
    const responses = Object.keys(LIVE_SPACES).map(venue => autoMixMaster(perceptualFixture('balanced'), 'LIVE', { live: { venue: venue as LiveSelection['venue'], intensity: 'standard' } }));
    for (const result of responses) {
      expect(result.status, result.reasons.join(' ')).toBe('accepted'); expect(result.attempts.at(-1)!.after.clippedSamples).toBe(0);
    }
    expect(responses[0].processed!.audio.channels).not.toEqual(responses[1].processed!.audio.channels);
    expect(responses[1].processed!.audio.channels).not.toEqual(responses[2].processed!.audio.channels);
  });
  it('makes a materially larger matched change than the former hall on rhythmic material', () => {
    const input = rhythmic(), original = input.channels.map(c => c.slice());
    const result = autoMixMaster(input, 'LIVE'); expect(result.status, result.reasons.join(' ')).toBe('accepted');
    const prior = renderMix(input, [{ kind: 'live', parameters: oldHall }]);
    const ratio = matchedDifference(input, result.processed!.audio);
    expect(ratio).toBeGreaterThan(0.15);
    expect(ratio).toBeGreaterThan(matchedDifference(input, prior) * 1.6);
    expect(result.attempts.at(-1)!.after.truePeakDbtp!).toBeLessThanOrEqual(-1);
    expect(input.channels).toEqual(original);
  });
  it('keeps chosen venue on uncertain evidence and reduces credible wet material without silently replacing the venue', () => {
    const input = perceptualFixture('balanced'), report = analyzeAudio(input), features = analyzeAdaptiveFeatures(input), p = analyzePerceptualFeatures(input);
    const selection: LiveSelection = { venue: 'arena', intensity: 'vivid' };
    const get = (perceptual = p, strength = 1) => {
      const plan = planMixCorrection(report, features, 'LIVE', strength, perceptual, selection);
      const stage = plan.stages.find(s => s.kind === 'live');
      if (stage?.kind !== 'live') throw new Error('Missing live'); return stage.parameters;
    };
    const dry = get(), uncertain = get({ ...p, features: { ...p.features, ambience: { value: 0.5, confidence: 0.2 } } });
    const wet = get({ ...p, ambienceClass: 'Wet', features: { ...p.features, ambience: { value: 0.9, confidence: 0.8 } } });
    expect(dry.venue).toBe('arena'); expect(wet.venue).toBe('arena'); expect(uncertain.wet).toBeGreaterThan(dry.wet * 0.8);
    expect(wet.wet).toBeLessThan(dry.wet); expect(wet.decaySeconds).toBeLessThan(dry.decaySeconds);
    expect(get(p, 0.5).wet).toBeCloseTo(dry.wet * 0.5);
  });
  it('leaves low bass out of the room and keeps response level-independent', () => {
    const difference = (frequency: number, amplitude: number) => {
      const input = tone({ sampleRate: 16000, seconds: 2, frequency, amplitude });
      const output = renderMix(input, [{ kind: 'live', parameters: { ...hall, highpassHz: 320 } }]);
      let delta = 0; for (let i = 8000; i < 24000; i++) delta += (output.channels[0][i] - input.channels[0][i]) ** 2;
      return Math.sqrt(delta / 16000) / amplitude;
    };
    expect(difference(60, 0.1)).toBeLessThan(difference(1200, 0.1) * 0.4);
    expect(difference(1200, 0.1)).toBeCloseTo(difference(1200, 0.3), 5);
  });
  it('provides increasing matched venue strength and keeps other automatic modes independent', () => {
    const input = rhythmic();
    const differences = (['gentle', 'standard', 'vivid'] as const).map(intensity => {
      const output = autoMixMaster(input, 'LIVE', { live: { venue: 'concert-hall', intensity } });
      expect(output.status, output.reasons.join(' ')).toBe('accepted'); return matchedDifference(input, output.processed!.audio);
    });
    expect(differences[1]).toBeGreaterThan(differences[0]); expect(differences[2]).toBeGreaterThan(differences[1]);
    const a = autoMixMaster(input, 'AUTO'), b = autoMixMaster(input, 'AUTO', { live: { venue: 'arena', intensity: 'vivid' } });
    expect(a).toEqual(b);
  });
});
