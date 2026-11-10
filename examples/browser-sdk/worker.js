import { masterAudio, encodeFloatWav } from './music-sync-core.js';
self.onmessage = ({ data }) => {
  try {
    const result = masterAudio(data, { targetLufs: -14, ceilingDb: -1 });
    self.postMessage({ status: result.status, after: result.after?.integratedLufs ?? null,
      bytes: result.processed ? encodeFloatWav(result.processed.audio).byteLength : 0, reasons: result.reasons });
  } catch (error) { self.postMessage({ error: error.message }); }
};
