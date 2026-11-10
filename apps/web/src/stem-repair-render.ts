import { renderStemRestoration, floatWavHeader, writeFloatSamples, STEM_LIMITS, type AudioData, type StemStudioSettings } from '@music-sync/core';
import { readFlacMetadata } from './decode';
import { readWavFileMetadata, streamWavChunks } from './wav-stream';
import type { StemFileEntry } from './stem-worker';

export async function renderFileStemRepair(entry: StemFileEntry, studio: StemStudioSettings,
  destination?: FileSystemFileHandle, decode?: (entry: StemFileEntry) => Promise<AudioData>) {
  if (!entry || !(entry.file instanceof File) || !entry.file.size || !/\.(wav|flac)$/i.test(entry.file.name) || !studio?.restore)
    throw new Error('補修比較に使う素材または設定がありません。素材補修を有効にしてミックスを作り直してください。');
  const flac = /\.flac$/i.test(entry.file.name);
  const info = flac ? readFlacMetadata(await entry.file.slice(0,42).arrayBuffer(),STEM_LIMITS.maxBusBytes) : await readWavFileMetadata(entry.file);
  const bytes = info.frames * info.channels * 4;
  if (bytes+56 > 512*1024**2 || (!destination && bytes > STEM_LIMITS.maxBusBytes))
    throw new Error('この素材の補修比較にはブラウザの一時保存が必要です。対応するブラウザでお試しください。');
  let decoded: AudioData | undefined;
  const source = {...info, async *open() {
    if (!flac) { yield* streamWavChunks(entry.file, info as Awaited<ReturnType<typeof readWavFileMetadata>>); return; }
    if (!decode) throw new Error('FLACの展開方法がありません。');
    decoded ??= await decode(entry);
    for (let offset=0;offset<info.frames;offset+=65536)
      yield {sampleRate:info.sampleRate,channels:decoded.channels.map(ch=>ch.subarray(offset,offset+65536))};
  }};
  const stream = await destination?.createWritable();
  const bus = destination ? undefined : Array.from({length:info.channels},()=>new Float32Array(info.frames));
  let written=0;
  try {
    await stream?.write(floatWavHeader(info.sampleRate,info.channels,info.frames));
    const result = await renderStemRestoration(source,studio,{
      progress(fraction,text){self.postMessage({type:'stem-repair-progress',fraction,text});},
      async write(block) {
        if(bus)block.channels.forEach((ch,c)=>bus[c].set(ch,written));
        else {
          const buffer=new ArrayBuffer(block.channels[0].length*info.channels*4);
          writeFloatSamples(block,new DataView(buffer));await stream!.write(buffer);
        }
        written+=block.channels[0].length;
      },
    });
    if(written!==info.frames)throw new Error('補修比較用の音声長が一致しません。');
    if(bus)return {...result,audio:{sampleRate:info.sampleRate,channels:bus}};
    await stream!.close();
    const file=await destination!.getFile();
    if(file.size!==bytes+56)throw new Error('補修比較用WAVの長さが一致しません。');
    return {...result,file};
  }catch(error){await stream?.abort().catch(()=>{});throw error;}
}
