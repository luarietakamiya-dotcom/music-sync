import { processAudio, analyzeAudio, encodeFloatWav, masterAudio, autoMixMaster, finishStemMix, masterStemMix, applySoundColor, type TrebleMode, type RepairControls, type StemMixReport, type FinishingPreferences, type LiveSelection, type SoundColorSelection, type AutoMode, type MasteringOptions, type AudioData, type ProcessingChain } from '@music-sync/core';
import { handleStemWorkerMessage, type StemWorkerRequest } from './stem-worker';

import { renderLong, type LongRenderRequest } from './long-render';

self.onmessage = (event: MessageEvent<LongRenderRequest | StemWorkerRequest | { kind: 'process' | 'master' | 'auto' | 'color' | 'export'; audio: AudioData; treble?: TrebleMode; repairControls?: RepairControls; aggression?: number; sourceMix?: StemMixReport; chain?: ProcessingChain; options?: MasteringOptions; mode?: AutoMode; reference?: import('@music-sync/core').ReferenceSelection; soundColor?: SoundColorSelection; live?: LiveSelection; preferences?: FinishingPreferences }>) => {
  if (event.data.kind === 'long-render') {
    void renderLong(event.data, (fraction, stage) => self.postMessage({ type: 'progress', fraction, stage }))
      .then(candidate => self.postMessage({ type: 'long-result', ...candidate }))
      .catch(error => self.postMessage({ type: 'error', message: error instanceof Error ? error.message : '長尺WAVを仕上げられませんでした。' }));
    return;
  }
  if (handleStemWorkerMessage(event.data)) return;
  try {
    const { kind, audio, chain } = event.data;
    if (kind === 'export') {
      const buffer = encodeFloatWav(audio);
      self.postMessage({ type: 'wav', buffer }, { transfer: [buffer] });
    } else if (kind === 'color') {
      const coloured = applySoundColor(audio, event.data.soundColor!, { onProgress: fraction => self.postMessage({ type: 'progress', fraction }) });
      const { processed, ...summary } = coloured;
      if (processed) self.postMessage({ type: 'processed', ...processed, result: summary.attempts.at(-1)!.after, soundColor: summary },
        { transfer: processed.audio.channels.map(c => c.buffer as ArrayBuffer) });
      else self.postMessage({ type: 'rejected', soundColor: summary });
    } else if (kind === 'auto') {
      const options = { reference:event.data.reference, aggression: event.data.aggression, repairControls: event.data.repairControls, treble: event.data.treble, preferences: event.data.preferences, live: event.data.live, soundColor: event.data.soundColor, onProgress: (progress: import('@music-sync/core').AutoProgress) => self.postMessage({ type: 'progress', ...progress }) };
      const finished = event.data.sourceMix ? finishStemMix({ audio, report: event.data.sourceMix }, event.data.mode, options) : autoMixMaster(audio, event.data.mode, options);
      const { processed, ...summary } = finished;
      if (processed) self.postMessage({ type: 'processed', ...processed, result: finished.finalAfter ?? finished.attempts.at(-1)!.after, finishing: summary, soundColor: finished.soundColor },
        { transfer: processed.audio.channels.map(c => c.buffer as ArrayBuffer) });
      else self.postMessage({ type: 'rejected', finishing: summary });
    } else if (kind === 'master') {
      const onProgress = (fraction: number) => self.postMessage({ type: 'progress', fraction });
      const mastered = event.data.sourceMix ? masterStemMix({ audio, report: event.data.sourceMix }, event.data.options!, onProgress) : masterAudio(audio, event.data.options!, onProgress);
      const { processed, ...summary } = mastered;
      if (processed) self.postMessage({ type: 'processed', ...processed, result: mastered.after, mastering: summary },
        { transfer: processed.audio.channels.map(c => c.buffer as ArrayBuffer) });
      else self.postMessage({ type: 'rejected', mastering: summary });
    } else {
      const processed = processAudio(audio, chain!, fraction => self.postMessage({ type: 'progress', fraction: fraction * 0.6 }));
      const result = analyzeAudio(processed.audio, { onProgress: fraction => self.postMessage({ type: 'progress', fraction: 0.6 + fraction * 0.4 }) });
      self.postMessage({ type: 'processed', ...processed, result }, { transfer: processed.audio.channels.map(c => c.buffer as ArrayBuffer) });
    }
  } catch (error) { self.postMessage({ type: 'error', message: error instanceof Error ? error.message : 'DSP処理に失敗しました。' }); }
};
