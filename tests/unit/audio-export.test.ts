import {expect,it} from 'vitest';
import {Mp3Encoder} from '@breezystack/lamejs';
import {encodeFloatWav,type AudioData} from '@music-sync/core';
import {exportAudioSource,validateAudioExportOptions,type AudioExportFormat} from '../../apps/web/src/audio-export';
import {readWavFileMetadata,streamWavChunks} from '../../apps/web/src/wav-stream';
const encoderFactory=(channels:number,rate:number,bitrate:number)=>new Mp3Encoder(channels,rate,bitrate);
function tone(rate=44100,frames=44100,channels=1):AudioData {
  return {sampleRate:rate,channels:Array.from({length:channels},(_,c)=>Float32Array.from({length:frames},(_,n)=>.2*Math.sin(2*Math.PI*(440+c*330)*n/rate)))};
}
it('exports Float32 and 16/24-bit WAV headers, padding, original rate and samples without changing input',async()=>{
  const audio=tone(44100,1001),saved=audio.channels[0].slice();
  for(const format of ['wav-f32','wav-24','wav-16'] as const){
    const result=await exportAudioSource({audio},{format,dither:false}),file=new File([result.blob],'out.wav');
    const info=await readWavFileMetadata(file);expect(info.frames).toBe(1001);expect(info.sampleRate).toBe(44100);expect(info.channels).toBe(1);
    const bits=format==='wav-f32'?32:format==='wav-24'?24:16;expect(info.bits).toBe(bits);expect(info.format).toBe(bits===32?3:1);
    const bytes=await file.arrayBuffer();expect(new DataView(bytes).getUint32(4,true)+8).toBe(bytes.byteLength);
    let offset=0,maximum=0;for await(const chunk of streamWavChunks(file,info)){
      for(let n=0;n<chunk.channels[0].length;n++)maximum=Math.max(maximum,Math.abs(chunk.channels[0][n]-saved[offset+n]));offset+=chunk.channels[0].length;
    }
    expect(maximum).toBeLessThanOrEqual(bits===32?0:.501/2**(bits-1));
    expect(audio.channels[0]).toEqual(saved);
  }
});
it('uses the same bounded export path for a repeatable file-backed stereo source',async()=>{
  const audio=tone(48000,140117,2),file=new File([encodeFloatWav(audio)],'input.wav');
  for(const format of ['wav-f32','wav-24','wav-16'] as const){
    const direct=await exportAudioSource({audio},{format,dither:false}),streamed=await exportAudioSource({file},{format,dither:false});
    expect(new Uint8Array(await streamed.blob.arrayBuffer())).toEqual(new Uint8Array(await direct.blob.arrayBuffer()));
  }
});
it('adds bounded unbiased dither only to selected integer output',async()=>{
  const audio={sampleRate:16000,channels:[new Float32Array(20000)]};
  const dry=await exportAudioSource({audio},{format:'wav-16',dither:false}),dithered=await exportAudioSource({audio},{format:'wav-16'});
  const a=new Int16Array(await dry.blob.arrayBuffer(),44),b=new Int16Array(await dithered.blob.arrayBuffer(),44);
  expect(a.every(n=>n===0)).toBe(true);expect(b.some(n=>n===1)&&b.some(n=>n===-1)).toBe(true);
  expect(b.every(n=>Math.abs(n)<=1)).toBe(true);expect(Math.abs(b.reduce((sum,n)=>sum+n,0)/b.length)).toBeLessThan(.05);
});
it('encodes real stereo MP3 with metadata through the replaceable encoder while retaining input PCM',async()=>{
  const audio=tone(44100,22050,2),saved=audio.channels.map(ch=>ch.slice());
  const result=await exportAudioSource({audio},{format:'mp3',bitrate:320,metadata:{title:'日本語',artist:'Music Sync'}},{encoderFactory});
  const bytes=new Uint8Array(await result.blob.arrayBuffer());expect(new TextDecoder().decode(bytes.subarray(0,3))).toBe('ID3');
  expect(result.extension).toBe('mp3');expect(result.channels).toBe(2);expect(result.sampleRate).toBe(44100);expect(result.bitrate).toBe(320);
  expect(result.blob.size).toBeGreaterThan(18000);expect(audio.channels).toEqual(saved);
});
it('supports low and high source rates with a real MP3 encoder and reports the actual encoded rate',async()=>{
  for(const [input,output] of [[8000,32000],[16000,32000],[96000,48000],[192000,48000]]){
    const result=await exportAudioSource({audio:tone(input,Math.round(input*.2))},{format:'mp3',bitrate:192},{encoderFactory});
    expect(result.sampleRate).toBe(output);expect(result.bitrate).toBe(192);expect(result.blob.size).toBeGreaterThan(4000);
  }
});
it('keeps sinc upsampling continuous through file chunks and preserves the expected low-band waveform',async()=>{
  const rate=8000,frames=rate*9,audio=tone(rate,frames),values:number[]=[];
  const result=await exportAudioSource({audio},{format:'mp3',bitrate:192},{encoderFactory:()=>({
    encodeBuffer(left){for(const value of left)values.push(value/32768);return new Uint8Array([255,251,184,192]);},
    flush(){return new Uint8Array(0);},
  })});
  expect(values.length).toBe(frames*4);expect(result.sampleRate).toBe(32000);
  let error=0,power=0;
  for(let n=100;n<values.length-100;n++){
    const expected=.2*Math.sin(2*Math.PI*440*n/32000);error+=(values[n]-expected)**2;power+=expected**2;
  }
  expect(Math.sqrt(error/power)).toBeLessThan(.001);
});
it('rejects clipping/malformed options and stops cancellation before producing a downloadable result',async()=>{
  expect(()=>validateAudioExportOptions({format:'bogus' as AudioExportFormat})).toThrow();
  expect(()=>validateAudioExportOptions({format:'mp3',bitrate:12 as never})).toThrow();
  const clipped={sampleRate:16000,channels:[new Float32Array(100).fill(1.1)]};
  await expect(exportAudioSource({audio:clipped},{format:'wav-16'})).rejects.toThrow('0 dBFS');
  await expect(exportAudioSource({audio:clipped},{format:'mp3'},{encoderFactory})).rejects.toThrow('0 dBFS');
  const floating=await exportAudioSource({audio:clipped},{format:'wav-f32'});expect(floating.frames).toBe(100);
  const abort=new AbortController();
  await expect(exportAudioSource({audio:tone(48000,96000)},{format:'wav-24'},{signal:abort.signal,progress(){abort.abort();}})).rejects.toThrow();
  const malformed={sampleRate:48000,channels:[new Float32Array([NaN])]};
  await expect(exportAudioSource({audio:malformed},{format:'wav-f32'})).rejects.toThrow();
});
