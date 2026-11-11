import type {AudioData} from '@music-sync/shared';

export interface SeparationModel {
  id:string;kind:'music'|'drums';targets:readonly string[];segmentSeconds:number;overlap:number;
}
export interface SeparationInput {sampleRate:number;channels:1|2;frames:number}
export interface SeparationPlan {
  version:1;input:Readonly<SeparationInput>;model:Readonly<SeparationModel>;targets:readonly string[];
  starts:readonly number[];segmentFrames:number;stepFrames:number;overlapFrames:number;outputChannels:2;
  /** Float32 PCM bytes across all outputs, excluding container headers. */
  outputBytes:number;
  /** Overlap accumulators and shared weights, excluding model/input/output arrays. */
  windowBytes:number;
}
export interface SeparationProgress {fraction:number;text:string}
export interface SeparationRenderer {
  read(start:number,frames:number):Promise<AudioData>;
  /** Receives an owned, stereo window, padded with zeros to segmentFrames at the tail.
   * Return exactly the declared targets at the same rate and window length.
   */
  infer(audio:AudioData):Promise<Record<string,AudioData>>;
  /** Writes are provisional until renderSeparation resolves; discard them on failure/cancel. */
  write(target:string,audio:AudioData):Promise<void>;
  signal?:AbortSignal;progress?(progress:SeparationProgress):void;
}
export interface SeparationSummary {
  frames:number;segments:number;maxPeak:number;targetPeaks:Readonly<Record<string,number>>;
}
export const SEPARATION_LIMITS=Object.freeze({maxSeconds:1200,maxPcmBytes:512*1024**2,maxTargets:16,
  minSegmentSeconds:2,maxSegmentSeconds:40,maxOverlap:.9,maxSegments:6001});
const finite=(value:unknown,min:number,max:number):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>=min&&value<=max;
const fail:(message:string)=>never=message=>{throw new Error(message);};
const validName=(value:unknown):value is string=>typeof value==='string'&&!!value.trim()&&value.length<=128&&!value.includes('\0')&&
  !['__proto__','constructor','prototype'].includes(value);

/** Metadata-only planning; no full-song PCM or output buffers are allocated. */
export function planSeparation(input:SeparationInput,model:SeparationModel):Readonly<SeparationPlan>{
  if(!input||!Number.isInteger(input.sampleRate)||!finite(input.sampleRate,8000,192000)||![1,2].includes(input.channels)||
    !Number.isSafeInteger(input.frames)||!finite(input.frames,1,input.sampleRate*SEPARATION_LIMITS.maxSeconds)||
    input.frames*input.channels*4>SEPARATION_LIMITS.maxPcmBytes||input.frames*8>SEPARATION_LIMITS.maxPcmBytes)
    fail('分離する音声は8–192 kHz・モノラル／ステレオ、20分以内・各出力PCM512 MiB以内にしてください。');
  if(!model||!validName(model.id)||!['music','drums'].includes(model.kind)||!Array.isArray(model.targets)||
    !model.targets.length||model.targets.length>SEPARATION_LIMITS.maxTargets||Array.from(model.targets).some(target=>!validName(target))||
    new Set(model.targets).size!==model.targets.length||!finite(model.segmentSeconds,2,40)||!finite(model.overlap,0,.9))
    fail('分離モデルの対象・区間長・重なり設定が不正です。');
  const segmentFrames=Math.round(input.sampleRate*model.segmentSeconds),overlapFrames=Math.round(segmentFrames*model.overlap),stepFrames=segmentFrames-overlapFrames;
  const count=input.frames<=segmentFrames?1:1+Math.ceil((input.frames-segmentFrames)/stepFrames);
  if(count>SEPARATION_LIMITS.maxSegments)fail('分離する区間数が上限を超えています。');
  const targets=Object.freeze([...model.targets]);
  return Object.freeze({version:1,input:Object.freeze({sampleRate:input.sampleRate,channels:input.channels,frames:input.frames}),
    model:Object.freeze({id:model.id,kind:model.kind,segmentSeconds:model.segmentSeconds,overlap:model.overlap,targets}),targets,
    starts:Object.freeze(Array.from({length:count},(_,index)=>index*stepFrames)),segmentFrames,stepFrames,overlapFrames,outputChannels:2,
    outputBytes:input.frames*8*targets.length,windowBytes:segmentFrames*(targets.length*8+8)});
}
function checkedPlan(plan:SeparationPlan):Readonly<SeparationPlan>{
  if(!plan||plan.version!==1)fail('分離計画が不正です。');
  const expected=planSeparation(plan.input,plan.model);
  if(plan.segmentFrames!==expected.segmentFrames||plan.stepFrames!==expected.stepFrames||plan.overlapFrames!==expected.overlapFrames||
    plan.outputChannels!==2||plan.outputBytes!==expected.outputBytes||plan.windowBytes!==expected.windowBytes||
    !Array.isArray(plan.starts)||plan.starts.length!==expected.starts.length||plan.starts.some((start,index)=>start!==expected.starts[index])||
    !Array.isArray(plan.targets)||plan.targets.length!==expected.targets.length||plan.targets.some((target,index)=>target!==expected.targets[index]))
    fail('分離計画の区間情報が一致しません。');
  return expected;
}
function validatePcm(audio:AudioData,rate:number,channels:number,frames:number,abort:()=>void){
  if(!audio||audio.sampleRate!==rate||!Array.isArray(audio.channels)||audio.channels.length!==channels||
    audio.channels.some(channel=>!(channel instanceof Float32Array)||channel.length!==frames))fail('分離音声の形式・長さ・レートが一致しません。');
  for(const channel of audio.channels)for(let frame=0;frame<frames;frame++){
    if(frame%65536===0)abort();
    if(!Number.isFinite(channel[frame]))fail('分離音声に不正なサンプル値があります。');
  }
}

