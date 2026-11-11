import type {AudioData, SeparationPlan, SeparationSummary, StemMode, StemRole} from '@music-sync/core';

export type SeparationMode = 'four' | 'two' | 'drums' | 'detailed';
export type DirectSeparationMode = Exclude<SeparationMode,'detailed'>;
export const SCNET_MODEL = Object.freeze({
  id: 'scnet-small-int8', label: 'SCNet', sha256: '98228931494151762a1c4ab1ec7899a894b1f81fd4a509921a9d2f9bacc50845',
  bytes: 12900277, path: 'models/scnet-small/scnet-98228931.int8.onnx',
  revision: 'e71bcdb42bce1d62b7fae25ba90fcbcf90f73f46', sampleRate: 44100, segmentSeconds: 11,
  graphSegment:485100,n:4096,hop:1024,frames:476,window:'ones' as const,normalized:true,standardize:true,overlap:.25,
  learnedTargets:Object.freeze(['drums','bass','other','vocals']),
});
export const DRUM_MODEL=Object.freeze({
  id:'mega53-drums-int8',label:'Mega53 Drums',sha256:'2044dee8a8756b92bc92ae14a0069d744bc67457ba3a4f2a592f414a17eaa8b2',
  bytes:91762503,path:'models/mega53-drums/mega53-drums-2044dee8.int8.onnx',
  revision:'1d4b3c431b37de696b3795ed2018493aacba946f',sampleRate:44100,segmentSeconds:2.99,
  graphSegment:132096,n:2048,hop:512,frames:259,window:'hann' as const,normalized:false,standardize:false,overlap:.5,
  learnedTargets:Object.freeze(['kick','snare','hh','toms','percussion']),
});
export const separationModel=(mode:DirectSeparationMode)=>mode==='drums'?DRUM_MODEL:SCNET_MODEL;
export const SEPARATION_TRACKS: Readonly<Record<string, {label:string;role:StemRole}>> = Object.freeze({
  vocals: {label:'ボーカル',role:'vocal'}, drums: {label:'ドラム',role:'drums'},
  bass: {label:'ベース',role:'bass'}, other: {label:'その他',role:'other'},
  instrumental: {label:'伴奏',role:'instrumental'},
  kick:{label:'キック',role:'drums'},snare:{label:'スネア',role:'drums'},hh:{label:'ハイハット',role:'drums'},
  toms:{label:'タム',role:'drums'},percussion:{label:'パーカッション',role:'drums'},
  'remaining-drums':{label:'残りのドラム',role:'drums'},
});
export const separationTargets = (mode:DirectSeparationMode):readonly string[] => mode==='drums'
  ? [...DRUM_MODEL.learnedTargets,'remaining-drums']
  : mode === 'two' ? ['vocals','instrumental'] : ['vocals','drums','bass','other'];
export interface SeparationReport extends SeparationSummary {
  model:string;sampleRate:number;residualRmsRatio:number;backend?:'webgpu'|'wasm'|'mixed';
}
export interface SeparationRequest {
  kind:'separate';file:File;mode:DirectSeparationMode;plan:SeparationPlan;
  audio?:AudioData;destinations:Record<string,FileSystemFileHandle>;
}
export type SeparationResponse = {type:'separation-progress';fraction?:number;text:string}
  | {type:'separation-result';report:SeparationReport}
  | {type:'error';message:string};
export interface SeparatedTrack {id:string;label:string;role:StemRole;file:File}
export interface SeparatedFiles {
  original:File;mode:StemMode;tracks:readonly SeparatedTrack[];report:SeparationReport;
  /** A retained group survives clearing the separation panel while the mixer uses its files. */
  retain():()=>void;dispose():Promise<void>;
}
