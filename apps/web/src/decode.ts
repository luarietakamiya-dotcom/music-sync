import { LIMITS, validateAudio, type AudioData } from '@music-sync/shared';

function ascii(view: DataView, start: number, count: number): string {
  return Array.from({ length: count }, (_, i) => String.fromCharCode(view.getUint8(start + i))).join('');
}

function checkDimensions(sampleRate: number, channels: number, frames: number, maxDecodedBytes = LIMITS.maxDecodedBytes): void {
  if (channels !== 1 && channels !== 2) throw new Error('モノラル／ステレオの音声を選択してください。');
  if (sampleRate < LIMITS.minSampleRate || sampleRate > LIMITS.maxSampleRate) throw new Error('対応サンプルレートは8–192 kHzです。');
  if (!frames || frames / sampleRate > LIMITS.maxSeconds || frames * channels * 4 > LIMITS.maxDecodedBytes)
    throw new Error('空の音声、10分を超える音声、または展開後192 MiBを超える音声は読み込めません。');
  if (!Number.isFinite(maxDecodedBytes) || maxDecodedBytes < 0 || frames * channels * 4 > maxDecodedBytes)
    throw new Error('AとBの音声データ合計が192 MiBを超えます。音声を短くしてください。');
}

/** Header preflight does not allocate decoded PCM. */
function inspectWav(buffer: ArrayBuffer, maxDecodedBytes = LIMITS.maxDecodedBytes) {
  const v = new DataView(buffer);
  if (buffer.byteLength < 12 || ascii(v, 0, 4) !== 'RIFF' || ascii(v, 8, 4) !== 'WAVE')
    throw new Error('対応するRIFF/WAVEファイルではありません。');
  const end = v.getUint32(4, true) + 8;
  if (end > buffer.byteLength || end < 12) throw new Error('WAVのサイズ情報が不正です。');
  let format = 0, channels = 0, sampleRate = 0, bits = 0, align = 0, dataStart = -1, dataSize = 0;
  let seenFmt = false;
  for (let offset = 12; offset + 8 <= end;) {
    const id = ascii(v, offset, 4), size = v.getUint32(offset + 4, true), start = offset + 8;
    if (size > end - start) throw new Error('WAVチャンクが途中で切れています。');
    if (id === 'fmt ') {
      if (seenFmt || size < 16) throw new Error('WAV fmtチャンクが不正です。');
      seenFmt = true;
      format = v.getUint16(start, true); channels = v.getUint16(start + 2, true);
      sampleRate = v.getUint32(start + 4, true); align = v.getUint16(start + 12, true); bits = v.getUint16(start + 14, true);
      if (format === 0xfffe) {
        if (size < 40 || v.getUint16(start + 16, true) < 22) throw new Error('WAV拡張ヘッダーが不正です。');
        const validBits = v.getUint16(start + 18, true), mask = v.getUint32(start + 20, true);
        const subtype = v.getUint32(start + 24, true);
        const guidTail = Array.from(new Uint8Array(buffer, start + 28, 12)).join(',');
        if (guidTail !== '0,0,16,0,128,0,0,170,0,56,155,113' || (subtype !== 1 && subtype !== 3))
          throw new Error('未対応のWAVサブフォーマットです。');
        if (validBits !== bits || (mask !== 0 && mask !== (channels === 1 ? 4 : 3)))
          throw new Error('このWAVの有効ビット数またはチャンネル配置には対応していません。');
        format = subtype;
      }
    } else if (id === 'data') {
      if (dataStart !== -1) throw new Error('複数のdataチャンクには対応していません。');
      dataStart = start; dataSize = size;
    }
    offset = start + size + (size % 2);
  }
  if (!seenFmt || dataStart < 0) throw new Error('WAVにfmtまたはdataチャンクがありません。');
  if (!(format === 1 && [8, 16, 24, 32].includes(bits)) && !(format === 3 && bits === 32))
    throw new Error('WAVはPCM 8/16/24/32-bitまたはFloat32に対応しています。');
  const bytes = bits / 8;
  if (align !== bytes * channels || dataSize % align !== 0) throw new Error('WAVのブロックサイズが不正です。');
  const frames = dataSize / align;
  checkDimensions(sampleRate, channels, frames, maxDecodedBytes);
  return { sampleRate, channels, frames, bytes, bits, format, align, dataStart };
}
export function readWavMetadata(buffer: ArrayBuffer, maxDecodedBytes = LIMITS.maxDecodedBytes): { sampleRate: number; channels: number; frames: number } {
  const { sampleRate, channels, frames } = inspectWav(buffer, maxDecodedBytes);
  return { sampleRate, channels, frames };
}
/** Explicit PCM parser preserves original sample rate; no browser resampling of WAV. */
export function decodeWav(buffer: ArrayBuffer, maxDecodedBytes = LIMITS.maxDecodedBytes): AudioData {
  const { sampleRate, channels, frames, bytes, bits, format, align, dataStart } = inspectWav(buffer, maxDecodedBytes);
  const v = new DataView(buffer);
  const output = Array.from({ length: channels }, () => new Float32Array(frames));
  for (let i = 0; i < frames; i++) for (let c = 0; c < channels; c++) {
    const p = dataStart + i * align + c * bytes;
    let value: number;
    if (format === 3) value = v.getFloat32(p, true);
    else if (bits === 8) value = (v.getUint8(p) - 128) / 128;
    else if (bits === 16) value = v.getInt16(p, true) / 32768;
    else if (bits === 24) {
      const integer = v.getUint8(p) | (v.getUint8(p + 1) << 8) | (v.getInt8(p + 2) << 16);
      value = integer / 8388608;
    } else value = v.getInt32(p, true) / 2147483648;
    output[c][i] = value;
  }
  const audio = { sampleRate, channels: output };
  validateAudio(audio);
  return audio;
}