/** Bounded overlap-add renderer. Shared positive weights preserve input edges and
 * mixture reconstruction; individual stems are never clipped or normalized.
 * Hosts should write to temporary destinations and adopt only after this resolves.
 */
export async function renderSeparation(value:SeparationPlan,renderer:SeparationRenderer):Promise<SeparationSummary>{
  const plan=checkedPlan(value);
  if(!renderer||typeof renderer.read!=='function'||typeof renderer.infer!=='function'||typeof renderer.write!=='function')fail('分離処理のアダプターが不正です。');
  const {signal}=renderer;
  const abort=()=>signal?.throwIfAborted();
  const notify=(fraction:number,text:string)=>{abort();renderer.progress?.({fraction,text});abort();};
  abort();
  const size=plan.segmentFrames,rate=plan.input.sampleRate,targets=plan.targets;
  const owned=Object.freeze({sampleRate:rate,channels:Object.freeze([new Float32Array(size),new Float32Array(size)])});
  const weights=new Float64Array(size);
  const rings=targets.map(()=>[new Float32Array(size),new Float32Array(size)]);
  const peaks=Object.fromEntries(targets.map(target=>[target,0])) as Record<string,number>;
  let cursor=0,emitted=0;
  notify(0,'音源分離を準備しています…');
  for(const [segment,start] of plan.starts.entries()){
    const frames=Math.min(size,plan.input.frames-start),last=segment===plan.starts.length-1;
    notify(emitted/plan.input.frames,`${segment+1}/${plan.starts.length}区間の音声を読み込んでいます…`);
    abort();const original=await renderer.read(start,frames);abort();validatePcm(original,rate,plan.input.channels,frames,abort);
    for(let channel=0;channel<2;channel++){
      owned.channels[channel].fill(0);owned.channels[channel].set(original.channels[Math.min(channel,plan.input.channels-1)]);
    }
    notify(emitted/plan.input.frames,`${segment+1}/${plan.starts.length}区間を分離しています…`);
    abort();const separated=await renderer.infer(owned);abort();
    if(!separated||typeof separated!=='object'||Array.isArray(separated)||
      ![Object.prototype,null].includes(Object.getPrototypeOf(separated))||Object.keys(separated).length!==targets.length||
      targets.some(target=>!Object.hasOwn(separated,target)))fail('分離モデルが返したパート一覧が一致しません。');
    // Validate every target before changing this segment's accumulators or writing any of it.
    for(const target of targets)validatePcm(separated[target],rate,2,size,abort);
    for(let frame=0;frame<frames;frame++){
      let weight=1;
      if(start>0&&frame<plan.overlapFrames)weight=Math.min(weight,(frame+1)/(plan.overlapFrames+1));
      if(!last&&frame>=plan.stepFrames)weight=Math.min(weight,(size-frame)/(plan.overlapFrames+1));
      const at=cursor+frame<size?cursor+frame:cursor+frame-size;weights[at]+=weight;
      for(let target=0;target<targets.length;target++)for(let channel=0;channel<2;channel++){
        rings[target][channel][at]+=separated[targets[target]].channels[channel][frame]*weight;
        if(!Number.isFinite(rings[target][channel][at]))fail('分離音声の合算値が範囲外です。');
      }
    }
    const count=last?plan.input.frames-start:plan.stepFrames;
    for(let target=0;target<targets.length;target++){
      const channels=[new Float32Array(count),new Float32Array(count)];
      for(let frame=0;frame<count;frame++){
        const at=cursor+frame<size?cursor+frame:cursor+frame-size,weight=weights[at];
        if(!Number.isFinite(weight)||weight<=0)fail('分離音声の重なり情報が不正です。');
        for(let channel=0;channel<2;channel++){
          const sample=rings[target][channel][at]/weight;channels[channel][frame]=sample;
          if(!Number.isFinite(channels[channel][frame]))fail('分離音声に不正なサンプル値があります。');
          peaks[targets[target]]=Math.max(peaks[targets[target]],Math.abs(channels[channel][frame]));
          rings[target][channel][at]=0;
        }
      }
      abort();await renderer.write(targets[target],{sampleRate:rate,channels});abort();
    }
    for(let frame=0;frame<count;frame++)weights[cursor+frame<size?cursor+frame:cursor+frame-size]=0;
    cursor=(cursor+count)%size;emitted+=count;
    notify(emitted/plan.input.frames,`${segment+1}/${plan.starts.length}区間の分離結果を保存しました。`);
  }
  abort();if(emitted!==plan.input.frames)fail('分離音声の長さが一致しません。');
  return {frames:emitted,segments:plan.starts.length,maxPeak:Math.max(...Object.values(peaks)),targetPeaks:Object.freeze(peaks)};
}
