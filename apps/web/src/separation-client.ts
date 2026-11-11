import {planSeparation,STEM_LIMITS,type AudioData} from '@music-sync/core';
import {readFlacMetadata,decodeFlac} from './decode';
import {readWavFileMetadata,LONG_WAV_LIMITS} from './wav-stream';
import {CandidateFile} from './candidate-file';
import {openAudioWorker} from './worker-client';
import workerUrl from './separation.worker.ts?worker&url';
import {SEPARATION_TRACKS,separationModel,separationTargets,type DirectSeparationMode,type SeparationMode,type SeparationRequest,type SeparationResponse,type SeparatedFiles} from './separation-protocol';
import {separationAvailableOnDevice} from './separation-platform';
export {separationAvailableOnDevice} from './separation-platform';
export type {SeparationMode,SeparatedFiles} from './separation-protocol';

export type SeparationDecoder=(file:File,signal:AbortSignal)=>Promise<AudioData>;
type Progress=(fraction:number|undefined,text:string)=>void;

/** One job owns provisional OPFS files; neither imports nor failed jobs can replace current A/B. */
export async function separateFile(file:File,mode:SeparationMode,signal:AbortSignal,progress:Progress,decode?:SeparationDecoder):Promise<SeparatedFiles>{
  if(mode!=='detailed')return separateDirect(file,mode,signal,progress,decode);
  let music:SeparatedFiles|undefined,drums:SeparatedFiles|undefined,transferred=false;
  try{
    music=await separateDirect(file,'four',signal,(fraction,text)=>progress(fraction===undefined?undefined:fraction*.45,'曲を素材に分けています · '+text),decode,7);
    signal.throwIfAborted();
    const parent=music.tracks.find(track=>track.id==='drums');if(!parent)throw new Error('ドラム素材を用意できませんでした。');
    drums=await separateDirect(parent.file,'drums',signal,(fraction,text)=>progress(fraction===undefined?undefined:.45+fraction*.55,'ドラムを細かく分けています · '+text));
    signal.throwIfAborted();
    if(music.report.frames!==drums.report.frames||music.report.sampleRate!==drums.report.sampleRate)throw new Error('曲とドラムの分離結果の長さが一致しません。');
    const tracks=[...music.tracks.filter(track=>track.id!=='drums'),...drums.tracks];
    const targetPeaks=Object.fromEntries(tracks.map(track=>[track.id,music!.report.targetPeaks[track.id]??drums!.report.targetPeaks[track.id]]));
    const heldMusic=music,heldDrums=drums;let references=1,disposed=false,cleanup:Promise<void>|undefined;
    const release=()=>{if(--references===0)cleanup=Promise.all([heldMusic.dispose(),heldDrums.dispose()]).then(()=>{});};
    const result:SeparatedFiles={original:music.original,mode:'stems',tracks:Object.freeze(tracks),report:{
      ...music.report,model:'SCNet + Mega53 Drums',segments:music.report.segments+drums.report.segments,targetPeaks,
      maxPeak:Math.max(...Object.values(targetPeaks)),residualRmsRatio:Math.max(music.report.residualRmsRatio,drums.report.residualRmsRatio),
      backend:music.report.backend===drums.report.backend?music.report.backend:'mixed',
    },retain(){if(references<=0)throw new Error('分離素材はすでに解放されています。');references++;let done=false;return ()=>{if(!done){done=true;release();}};},
    async dispose(){if(!disposed){disposed=true;release();}await cleanup;},};
    progress(1,'ドラムを細分化した9素材を用意しました。各パートを聴いて確認してください。');signal.throwIfAborted();transferred=true;return result;
  }finally{if(!transferred)await Promise.all([music?.dispose(),drums?.dispose()]);}
}

