import { writeBatchArchive, type BatchDownloadTrack } from './batch-download';
import type { AudioExportOptions } from './audio-export';

let working = false;
self.onmessage = (event: MessageEvent<{ kind: 'batch-export'; tracks: BatchDownloadTrack[];
  options: AudioExportOptions; destination: FileSystemFileHandle; maximumBytes?: number }>) => {
  if (event.data.kind !== 'batch-export') return;
  if (working) { self.postMessage({ type: 'error', message: 'まとめて保存する処理が進行中です。' }); return; }
  working = true;
  void (async () => {
    let stream: FileSystemWritableFileStream | undefined;
    try {
      stream = await event.data.destination.createWritable();
      await writeBatchArchive(event.data.tracks, event.data.options, {
        maximumBytes: event.data.maximumBytes,
        write: async chunk => { await stream!.write(chunk as Uint8Array<ArrayBuffer>); },
        progress: (fraction, text) => self.postMessage({ type: 'progress', fraction, text }),
      });
      await stream.close(); stream = undefined;
      self.postMessage({ type: 'batch-export-result', file: await event.data.destination.getFile() });
    } catch (error) {
      await stream?.abort().catch(() => {});
      self.postMessage({ type: 'error', message: error instanceof Error ? error.message : 'ZIPを作成できませんでした。' });
    } finally { working = false; }
  })();
};
