import { floatWavHeader, planStemMix, renderFileStems, STEM_LIMITS, writeFloatSamples, type StemMode, type AudioData, type StemStudioSettings } from '@music-sync/core';
import { readFlacMetadata } from './decode';
import type { StemFileEntry } from './stem-worker';
import { LONG_WAV_LIMITS, readWavFileMetadata, streamWavChunks } from './wav-stream';

export const longStemInputBytes = 1024 ** 3;

export async function needsFileMix(entries: StemFileEntry[]) {
  if (!entries.every(entry => /\.wav$/i.test(entry.file.name))) return false;
  const headers = await Promise.all(entries.map(entry => readWavFileMetadata(entry.file)));
  return headers.some(h => h.frames * 8 > STEM_LIMITS.maxBusBytes || h.frames / h.sampleRate > 600) ||
    headers.reduce((n, h) => n + h.frames * h.channels * 4, 0) > STEM_LIMITS.maxTotalDecodedBytes ||
    entries.some(entry => entry.file.size > STEM_LIMITS.maxFileBytes) ||
    entries.reduce((n, entry) => n + entry.file.size, 0) > STEM_LIMITS.maxTotalFileBytes;
}

export async function importFileStems(entries: StemFileEntry[], mode: StemMode, autoBalance: boolean, destination?: FileSystemFileHandle, studio?: StemStudioSettings, reference?: File, decode?: (entry: StemFileEntry) => Promise<AudioData>, clarity = false, vocalSupport = true) {
  if (entries.length < 2 || entries.length > STEM_LIMITS.maxTracks || entries.reduce((n, entry) => n + entry.file.size, 0) > longStemInputBytes)
    throw new Error('長尺WAVは2〜16素材、合計1 GiB以内にしてください。');
  if (entries.some(entry => !(entry.file instanceof File) || !entry.file.size || !/\.(wav|flac)$/i.test(entry.file.name)))
    throw new Error('STEMはWAV/FLACファイルを選んでください。');
  if (!destination && (entries.some(entry => entry.file.size > STEM_LIMITS.maxFileBytes) ||
    entries.reduce((n,entry)=>n+entry.file.size,0) > STEM_LIMITS.maxTotalFileBytes))
    throw new Error('STEMは各100 MiB・合計400 MiBまでです。長尺のSTEM処理にはWAVを使用してください。');
  const inputs = await Promise.all(entries.map(async ({ file, ...settings }) => {
    if (/\.flac$/i.test(file.name)) {
      if (destination || !decode || file.size > STEM_LIMITS.maxFileBytes) throw new Error('長尺のSTEM処理にはWAVを使用してください。');
      const info = readFlacMetadata(await file.slice(0, 42).arrayBuffer(), STEM_LIMITS.maxBusBytes);
      let decoded: AudioData | undefined;
      return { descriptor: { ...settings, name: file.name, ...info }, async *open() {
        decoded ??= await decode({ file, ...settings });
        for (let i = 0; i < info.frames; i += LONG_WAV_LIMITS.chunkFrames)
          yield { sampleRate: info.sampleRate, channels: decoded.channels.map(ch => ch.subarray(i, i + LONG_WAV_LIMITS.chunkFrames)) };
      } };
    }
    const info = await readWavFileMetadata(file);
    const descriptor = { ...settings, name: file.name, sampleRate: info.sampleRate, frames: info.frames, channels: info.channels };
    return { descriptor, open: () => streamWavChunks(file, info) };
  }));
  const plan = planStemMix(inputs.map(t => t.descriptor), mode, destination ? 'file' : 'memory');
  if (!destination) self.postMessage({ type: 'stem-capacity', tracks: entries.length, sampleRate: plan.sampleRate,
    seconds: plan.frames / plan.sampleRate, maxSeconds: Math.min(600, STEM_LIMITS.maxBusBytes / (8 * plan.sampleRate)),
    sourceMiB: plan.sourceBytes / 1024 ** 2, busMiB: plan.busBytes / 1024 ** 2 });
  const refInfo = reference && studio?.stabilize ? await readWavFileMetadata(reference) : undefined;
  if (studio?.stabilize && (!refInfo || refInfo.frames !== plan.frames || refInfo.sampleRate !== plan.sampleRate))
    throw new Error('安定化にはSTEMと同じ長さ・レート・開始位置の原曲WAVを選んでください。');
  const bus = destination ? undefined : [new Float32Array(plan.frames), new Float32Array(plan.frames)];
  let offset = 0;
  const stream = await destination?.createWritable();
  try {
    await stream?.write(floatWavHeader(plan.sampleRate, 2, plan.frames));
    const result = await renderFileStems(inputs, { mode, autoBalance, studio, clarity, vocalSupport, audition: !!studio || clarity, reference: refInfo && reference ? () => streamWavChunks(reference, refInfo) : undefined, blockFrames: LONG_WAV_LIMITS.chunkFrames,
      progress: (fraction, text, indeterminate) => self.postMessage({ type: 'stem-progress', fraction: indeterminate ? undefined : fraction, text }),
      async write(audio) {
        if (bus) { audio.channels.forEach((ch, i) => bus[i].set(ch, offset)); offset += audio.channels[0].length; return; }
        const buffer = new ArrayBuffer(audio.channels[0].length * 8);
        writeFloatSamples(audio, new DataView(buffer));
        await stream!.write(buffer);
      },
    });
    if (bus) return { ...result, audio: { sampleRate: plan.sampleRate, channels: bus } };
    await stream!.close();
    const file = await destination!.getFile();
    if (file.size !== plan.busBytes + 56) throw new Error('合成WAVの長さが一致しません。');
    return { ...result, file };
  } catch (error) { await stream?.abort().catch(() => {}); throw error; }
}
