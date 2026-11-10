import type { AudioData } from '@music-sync/core';
import { floatWavHeader, writeFloatSamples } from '@music-sync/core';
import { readWavFileMetadata, streamWavChunks } from './wav-stream';
import { encodeId3, validateAudioArtwork, validateAudioMetadata, type AudioArtwork, type AudioMetadata } from './id3';

export type AudioExportFormat='wav-f32'|'wav-24'|'wav-16'|'mp3';
export interface AudioExportOptions {
  format:AudioExportFormat; bitrate?:128|192|256|320; dither?:boolean;
  metadata?:AudioMetadata; artwork?:AudioArtwork;
}
export interface Mp3EncoderInstance {encodeBuffer(left:Int16Array,right?:Int16Array):Int8Array|Uint8Array;flush():Int8Array|Uint8Array}
export interface AudioExportHooks {
  signal?:AbortSignal; progress?(fraction:number,text:string):void;
  /** Host can replace the separately distributed encoder with an interface-compatible build. */
  encoderFactory?(channels:number,sampleRate:number,bitrate:number):Mp3EncoderInstance|Promise<Mp3EncoderInstance>;
}
export interface AudioExportResult {blob:Blob;mimeType:string;extension:'wav'|'mp3';sampleRate:number;channels:number;frames:number;bitrate?:number}
const maximum=512*1024**2;

