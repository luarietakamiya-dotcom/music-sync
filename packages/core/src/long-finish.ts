import type { AnalysisResult, AudioData } from '@music-sync/shared';
import { createBiquad, createVenueStream, peakingCoefficients } from '@music-sync/dsp';
import { AUTO_MODES, type AutoMode } from './auto/mix-planner.js';
import { LIVE_SPACES, LIVE_INTENSITIES, validateLiveSelection, type LiveSelection } from './auto/live-strategy.js';
import { OUTPUT_PROFILES, type OutputProfileId } from './finishing-preferences.js';

export function createLongMix(before: AnalysisResult, mode: AutoMode, live: LiveSelection, strength: number) {
  if (!Object.hasOwn(AUTO_MODES, mode) || ![1, 0.5].includes(strength)) throw new Error('仕上げの指定が不正です。');
  if (before.clippedSamples || before.integratedLufs === null || before.rmsDbfs === null)
    throw new Error('クリッピングまたは測定できない音量のため、自動仕上げを保留しました。');
  const offsets = before.dcOffset.map(dc => Math.abs(dc) > 0.003 ? dc : 0);
  const punch = mode === 'IMPACT' && (before.crestFactorDb ?? 0) > 6 && (before.crestFactorDb ?? 0) < 16;
  const filters = punch ? offsets.map(() => createBiquad(peakingCoefficients(before.sampleRate, Math.min(2000, before.sampleRate * 0.4), 0.8 * strength, 0.7))) : [];
  let room: ((chunk: AudioData) => void) | undefined;
  const explanations: string[] = [];
  if (offsets.some(Boolean)) explanations.push('音の中心のずれを補正しました。');
  if (punch) explanations.push('立ち上がりが聞こえる帯域を少し強調しました。');
  if (mode === 'LIVE') {
    validateLiveSelection(live);
    const venue = LIVE_SPACES[live.venue];
    const wide = (before.sideEnergyPercent ?? 0) > 35 || (before.stereoCorrelation ?? 1) < 0.25;
    room = createVenueStream(before.sampleRate, before.frames, offsets.map(() => 10 ** (before.rmsDbfs! / 20)), {
      ...venue, venue: live.venue, highpassHz: 220, wet: venue.wet * LIVE_INTENSITIES[live.intensity] * strength * (wide ? 0.55 : 1),
    });
    explanations.push(venue.label + 'の初期反射と残響を加えました。');
  }
  return { explanations, toneChanged: punch || !!room, processOwned(chunk: AudioData) {
    chunk.channels.forEach((channel, c) => {
      if (!offsets[c] && !filters[c]) return;
      for (let i = 0; i < channel.length; i++) {
        const centered = channel[i] - offsets[c];
        channel[i] = filters[c] ? filters[c](centered) : centered;
      }
    });
    room?.(chunk);
  } };
}

import { liftAllowance } from './studio-settings.js';

export function longMasterGain(mix: AnalysisResult, mode: AutoMode, output: OutputProfileId, aggression = 35, density: 0 | 1 | 2 | 3 = 0) {
  const lufs = mix.integratedLufs, peak = mix.truePeakDbtp;
  if (lufs === null || peak === null || !Object.hasOwn(OUTPUT_PROFILES, output)) throw new Error('仕上げに必要な音量を測定できません。');
  if (![0, 1, 2, 3].includes(density)) throw new Error('音圧・密度の指定が不正です。');
  const config = AUTO_MODES[mode];
  const target = OUTPUT_PROFILES[output].targetLufs ?? (mode === 'AUTO' && lufs >= -18 && lufs <= -14 ? lufs : config.targetLufs) + Math.max(0, aggression - 35) / 65 * 2 + density * 0.6;
  const gainDb = Math.min(liftAllowance(config.maxLiftLu, aggression), Math.max(-12, target - lufs), -1.001 - peak);
  return { target, gainDb };
}

export function checkLongCandidate(a: AnalysisResult, b: AnalysisResult, target: number): boolean {
  const valid = [b.integratedLufs, b.rmsDbfs, b.truePeakDbtp, b.crestFactorDb].every(Number.isFinite);
  return valid && a.integratedLufs !== null && a.rmsDbfs !== null && a.crestFactorDb !== null &&
    a.frames === b.frames && a.channels === b.channels && a.sampleRate === b.sampleRate &&
    b.clippedSamples === 0 && b.truePeakDbtp! <= -1 && Math.abs(b.integratedLufs! - target) <= Math.abs(a.integratedLufs - target) + 1 &&
    b.rmsDbfs! - a.rmsDbfs <= 6.5 && b.rmsDbfs! - a.rmsDbfs >= -12.5 && b.crestFactorDb! >= a.crestFactorDb - 1.5 &&
    (a.stereoCorrelation === null || (b.stereoCorrelation !== null && b.stereoCorrelation >= a.stereoCorrelation - 0.12)) &&
    Math.abs((b.sideEnergyPercent ?? 0) - (a.sideEnergyPercent ?? 0)) <= 6 &&
    b.dcOffset.every((dc, c) => Math.abs(dc) <= Math.max(0.003, Math.abs(a.dcOffset[c]) + 0.001));
}
