import { Zip, ZipPassThrough } from 'fflate';
import { exportAudioSource, validateAudioExportOptions, type AudioExportOptions } from './audio-export';

export interface BatchDownloadTrack { file: File; name: string }
export const BATCH_DOWNLOAD_LIMITS = Object.freeze({ tracks: 20, bytes: 2 * 1024 ** 3, chunkBytes: 65536 });

export function batchTrackTitle(name: string): string {
  return name.replace(/\.(wav|flac|mp3)$/i, '').trim() || 'MusicSync';
}
export function batchDownloadName(name: string, extension: 'wav' | 'mp3', index?: number): string {
  const title = Array.from(batchTrackTitle(name).replace(/[<>:"/\\|?*]/g, '_'), character =>
    character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 ? '_' : character).join('').replace(/^\.+|\.+$/g, '').trim();
  const prefix = index === undefined ? '' : String(index + 1).padStart(2, '0') + ' ';
  return prefix + (Array.from(title).slice(0, 120).join('') || 'MusicSync') + '.' + extension;
}
export function batchTrackExportOptions(options: AudioExportOptions, name: string): AudioExportOptions {
  const checked = validateAudioExportOptions(options);
  return { ...checked, metadata: { ...checked.metadata, title: checked.metadata?.title || batchTrackTitle(name) } };
}

/** One encoded song at a time; ZIP chunks are backpressured into the caller's storage. */
export async function writeBatchArchive(tracks: readonly BatchDownloadTrack[], options: AudioExportOptions,
  hooks: { write(chunk: Uint8Array): Promise<void>; signal?: AbortSignal; maximumBytes?: number; progress?(fraction: number, text: string): void }) {
  if (!Array.isArray(tracks) || !tracks.length || tracks.length > BATCH_DOWNLOAD_LIMITS.tracks ||
    tracks.some(track => !track || !(track.file instanceof File) || typeof track.name !== 'string' || track.name.length > 1000))
    throw new Error('まとめて保存する曲は1〜20曲にしてください。');
  const settings = validateAudioExportOptions(options);
  const signal = hooks.signal;
  const maximum = hooks.maximumBytes ?? BATCH_DOWNLOAD_LIMITS.bytes;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > BATCH_DOWNLOAD_LIMITS.bytes)
    throw new Error('ZIPの保存容量が不正です。');
  signal?.throwIfAborted();
  let chain = Promise.resolve(), failure: Error | undefined, bytes = 0, ended = false;
  const zip = new Zip((error, data, final) => {
    if (error) { failure = error; return; }
    bytes += data.byteLength;
    if (bytes > maximum) { failure = new Error('ZIPの保存容量を超えます（最大2 GiB）。曲を分けて保存してください。'); return; }
    // fflate can reuse its callback bytes; retain only the current bounded output block.
    const owned = data.slice();
    chain = chain.then(async () => { signal?.throwIfAborted(); await hooks.write(owned); });
    ended ||= final;
  });
  const drain = async () => { await chain; signal?.throwIfAborted(); if (failure) throw failure; };
  try {
    for (const [index, track] of tracks.entries()) {
      signal?.throwIfAborted();
      const output = await exportAudioSource({ file: track.file }, batchTrackExportOptions(settings, track.name), {
        signal, progress: (fraction, text) => hooks.progress?.((index + fraction * .8) / tracks.length, `${index + 1}/${tracks.length} ${track.name}：${text}`),
      });
      const part = new ZipPassThrough(batchDownloadName(track.name, output.extension, index));
      part.mtime = new Date('1980-01-01T00:00:00.000Z');
      zip.add(part); await drain();
      for (let offset = 0; offset < output.blob.size; offset += BATCH_DOWNLOAD_LIMITS.chunkBytes) {
        signal?.throwIfAborted();
        const end = Math.min(output.blob.size, offset + BATCH_DOWNLOAD_LIMITS.chunkBytes);
        part.push(new Uint8Array(await output.blob.slice(offset, end).arrayBuffer()), end === output.blob.size);
        await drain();
        hooks.progress?.((index + .8 + .2 * end / output.blob.size) / tracks.length, `${index + 1}/${tracks.length} 曲を書き出しています…`);
      }
    }
    zip.end(); await drain();
    if (!ended) throw new Error('ZIPの作成を完了できませんでした。');
    hooks.progress?.(1, 'ZIPを用意しました。');
  } catch (error) { zip.terminate(); await chain.catch(() => {}); throw error; }
}