export function readFlacMetadata(buffer: ArrayBuffer, maxDecodedBytes = LIMITS.maxDecodedBytes): { sampleRate: number; channels: number; frames: number } {
  const v = new DataView(buffer);
  if (buffer.byteLength < 42 || ascii(v, 0, 4) !== 'fLaC' || (v.getUint8(4) & 0x7f) !== 0 ||
      v.getUint8(5) !== 0 || v.getUint8(6) !== 0 || v.getUint8(7) !== 34)
    throw new Error('FLACのSTREAMINFOが不正です。');
  const packed = v.getBigUint64(18, false);
  const sampleRate = Number(packed >> 44n);
  const channels = Number((packed >> 41n) & 7n) + 1;
  const frames = Number(packed & 0xfffffffffn);
  checkDimensions(sampleRate, channels, frames, maxDecodedBytes);
  return { sampleRate, channels, frames };
}

export async function decodeFlac(buffer: ArrayBuffer, maxDecodedBytes = LIMITS.maxDecodedBytes): Promise<AudioData> {
  const metadata = readFlacMetadata(buffer, maxDecodedBytes);
  // decodeAudioData resamples to context rate: explicitly request STREAMINFO rate.
  let decoded: AudioBuffer;
  try {
    const context = new OfflineAudioContext(metadata.channels, 1, metadata.sampleRate);
    decoded = await context.decodeAudioData(buffer);
  } catch {
    throw new Error('FLACをデコードできません。このブラウザが未対応、または音声が破損しています。PCM WAVをお試しください。');
  }
  if (decoded.numberOfChannels !== metadata.channels || decoded.sampleRate !== metadata.sampleRate || decoded.length !== metadata.frames)
    throw new Error('FLACヘッダーとデコード結果が一致しません。');
  const audio = { sampleRate: decoded.sampleRate, channels: Array.from({ length: decoded.numberOfChannels }, (_, c) => decoded.getChannelData(c)) };
  validateAudio(audio);
  return audio;
}
