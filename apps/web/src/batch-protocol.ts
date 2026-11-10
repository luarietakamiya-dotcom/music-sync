import type {AnalysisResult,AudioData,AutoMode,FinishControls,LiveSelection,OutputProfileId,RepairControls,SoundColorSelection,TrebleMode,ReferenceSelection} from '@music-sync/core';
import type {BatchLoudnessInput,BatchLoudnessOptions,BatchLoudnessPlan} from '@music-sync/core';

export const BATCH_STORAGE_LIMITS=Object.freeze({maxTracks:20,maxInputBytes:2*1024**3,maxOutputBytes:4*1024**3,
  maxFileBytes:512*1024**2,maxPcmBytes:96*1024**2,maxSeconds:1200});

export interface BatchFinishOptions {
  mode?:AutoMode;output?:OutputProfileId;controls?:FinishControls;repairControls?:RepairControls;treble?:TrebleMode;
  aggression?:number;soundColor?:SoundColorSelection;live?:LiveSelection;reference?:ReferenceSelection;
}
export type BatchRequest =
  | {kind:'batch-analyze';id:string;file?:File;audio?:AudioData}
  | ({kind:'batch-finish';id:string;file?:File;audio?:AudioData;destination:FileSystemFileHandle;rawDestination?:FileSystemFileHandle}&BatchFinishOptions)
  | ({kind:'batch-plan';tracks:BatchLoudnessInput[]}&BatchLoudnessOptions)
  | {kind:'batch-level';id:string;file:File;gainDb:number;analysis:AnalysisResult;destination:FileSystemFileHandle;ceilingDb?:number};
export type BatchResponse =
  | {type:'progress';id?:string;fraction:number;text:string}
  | {type:'error';id?:string;message:string}
  | {type:'batch-analyzed';id:string;analysis:AnalysisResult}
  | {type:'batch-finished';id:string;file:File;analysis:AnalysisResult;originalAnalysis:AnalysisResult;originalFile?:File;status:'accepted';notes:string[]}
  | {type:'batch-plan-result';plan:BatchLoudnessPlan}
  | {type:'batch-level-result';id:string;file:File;analysis:AnalysisResult};
