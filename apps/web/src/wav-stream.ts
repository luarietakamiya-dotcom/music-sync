import type { AudioData } from '@music-sync/core';

export const LONG_WAV_LIMITS = Object.freeze({ maxFileBytes: 512 * 1024 * 1024, maxSeconds: 20 * 60, chunkFrames: 65536 });

export interface StreamWavInfo {
  sampleRate: number; channels: number; frames: number;
  format: number; bits: number; align: number; dataOffset: number;
}

function tag(view: DataView, offset: number): string {
  return String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3));
}

/** Reads WAV headers and skips metadata without loading the audio data into RAM. */
export async function readWavFileMetadata(file: Blob): Promise<StreamWavInfo> {
  if (file.size > LONG_WAV_LIMITS.maxFileBytes) throw new Error('WAVは512 MiB以内にしてください。');
  if (file.size < 12) throw new Error('対応するRIFF/WAVEファイルではありません。');
  const header = new DataView(await file.slice(0, 12).arrayBuffer());
  if (tag(header, 0) !== 'RIFF' || tag(header, 8) !== 'WAVE') throw new Error('対応するRIFF/WAVEファイルではありません。');
  const end = header.getUint32(4, true) + 8;
  if (end > file.size || end < 44) throw new Error('WAVのサイズ情報が不正です。');
  let format = 0, channels = 0, sampleRate = 0, bits = 0, align = 0, dataOffset = -1, dataSize = 0;
  let seenFmt = false;
  let chunkCount = 0;
  for (let offset = 12; offset + 8 <= end;) {
    if (++chunkCount > 1024) throw new Error('WAVのメタデータチャンクが多すぎます。');
    const chunk = new DataView(await file.slice(offset, offset + 8).arrayBuffer());
    const id = tag(chunk, 0), size = chunk.getUint32(4, true), start = offset + 8;
    if (size > end - start) throw new Error('WAVチャンクが途中で切れています。');
    if (id === 'fmt ') {
      if (seenFmt || size < 16) throw new Error('WAV fmtチャンクが不正です。');
      seenFmt = true;
      const formatBytes = await file.slice(start, start + Math.min(size, 40)).arrayBuffer();
      const view = new DataView(formatBytes);
      format = view.getUint16(0, true); channels = view.getUint16(2, true);
      sampleRate = view.getUint32(4, true); align = view.getUint16(12, true); bits = view.getUint16(14, true);
      if (format === 0xfffe) {
        if (size < 40 || view.getUint16(16, true) < 22) throw new Error('WAV拡張ヘッダーが不正です。');
        const validBits = view.getUint16(18, true), mask = view.getUint32(20, true), subtype = view.getUint32(24, true);
        const guidTail = Array.from(new Uint8Array(formatBytes, 28, 12)).join(',');
        if (guidTail !== '0,0,16,0,128,0,0,170,0,56,155,113' || (subtype !== 1 && subtype !== 3))
          throw new Error('未対応のWAVサブフォーマットです。');
        if (validBits !== bits || (mask !== 0 && mask !== (channels === 1 ? 4 : 3)))
          throw new Error('このWAVの有効ビット数またはチャンネル配置には対応していません。');
        format = subtype;
      }
    } else if (id === 'data') {
      if (dataOffset !== -1) throw new Error('複数のdataチャンクには対応していません。');
      dataOffset = start; dataSize = size;
    }
    offset = start + size + (size & 1);
  }
  if (!seenFmt || dataOffset < 0 || !dataSize) throw new Error('WAVにfmtまたは音声dataチャンクがありません。');
  if (!(format === 1 && [8, 16, 24, 32].includes(bits)) && !(format === 3 && bits === 32))
    throw new Error('WAVはPCM 8/16/24/32-bitまたはFloat32に対応しています。');
  if (channels < 1 || channels > 2 || sampleRate < 8000 || sampleRate > 192000)
    throw new Error('モノラル／ステレオ、8–192 kHzのWAVに対応しています。');
  const bytes = bits / 8;
  if (align !== bytes * channels || dataSize % align !== 0) throw new Error('WAVのブロックサイズが不正です。');
  const frames = dataSize / align;
  if (frames / sampleRate > LONG_WAV_LIMITS.maxSeconds) throw new Error('長尺WAVは20分以内にしてください。');
  return { sampleRate, channels, frames, format, bits, align, dataOffset };
}

/** Decodes one bounded PCM chunk at a time. The File/Blob remains the Original. */
export async function* streamWavChunks(file: Blob, info: StreamWavInfo, signal?: AbortSignal): AsyncGenerator<AudioData> {
  const bytes = info.bits / 8;
  for (let offset = 0; offset < info.frames;) {
    if (signal?.aborted) throw new Error('Processing cancelled');
    const frames = Math.min(LONG_WAV_LIMITS.chunkFrames, info.frames - offset);
    const raw = await file.slice(info.dataOffset + offset * info.align, info.dataOffset + (offset + frames) * info.align).arrayBuffer();
    if (raw.byteLength !== frames * info.align) throw new Error('WAVの音声データが途中で切れています。');
    if (signal?.aborted) throw new Error('Processing cancelled');
    const view = new DataView(raw), channels = Array.from({ length: info.channels }, () => new Float32Array(frames));
    for (let i = 0; i < frames; i++) for (let channel = 0; channel < info.channels; channel++) {
      const position = i * info.align + channel * bytes;
      let value: number;
      if (info.format === 3) value = view.getFloat32(position, true);
      else if (info.bits === 8) value = (view.getUint8(position) - 128) / 128;
      else if (info.bits === 16) value = view.getInt16(position, true) / 32768;
      else if (info.bits === 24) value = (view.getUint8(position) | (view.getUint8(position + 1) << 8) | (view.getInt8(position + 2) << 16)) / 8388608;
      else value = view.getInt32(position, true) / 2147483648;
      channels[channel][i] = value;
    }
    offset += frames;
    yield { sampleRate: info.sampleRate, channels };
  }
}