export function validateAudioExportOptions(input:AudioExportOptions):AudioExportOptions {
  if(!input||!['wav-f32','wav-24','wav-16','mp3'].includes(input.format)||
    (input.bitrate!==undefined&&![128,192,256,320].includes(input.bitrate))||
    (input.dither!==undefined&&typeof input.dither!=='boolean'))throw new Error('書き出し形式の設定が不正です。');
  return {format:input.format,bitrate:input.bitrate??192,dither:input.dither??true,
    metadata:validateAudioMetadata(input.metadata),artwork:validateAudioArtwork(input.artwork)};
}
function dimensions(rate:number,channels:number,frames:number) {
  if(!Number.isInteger(rate)||rate<8000||rate>192000||![1,2].includes(channels)||!Number.isSafeInteger(frames)||frames<1||frames>rate*1200||frames*channels*4+56>maximum)
    throw new Error('書き出し音声はモノラル／ステレオ、8–192 kHz、20分・512 MiB以内にしてください。');
}
function checkSamples(block:AudioData,rate:number,channels:number,integer:boolean) {
  const n=block.channels[0]?.length??0;
  if(block.sampleRate!==rate||block.channels.length!==channels||!n||block.channels.some(ch=>!(ch instanceof Float32Array)||ch.length!==n))throw new Error('書き出し音声の形式が一致しません。');
  for(const ch of block.channels)for(const value of ch) {
    if(!Number.isFinite(value)||Math.abs(value)>32)throw new Error('書き出す音声に不正な値があります。');
    if(integer&&Math.abs(value)>1.0000001)throw new Error('ピークが0 dBFSを超えています。ピーク保護を有効にするか、Float32 WAVで保存してください。');
  }
}
async function inputSource(source:{audio?:AudioData;file?:File},signal?:AbortSignal) {
  signal?.throwIfAborted();
  if(!source||!!source.audio===!!source.file)throw new Error('書き出す音源を1つ指定してください。');
  if(source.file) {
    const file=source.file,info=await readWavFileMetadata(file);dimensions(info.sampleRate,info.channels,info.frames);
    return {...info,open:()=>streamWavChunks(file,info,signal)};
  }
  const audio=source.audio!;const rate=audio.sampleRate,channels=audio.channels?.length,frames=audio.channels?.[0]?.length??0;
  dimensions(rate,channels,frames);
  if(audio.channels.some(ch=>!(ch instanceof Float32Array)||ch.length!==frames))throw new Error('書き出す音声のチャンネルが不正です。');
  return {sampleRate:rate,channels,frames,async *open(){for(let offset=0;offset<frames;offset+=65536){signal?.throwIfAborted();yield {sampleRate:rate,channels:audio.channels.map(ch=>ch.subarray(offset,offset+65536))};}}};
}
function integerHeader(rate:number,channels:number,frames:number,bits:16|24):ArrayBuffer {
  const bytes=frames*channels*bits/8,pad=bytes&1,buffer=new ArrayBuffer(44),v=new DataView(buffer);
  const tag=(at:number,s:string)=>[...s].forEach((c,i)=>v.setUint8(at+i,c.charCodeAt(0)));
  tag(0,'RIFF');v.setUint32(4,36+bytes+pad,true);tag(8,'WAVE');tag(12,'fmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);
  v.setUint16(22,channels,true);v.setUint32(24,rate,true);v.setUint32(28,rate*channels*bits/8,true);v.setUint16(32,channels*bits/8,true);v.setUint16(34,bits,true);tag(36,'data');v.setUint32(40,bytes,true);return buffer;
}
function randomSequence(){let state=0x6d2b79f5;return()=>{state^=state<<13;state^=state>>>17;state^=state<<5;return(state>>>0)/4294967296;};}
function quantize(value:number,bits:16|24,dither:boolean,random:()=>number):number {
  const scale=2**(bits-1),noise=dither?random()-random():0;
  return Math.max(-scale,Math.min(scale-1,Math.round(value*scale+noise)));
}

/** Bounded windowed-sinc interpolation is used only to lift low-rate PCM to MPEG-1 rates.
 * High-rate input uses LAME's own low-pass/resampling path, without app-side decimation. */
class LowRateUpsampler {
  private buffers:Float32Array[];private base=0;private received=0;private next=0;
  private readonly taps=16;private readonly table:Float64Array[];
  constructor(private inputRate:number,private channels:number,private total:number,private outputRate=32000){
    this.buffers=Array.from({length:channels},()=>new Float32Array(0));
    this.table=Array.from({length:1025},(_,phase)=>{
      const fraction=phase/1024,w=new Float64Array(33);let sum=0;
      for(let k=-16;k<=16;k++){const x=fraction-k;const value=Math.abs(x)>=16?0:(Math.abs(x)<1e-12?1:Math.sin(Math.PI*x)/(Math.PI*x))*(.5+.5*Math.cos(Math.PI*x/16));w[k+16]=value;sum+=value;}
      for(let k=0;k<w.length;k++)w[k]/=sum;return w;
    });
  }
  *push(block?:AudioData):Generator<AudioData> {
    const final=!block;
    if(block){this.buffers=this.buffers.map((ch,c)=>{const result=new Float32Array(ch.length+block.channels[c].length);result.set(ch);result.set(block.channels[c],ch.length);return result;});this.received+=block.channels[0].length;}
    let output=Array.from({length:this.channels},()=>new Float32Array(1152)),fill=0;
    const count=Math.round(this.total*this.outputRate/this.inputRate);
    while(this.next<count){
      const at=this.next*this.inputRate/this.outputRate,center=Math.floor(at);
      if(!final&&center+this.taps>=this.received)break;
      const weights=this.table[Math.round((at-center)*1024)];
      for(let c=0;c<this.channels;c++){
        let value=0;for(let k=-this.taps;k<=this.taps;k++){const index=center+k;if(index>=0&&index<this.received)value+=(this.buffers[c][index-this.base]??0)*weights[k+this.taps];}
        output[c][fill]=value;
      }
      this.next++;fill++;
      if(fill===1152){yield{sampleRate:this.outputRate,channels:output};output=Array.from({length:this.channels},()=>new Float32Array(1152));fill=0;}
    }
    if(fill)yield{sampleRate:this.outputRate,channels:output.map(ch=>ch.subarray(0,fill))};
    const keep=Math.max(0,Math.floor(this.next*this.inputRate/this.outputRate)-this.taps-1),drop=keep-this.base;
    if(drop>0){this.buffers=this.buffers.map(ch=>ch.slice(drop));this.base=keep;}
  }
}
async function defaultEncoder(channels:number,rate:number,bitrate:number):Promise<Mp3EncoderInstance>{
  const path='../vendor/lamejs/lamejs.js';const url=new URL(path,import.meta.url);
  const module=await import(/* @vite-ignore */ url.href);
  if(typeof module.Mp3Encoder!=='function')throw new Error('MP3エンコーダーを読み込めませんでした。WAVで保存するか、画面を再読み込みしてください。');
  return new module.Mp3Encoder(channels,rate,bitrate);
}
function mp3Info(bytes:Uint8Array):{sampleRate:number;bitrate:number}|undefined {
  for(let i=0;i+4<=bytes.length;i++){
    if(bytes[i]!==255||(bytes[i+1]&224)!==224)continue;
    const version=(bytes[i+1]>>>3)&3,layer=(bytes[i+1]>>>1)&3,index=bytes[i+2]>>>4,rateIndex=(bytes[i+2]>>>2)&3;
    if(version===1||layer!==1||rateIndex===3||index===0||index===15)continue;
    const rates=[44100,48000,32000],bitrates=version===3?[0,32,40,48,56,64,80,96,112,128,160,192,224,256,320]:[0,8,16,24,32,40,48,56,64,80,96,112,128,144,160];
    return {sampleRate:rates[rateIndex]/(version===3?1:version===2?2:4),bitrate:bitrates[index]};
  }
}

/** Local export only. All samples come from the selected source, never from audio output/SE. */
export async function exportAudioSource(source:{audio?:AudioData;file?:File},selection:AudioExportOptions,hooks:AudioExportHooks={}):Promise<AudioExportResult>{
  const options=validateAudioExportOptions(selection),input=await inputSource(source,hooks.signal),parts:BlobPart[]=[];
  const {sampleRate,channels,frames}=input;let read=0;
  const random=randomSequence();
  if(options.format!=='mp3'){
    const bits=options.format==='wav-f32'?32:options.format==='wav-24'?24:16;
    parts.push(bits===32?floatWavHeader(sampleRate,channels,frames):integerHeader(sampleRate,channels,frames,bits));
    for await(const block of input.open()){
      hooks.signal?.throwIfAborted();checkSamples(block,sampleRate,channels,bits!==32);
      const buffer=new ArrayBuffer(block.channels[0].length*channels*bits/8),view=new DataView(buffer);
      if(bits===32)writeFloatSamples(block,view);
      else{let offset=0;for(let i=0;i<block.channels[0].length;i++)for(const ch of block.channels){const value=quantize(ch[i],bits,!!options.dither,random);if(bits===16)view.setInt16(offset,value,true);else{view.setUint8(offset,value&255);view.setUint8(offset+1,(value>>>8)&255);view.setUint8(offset+2,(value>>>16)&255);}offset+=bits/8;}}
      parts.push(buffer);read+=block.channels[0].length;hooks.progress?.(read/frames,'WAVを書き出しています…');
    }
    if(bits!==32&&((frames*channels*bits/8)&1))parts.push(new Uint8Array(1).buffer);
    hooks.signal?.throwIfAborted();
    return {blob:new Blob(parts,{type:'audio/wav'}),mimeType:'audio/wav',extension:'wav',sampleRate,channels,frames};
  }
  const encoderRate=sampleRate<32000?32000:sampleRate;
  const encoder=await(hooks.encoderFactory??defaultEncoder)(channels,encoderRate,options.bitrate!);
  hooks.signal?.throwIfAborted();
  parts.push(encodeId3(options.metadata,options.artwork,frames/sampleRate*1000).buffer as ArrayBuffer);
  let header:{sampleRate:number;bitrate:number}|undefined;
  const append=(bytes:Int8Array|Uint8Array)=>{if(bytes.length){const copy=new Uint8Array(bytes);header??=mp3Info(copy);parts.push(copy.buffer);}};
  let pending=Array.from({length:channels},()=>new Int16Array(1152)),fill=0;
  const encode=(block:AudioData)=>{
    checkSamples(block,encoderRate,channels,true);
    for(let offset=0;offset<block.channels[0].length;){
      hooks.signal?.throwIfAborted();const count=Math.min(1152-fill,block.channels[0].length-offset);
      for(let c=0;c<channels;c++)for(let i=0;i<count;i++)pending[c][fill+i]=quantize(block.channels[c][offset+i],16,false,random);
      offset+=count;fill+=count;
      if(fill===1152){append(encoder.encodeBuffer(pending[0],pending[1]));pending=Array.from({length:channels},()=>new Int16Array(1152));fill=0;}
    }
  };
  const upsample=sampleRate<32000?new LowRateUpsampler(sampleRate,channels,frames):undefined;
  for await(const block of input.open()){
    hooks.signal?.throwIfAborted();checkSamples(block,sampleRate,channels,true);
    if(upsample)for(const chunk of upsample.push(block))encode(chunk);else encode(block);
    read+=block.channels[0].length;hooks.progress?.(read/frames*.98,'MP3に変換しています…');
  }
  if(upsample)for(const chunk of upsample.push())encode(chunk);
  if(fill)append(encoder.encodeBuffer(pending[0].subarray(0,fill),pending[1]?.subarray(0,fill)));
  append(encoder.flush());hooks.signal?.throwIfAborted();
  if(!header)throw new Error('有効なMP3を作成できませんでした。WAVで保存してください。');
  hooks.progress?.(1,'曲情報とジャケットを付けてMP3を用意しました。');
  return {blob:new Blob(parts,{type:'audio/mpeg'}),mimeType:'audio/mpeg',extension:'mp3',sampleRate:header.sampleRate,channels,frames:Math.round(frames*header.sampleRate/sampleRate),bitrate:header.bitrate};
}
