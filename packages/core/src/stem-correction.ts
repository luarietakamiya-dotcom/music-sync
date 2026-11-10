import { analyzePerceptualFeatures } from '@music-sync/audio-analysis';
import type { AudioData } from '@music-sync/shared';
import { mixStems, planStemMix, type StemDescriptor, type StemMixResult } from './stems.js';
import { planStemBalance } from './stem-balance.js';
import { planStemMasking } from './stem-masking.js';

/** Batch host adapter for the same pair plan used by the sequential Web Worker. */
export function mixStemsWithCorrection(tracks: readonly { descriptor: StemDescriptor; audio: AudioData }[],
  options: { signal?: AbortSignal; onProgress?: (fraction: number) => void } = {}): StemMixResult {
  const abort = () => { if (options.signal?.aborted) throw new Error('Processing cancelled'); };
  abort();
  const descriptors = tracks.map(track => track.descriptor);
  planStemMix(descriptors, 'vocal-instrumental');
  const features = tracks.map((track, index) => {
    abort(); const descriptor = descriptors[index];
    if (track.audio.sampleRate !== descriptor.sampleRate || track.audio.channels.length !== descriptor.channels ||
      track.audio.channels[0]?.length !== descriptor.frames) throw new Error('STEMのメタデータと音声が一致しません。');
    const result = analyzePerceptualFeatures(track.audio);
    options.onProgress?.((index + 1) / tracks.length * 0.25); abort();
    return result;
  });
  const balance = planStemBalance(descriptors, features), masking = planStemMasking(descriptors, features, balance);
  const mixed = mixStems(tracks.map((track, index) => ({ audio: track.audio,
    descriptor: { ...track.descriptor, presenceDip: undefined, gainDb: balance.tracks[index].gainDb,
      ...(masking.status === 'proposed' && track.descriptor.id === masking.instrumentalId ? { presenceDip: masking.dip } : {}) } })),
  'vocal-instrumental', { signal: options.signal, maskingPlan: masking,
    onProgress: fraction => { options.onProgress?.(0.25 + fraction * 0.75); abort(); } });
  mixed.report.autoBalance = balance;
  return mixed;
}
