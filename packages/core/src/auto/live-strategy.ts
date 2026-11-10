import type { LiveParameters } from '@music-sync/dsp';
import type { AudioProblems } from './problem-detector.js';

export interface LiveSelection { venue: 'live-house' | 'concert-hall' | 'arena'; intensity: 'gentle' | 'standard' | 'vivid' }
export const LIVE_SPACES = Object.freeze({
  'live-house': Object.freeze({ label: 'ライブハウス', decaySeconds: 0.85, preDelayMs: 16, wet: 0.52 }),
  'concert-hall': Object.freeze({ label: 'ホール', decaySeconds: 1.5, preDelayMs: 24, wet: 0.56 }),
  arena: Object.freeze({ label: 'アリーナ', decaySeconds: 2.1, preDelayMs: 34, wet: 0.58 }),
});
export const LIVE_INTENSITIES = Object.freeze({ gentle: 0.45, standard: 0.75, vivid: 1 });
export const DEFAULT_LIVE_SELECTION: Readonly<LiveSelection> = Object.freeze({ venue: 'concert-hall', intensity: 'vivid' });
export function validateLiveSelection(selection: LiveSelection): void {
  if (!selection || !Object.hasOwn(LIVE_SPACES, selection.venue) || !Object.hasOwn(LIVE_INTENSITIES, selection.intensity)) throw new Error('LIVEの会場または強さが不正です。');
}

export const LIVE_VENUES = Object.freeze({
  'intimate-room': Object.freeze({ label: '近くて自然なライブ空間', decaySeconds: 0.65, preDelayMs: 22, wet: 0.14 }),
  'small-hall': Object.freeze({ label: '輪郭を残した小ホール', decaySeconds: 1.1, preDelayMs: 24, wet: 0.28 }),
});
/** Venue strategy produces data only; the dedicated DSP live processor renders it. */
export function planLiveSound(problems: AudioProblems, strength: number, selection?: LiveSelection): LiveParameters {
  if (selection) {
    validateLiveSelection(selection);
    const venue = LIVE_SPACES[selection.venue];
    return { venue: selection.venue, wet: venue.wet * LIVE_INTENSITIES[selection.intensity] * strength * (problems.unstableStereo ? 0.65 : 1) * (problems.centerFocused ? 0.9 : 1),
      highpassHz: problems.bassExcess || problems.muddy ? 320 : 160,
      decaySeconds: venue.decaySeconds, preDelayMs: Math.min(40, venue.preDelayMs + (problems.centerFocused ? 4 : 0)) };
  }
  const name = problems.spaceRisk || problems.unstableStereo ? 'intimate-room' : 'small-hall';
  const venue = LIVE_VENUES[name];
  return { venue: name, wet: venue.wet * strength * (problems.spaceRisk || problems.unstableStereo ? 0.4 : 1) * (problems.centerFocused ? 0.8 : 1),
    highpassHz: problems.bassExcess || problems.muddy ? 360 : 200,
    decaySeconds: problems.spaceRisk ? 0.38 : venue.decaySeconds,
    preDelayMs: problems.centerFocused ? 28 : venue.preDelayMs };
}
