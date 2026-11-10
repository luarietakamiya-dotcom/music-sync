import type { AnalysisResult, AudioData, StemStudioSettings, StemTrackReport } from '@music-sync/core';
import type { PlaybackSource } from './comparison-player';
import type { StemFileEntry } from './stem-worker';
import { CandidateFile } from './candidate-file';
import { openAudioWorker } from './worker-client';
import processingWorkerUrl from './processing.worker.ts?worker&url';

export interface StemRepairPreview {
  source: PlaybackSource;
  analysis: AnalysisResult;
  before: AnalysisResult;
  restoration?: StemTrackReport['restoration'];
  dispose(): void;
}
export async function prepareStemRepairPreview(entry: StemFileEntry, studio: StemStudioSettings,
  decode: (buffer:ArrayBuffer)=>Promise<AudioData>, signal:AbortSignal,
  progress:(fraction:number,text:string)=>void): Promise<StemRepairPreview> {
  let worker:Worker|undefined, temporary:CandidateFile|undefined;
  let disposed=false;
  const dispose=()=>{
    if(disposed)return;disposed=true;worker?.terminate();worker=undefined;
    void temporary?.discard();temporary=undefined;
  };
  const abort=()=>dispose();
  signal.throwIfAborted(); signal.addEventListener('abort',abort,{once:true});
  try {
    if(typeof navigator.storage?.getDirectory === 'function' && navigator.locks)temporary=new CandidateFile();
    const destination=await temporary?.handle;
    signal.throwIfAborted();
    const ready=await openAudioWorker('processing',new URL(processingWorkerUrl,document.baseURI));
    worker=ready;
    if(disposed||signal.aborted){ready.terminate();signal.throwIfAborted();throw new DOMException('Cancelled','AbortError');}
    const result=await new Promise<StemRepairPreview>((resolve,reject)=>{
      const cancelled=()=>reject(new DOMException('Cancelled','AbortError'));
      signal.addEventListener('abort',cancelled,{once:true});
      const fail=(error:unknown)=>{signal.removeEventListener('abort',cancelled);reject(error);};
      ready.onmessage=event=>{
        if(disposed||signal.aborted)return;
        const data=event.data;
        if(data.type==='stem-repair-progress'){progress(data.fraction,data.text);return;}
        if(data.type==='stem-flac'){
          void(async()=>{
            try{
              const audio=await decode(data.buffer);
              if(!disposed&&!signal.aborted)ready.postMessage({kind:'stems-flac-result',id:data.id,audio},audio.channels.map(ch=>ch.buffer as ArrayBuffer));
            }catch(error){if(!disposed&&!signal.aborted)ready.postMessage({kind:'stems-flac-result',id:data.id,error:error instanceof Error?error.message:'FLACを展開できません。'});}
          })();return;
        }
        if(data.type==='error'){fail(new Error(data.message));return;}
        if(data.type!=='stem-repair-result')return;
        signal.removeEventListener('abort',cancelled);ready.terminate();worker=undefined;
        resolve({source:data.file?{file:data.file}:{audio:data.audio},analysis:data.analysis,before:data.before,restoration:data.restoration,dispose});
      };
      ready.onerror=event=>{event.preventDefault();fail(new Error('素材の補修比較を準備できませんでした。元の素材とミックスは保持しています。'));};
      ready.postMessage({kind:'stem-repair-preview',entry,studio,destination});
    });
    // The owner releases the one retained candidate on close, material switch or rebuild.
    return {...result,dispose:()=>{signal.removeEventListener('abort',abort);dispose();}};
  }catch(error){signal.removeEventListener('abort',abort);dispose();throw error;}
}