async function separateDirect(file:File,mode:DirectSeparationMode,signal:AbortSignal,progress:Progress,decode?:SeparationDecoder,extraOutputs=0):Promise<SeparatedFiles>{
  signal.throwIfAborted();
  if(!separationAvailableOnDevice())throw new Error('AI STEM分離はPCでご利用ください。');
  if(!(file instanceof File)||!file.size||file.size>LONG_WAV_LIMITS.maxFileBytes||!/^.+\.(wav|flac)$/i.test(file.name)||!['four','two','drums'].includes(mode))throw new Error('分離するWAV / FLACを1曲選んでください。WAVは512 MiB以内です。');
  if(!navigator.storage?.getDirectory||!navigator.locks)throw new Error('このブラウザでは分離用の一時保存を利用できません。PCのChrome / Edgeなどで開いてください。');
  progress(undefined,'原音の形式と分離する長さを確認しています…');
  const flac=/\.flac$/i.test(file.name);
  if(flac&&file.size>STEM_LIMITS.maxFileBytes)throw new Error('FLACの分離は100 MiB以内です。長い音源はWAVを使用してください。');
  const metadata=flac?readFlacMetadata(await file.slice(0,42).arrayBuffer()):await readWavFileMetadata(file);
  signal.throwIfAborted();
  if(flac&&metadata.frames*metadata.channels*4>STEM_LIMITS.maxBusBytes)throw new Error('このFLACは展開後96 MiBを超えます。WAVにして分離してください。');
  const model=separationModel(mode),targets=separationTargets(mode),plan=planSeparation({sampleRate:metadata.sampleRate,channels:metadata.channels as 1|2,frames:metadata.frames},
    {id:model.id,kind:mode==='drums'?'drums':'music',targets,segmentSeconds:model.segmentSeconds,overlap:model.overlap});
  const estimate=await navigator.storage.estimate();signal.throwIfAborted();
  const required=metadata.frames*8*(targets.length+extraOutputs)+(targets.length+extraOutputs)*56+file.size+128*1024**2;
  if(estimate.quota!==undefined&&estimate.usage!==undefined&&estimate.quota-estimate.usage<required)throw new Error('分離結果を保存する空き容量が不足しています。ブラウザの一時データを整理するか、短い音源を使用してください。');
  let audio:AudioData|undefined;
  if(flac){
    progress(undefined,'FLACを分離用に展開しています…');
    audio=decode?await decode(file,signal):await decodeFlac(await file.arrayBuffer(),STEM_LIMITS.maxBusBytes);signal.throwIfAborted();
  }
  const outputs=targets.map(()=>new CandidateFile()),originalLease=new CandidateFile(),leases=[originalLease,...outputs];
  let worker:Worker|undefined,transferred=false;
  const abort=()=>worker?.terminate();signal.addEventListener('abort',abort,{once:true});
  try{
    const handles=await Promise.all(outputs.map(lease=>lease.handle));signal.throwIfAborted();
    progress(undefined,'原音を保持するためのコピーを準備しています…');
    const originalHandle=await originalLease.handle,copy=await originalHandle.createWritable();
    const abortCopy=()=>{void copy.abort().catch(()=>{});};signal.addEventListener('abort',abortCopy,{once:true});
    try{await copy.write(file);signal.throwIfAborted();await copy.close();}
    catch(error){await copy.abort().catch(()=>{});throw error;}
    finally{signal.removeEventListener('abort',abortCopy);}
    signal.throwIfAborted();
    const original=new File([await originalHandle.getFile()],file.name,{type:file.type});
    if(original.size!==file.size)throw new Error('原音コピーのサイズが一致しません。');
    worker=await openAudioWorker('separation',new URL(workerUrl,document.baseURI));signal.throwIfAborted();
    const report=await new Promise<Extract<SeparationResponse,{type:'separation-result'}>['report']>((resolve,reject)=>{
      const cancelled=()=>reject(signal.reason??new DOMException('Cancelled','AbortError'));
      const complete=(error?:unknown,result?:Extract<SeparationResponse,{type:'separation-result'}>['report'])=>{
        signal.removeEventListener('abort',cancelled);if(error)reject(error);else resolve(result!);
      };
      signal.addEventListener('abort',cancelled,{once:true});
      worker!.onerror=event=>{event.preventDefault();complete(new Error('AI分離エンジンが停止しました。原音と現在のA/Bは保持しています。'));};
      worker!.onmessage=(event:MessageEvent<SeparationResponse>)=>{
        if(signal.aborted)return;
        const message=event.data;
        if(message.type==='separation-progress')progress(message.fraction,message.text);
        else if(message.type==='error')complete(new Error(message.message));
        else if(message.type==='separation-result')complete(undefined,message.report);
      };
      const request:SeparationRequest={kind:'separate',file:original,mode,plan,audio,destinations:Object.fromEntries(targets.map((target,i)=>[target,handles[i]]))};
      try{worker!.postMessage(request,audio?.channels.map(channel=>channel.buffer as ArrayBuffer)??[]);}catch(error){complete(error);}
    });
    signal.throwIfAborted();
    if(report.model!==model.label||report.frames!==metadata.frames||report.sampleRate!==metadata.sampleRate||
      !Number.isFinite(report.maxPeak)||!Number.isFinite(report.residualRmsRatio)||report.residualRmsRatio<0||report.residualRmsRatio>.75)
      throw new Error('分離結果の検証に失敗しました。現在の音源は保持しています。');
    const originalName=file.name.replace(/\.(wav|flac)$/i,'').replace(/[\\/:*?"<>|\p{Cc}]/gu,'_').slice(0,100)||'Music Sync';
    const tracks=await Promise.all(targets.map(async(target,index)=>{
      const stored=await handles[index].getFile();signal.throwIfAborted();
      const info=await readWavFileMetadata(stored);
      if(info.frames!==metadata.frames||info.sampleRate!==metadata.sampleRate||info.channels!==2||stored.size!==metadata.frames*8+56)throw new Error('分離音声の長さが一致しません。');
      return {id:target,label:SEPARATION_TRACKS[target].label,role:SEPARATION_TRACKS[target].role,
        file:new File([stored],`${index+1} ${target} - ${originalName}.wav`,{type:'audio/wav'})};
    }));
    signal.throwIfAborted();
    let references=1,disposed=false,cleanup:Promise<void>|undefined;
    const release=()=>{if(--references===0)cleanup=Promise.all(leases.map(lease=>lease.discard())).then(()=>{});};
    const result:SeparatedFiles={original,mode:mode==='two'?'vocal-instrumental':'stems',tracks:Object.freeze(tracks),report,
      retain(){if(references<=0)throw new Error('分離素材はすでに解放されています。');references++;let released=false;return ()=>{if(!released){released=true;release();}};},
      async dispose(){if(!disposed){disposed=true;release();}await cleanup;},
    };
    progress(1,'分離した素材を用意しました。各パートを聴いて確認してください。');signal.throwIfAborted();transferred=true;return result;
  }finally{
    signal.removeEventListener('abort',abort);worker?.terminate();
    if(!transferred)await Promise.all(leases.map(lease=>lease.discard()));
  }
}
