import { LIMITS, STEM_ROLES, planStemMix, validateProcessingChain,createComparisonPlan,singleSourceGainDb,
  type AnalysisResult, type AudioData, type AutoMode, type ProcessingChain,
  type StemDescriptor, type StemMixReport, type StemMode, type StemStudioSettings } from '@music-sync/core';
import type { StemFileEntry } from './stem-worker';
import type { SavedExportSettings } from './export-settings';
import { validateProjectManifest, type ProjectManifest } from './project-archive';

export type SessionSource = { result: AnalysisResult; name: string; originalFile?: File; stemMix?: StemMixReport;
  processing?: {chain: ProcessingChain;maxReductionDb:number;peakGuardDb:number} } &
  ({audio:AudioData;file?:never}|{audio?:never;file:File});
export interface SessionSettings {
  autoMode:AutoMode; controls:Record<string,string|boolean>; exportSettings:SavedExportSettings;
  selected:'a'|'b'; matched:boolean; position:number; acceptedFinishSettings?:string;
  stemModeExplicit:boolean; stemMode:StemMode; explanations?:Record<string,string>;
}
export interface SessionCaptureInput extends SessionSettings {
  name?:string;createdAt?:string;sources:Partial<Record<'a'|'b',SessionSource>>;
  stems:StemFileEntry[];committedStemInputs:StemFileEntry[];committedStemStudio?:StemStudioSettings;
  /** Raw mixed recordings for separated materials, keyed by exact material File identity. */
  stemOrigins?:ReadonlyMap<File,File>;
  committedStemOptions?:{signature:string;reference?:File};reference?:File;soundReference?:{file:File;strength:number;enabled:boolean};artwork?:File;
}
export type ProjectInspectionInput = {kind:'planar';sampleRate:number;frames:number;planes:File[]} | {kind:'file';file:File};
export type SessionInspectionInput = ProjectInspectionInput;
export interface ProjectInspectionOptions {signal?:AbortSignal;progress?(fraction:number,text:string):void;retainAudio:boolean}
export interface ProjectInspectionResult {result:AnalysisResult;audio?:AudioData;file?:File}
export interface SessionRestoreOptions {
  inspect(input:ProjectInspectionInput,options:ProjectInspectionOptions):Promise<ProjectInspectionResult>;
  signal?:AbortSignal;progress?(fraction:number,text:string):void;
  /** Host-specific control IDs and option values must be checked before touching UI state. */
  validateSettings?(settings:SessionSettings):void;
}
interface SavedStem {id:string;asset:string;original?:string;role:StemDescriptor['role'];gainDb:number;pan:number;muted:boolean;vocalRole?:StemDescriptor['vocalRole'];restorationEnabled?:boolean}
interface SavedMix {mode:StemMode;tracks:Omit<SavedStem,'asset'|'original'>[];attenuationDb:number}
interface SavedSource {name:string;data:{kind:'file';asset:string}|{kind:'planar';sampleRate:number;frames:number;planes:string[]};original?:string;mix?:SavedMix;processing?:SessionSource['processing']}
interface SavedSession {schemaVersion:1;settings:SessionSettings;sources:Partial<Record<'a'|'b',SavedSource>>;stems:SavedStem[];committed:SavedStem[];studio?:StemStudioSettings;options?:{signature:string;reference?:string};reference?:string;soundReference?:{asset:string;strength:number;enabled:boolean};artwork?:string}
const memoryLimit=96*1024**2;
const reject:(message?:string)=>never=(message='プロジェクトの作業状態が不正です。')=>{throw new Error(message);};
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const keys=(value:object,allowed:string[])=>Object.keys(value).every(key=>allowed.includes(key));
const text=(value:unknown,max=1024):value is string=>typeof value==='string'&&value.length>0&&value.length<=max&&!value.includes('\0');
const number=(value:unknown,min:number,max:number):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>=min&&value<=max;
const mode=(value:unknown):value is StemMode=>value==='stems'||value==='vocal-instrumental';
function sampleInfo(result:AnalysisResult){
  if(!result||!Number.isInteger(result.sampleRate)||!number(result.sampleRate,LIMITS.minSampleRate,LIMITS.maxSampleRate)||
    ![1,2].includes(result.channels)||!Number.isSafeInteger(result.frames)||!number(result.frames,1,result.sampleRate*1200))reject('素材の音声形式が不正です。');
  return {sampleRate:result.sampleRate,channels:result.channels,frames:result.frames};
}
function settings(value:unknown):SessionSettings {
  if(!object(value)||!keys(value,['autoMode','controls','exportSettings','selected','matched','position','acceptedFinishSettings','stemModeExplicit','stemMode','explanations'])||
    !['AUTO','IMPACT','LIVE'].includes(value.autoMode as string)||!object(value.controls)||Object.keys(value.controls).length>128||
    Object.entries(value.controls).some(([key,v])=>!text(key,100)||(typeof v!=='boolean'&&(typeof v!=='string'||v.length>4096)))||
    !['a','b'].includes(value.selected as string)||typeof value.matched!=='boolean'||!number(value.position,0,1200)||
    typeof value.stemModeExplicit!=='boolean'||!mode(value.stemMode)||
    (value.acceptedFinishSettings!==undefined&&!text(value.acceptedFinishSettings,32768)))reject();
  const output=value.exportSettings;
  if(!object(output)||!keys(output,['format','bitrate','dither','metadata'])||!['wav-f32','wav-16','wav-24','mp3'].includes(output.format as string)||
    ![128,192,256,320].includes(output.bitrate as number)||typeof output.dither!=='boolean'||!object(output.metadata)||
    !keys(output.metadata,['title','artist','album','albumArtist','year','track','genre','comment'])||
    Object.values(output.metadata).some(v=>typeof v!=='string'||v.length>1000||v.includes('\0')))reject('書き出し設定が不正です。');
  if(value.explanations!==undefined&&(!object(value.explanations)||Object.keys(value.explanations).length>32||
    Object.entries(value.explanations).some(([key,v])=>!text(key,100)||typeof v!=='string'||v.length>1024**2)))reject();
  return value as unknown as SessionSettings;
}
function studio(value:unknown):StemStudioSettings|undefined {
  if(value===undefined)return;
  if(!object(value)||!keys(value,['restore','treble','repair','doubleAmount','doubleMs','stabilize'])||typeof value.restore!=='boolean'||
    !number(value.doubleAmount,0,100)||!number(value.doubleMs,12,45)||!object(value.repair)||
    (value.treble!==undefined&&!['auto','off','light','standard','strong'].includes(value.treble as string)))reject('素材補修設定が不正です。');
  const r=value.repair;
  if(!keys(r,['grain','amount','repeatGrain','hissHz','hissDb','clarityDb','autoClarity'])||
    (r.grain!==undefined&&!['off','light','standard','strong'].includes(r.grain as string))||
    (r.amount!==undefined&&!number(r.amount,0,100))||(r.hissHz!==undefined&&!number(r.hissHz,7000,11000))||
    (r.hissDb!==undefined&&!number(r.hissDb,0,5))||(r.clarityDb!==undefined&&!number(r.clarityDb,0,3.5))||
    (r.repeatGrain!==undefined&&typeof r.repeatGrain!=='boolean')||(r.autoClarity!==undefined&&typeof r.autoClarity!=='boolean'))reject();
  if(value.stabilize!==undefined){const s=value.stabilize;
    if(!object(s)||!keys(s,['sensitivityDb','repairMs','maxDb','percent','toleranceDb'])||!number(s.sensitivityDb,0.1,3)||
      !number(s.repairMs,50,1000)||!number(s.maxDb,0,3)||!number(s.percent,0,10)||!number(s.toleranceDb,0,2))reject();
  }
  return value as unknown as StemStudioSettings;
}
function track(value:unknown,withAsset:boolean):SavedStem {
  if(!object(value)||!keys(value,['id',...(withAsset?['asset','original']:[]),'role','gainDb','pan','muted','vocalRole','restorationEnabled'])||
    !text(value.id,100)||!Object.hasOwn(STEM_ROLES,value.role as string)||!number(value.gainDb,-24,6)||!number(value.pan,-1,1)||
    typeof value.muted!=='boolean'||(withAsset&&(!text(value.asset,64)||(value.original!==undefined&&!text(value.original,64))))||
    (value.vocalRole!==undefined&&(value.role!=='vocal'||!['lead','backing'].includes(value.vocalRole as string)))||
    (value.restorationEnabled!==undefined&&typeof value.restorationEnabled!=='boolean'))reject('素材の役割・音量設定が不正です。');
  return value as unknown as SavedStem;
}
function tracks(value:unknown):SavedStem[]{
  if(!Array.isArray(value)||value.length>16)reject('STEMは16素材までです。');
  const parsed=value.map(item=>track(item,true));if(new Set(parsed.map(item=>item.id)).size!==parsed.length)reject('素材IDが重複しています。');return parsed;
}
function metadata(entry:Pick<StemFileEntry,'id'|'role'|'vocalRole'|'gainDb'|'pan'|'muted'|'restorationEnabled'>){
  return {id:entry.id,role:entry.role,gainDb:entry.gainDb,pan:entry.pan,muted:entry.muted,
    ...(entry.vocalRole===undefined?{}:{vocalRole:entry.vocalRole}),...(entry.restorationEnabled===undefined?{}:{restorationEnabled:entry.restorationEnabled})};
}
function processingInfo(value:unknown,sampleRate:number):SessionSource['processing']{
  if(value===undefined)return;
  if(!object(value)||!keys(value,['chain','maxReductionDb','peakGuardDb'])||!number(value.maxReductionDb,0,120)||!number(value.peakGuardDb,0,120))reject();
  validateProcessingChain(value.chain as ProcessingChain,sampleRate);return value as SessionSource['processing'];
}

/** Snapshot PCM planes separately: no WAV interleave or destructive editing is needed. */
export function captureProjectSession(input:SessionCaptureInput):{manifest:ProjectManifest;assets:{id:string;file:Blob}[]} {
  if(!input.sources.a)reject('保存する原音Aがありません。');
  if(input.sources.b)createComparisonPlan(input.sources.a.result,input.sources.b.result);else singleSourceGainDb(input.sources.a.result);
  for(const source of Object.values(input.sources))if(source?.stemMix&&!number(source.stemMix.attenuationDb,-120,0))reject('STEMのピーク保護ゲインが不正です。');
  if(new Uint8Array(new Uint16Array([1]).buffer)[0]!==1)reject('この端末のPCM形式には対応していません。');
  const assets:{id:string;file:Blob}[]=[],descriptors:ProjectManifest['assets']=[],known=new Map<Blob,string>();
  function add(file:Blob,name:string,mimeType:string){
    const existing=known.get(file);if(existing)return existing;
    const id='asset_'+assets.length;known.set(file,id);assets.push({id,file});descriptors.push({id,path:`assets/${id}.bin`,name,mimeType,size:file.size});return id;
  }
  function audioFile(file:File){if(!(file instanceof File)||!file.size||!/\.(wav|flac)$/i.test(file.name))reject('素材はWAV/FLACで保存してください。');return add(file,file.name,/\.flac$/i.test(file.name)?'audio/flac':'audio/wav');}
  const encodeTrack=(entry:StemFileEntry):SavedStem=>{
    const original=input.stemOrigins?.get(entry.file);
    return {...metadata(entry),asset:audioFile(entry.file),...(original===undefined?{}:{original:audioFile(original)})};
  };
  const state:SavedSession={schemaVersion:1,settings:settings({autoMode:input.autoMode,controls:input.controls,exportSettings:input.exportSettings,
    selected:input.selected,matched:input.matched,position:input.position,acceptedFinishSettings:input.acceptedFinishSettings,
    stemModeExplicit:input.stemModeExplicit,stemMode:input.stemMode,explanations:input.explanations}),sources:{},
    stems:input.stems.map(encodeTrack),committed:input.committedStemInputs.map(encodeTrack),studio:studio(input.committedStemStudio)};
  tracks(state.stems);tracks(state.committed);
  let retained=0;
  for(const slot of ['a','b'] as const){const source=input.sources[slot];if(!source)continue;
    const record:SavedSource={name:source.name,data:{kind:'file',asset:''}};
    if(source.audio){const info=sampleInfo(source.result),audio=source.audio;
      if(audio.sampleRate!==info.sampleRate||audio.channels.length!==info.channels||info.frames*info.channels*4>memoryLimit||
        audio.channels.some(channel=>!(channel instanceof Float32Array)||channel.length!==info.frames))reject('A/Bの音声が保存上限を超えています。');
      retained+=info.frames*info.channels*4;
      record.data={kind:'planar',sampleRate:info.sampleRate,frames:info.frames,planes:audio.channels.map((channel,index)=>
        add(new Blob([new Uint8Array(channel.buffer,channel.byteOffset,channel.byteLength) as Uint8Array<ArrayBuffer>]),`${slot.toUpperCase()} channel ${index+1}.f32`,'application/octet-stream'))};
    }else {if(!/\.wav$/i.test(source.file.name))reject('ファイル形式のA/B保存にはWAVを使用してください。');record.data={kind:'file',asset:audioFile(source.file)};}
    if(source.originalFile)record.original=audioFile(source.originalFile);
    if(source.stemMix)record.mix={mode:source.stemMix.plan.mode,tracks:source.stemMix.plan.tracks.map(metadata),attenuationDb:source.stemMix.attenuationDb};
    if(source.processing)record.processing=source.processing;
    state.sources[slot]=record;
  }
  if(retained>192*1024**2)reject('A/Bの合計PCMが192 MiBを超えています。');
  if(state.sources.a&&state.sources.b&&state.sources.a.data.kind!==state.sources.b.data.kind)reject('A/Bは同じ保存方式で保存してください。');
  if(input.committedStemOptions)state.options={signature:input.committedStemOptions.signature,
    ...(input.committedStemOptions.reference?{reference:audioFile(input.committedStemOptions.reference)}:{})};
  if(input.reference)state.reference=audioFile(input.reference);
  if(input.soundReference){if(!number(input.soundReference.strength,0,1)||typeof input.soundReference.enabled!=='boolean')reject('リファレンスの設定が不正です。');
    state.soundReference={asset:audioFile(input.soundReference.file),strength:input.soundReference.strength,enabled:input.soundReference.enabled};}
  if(input.artwork)state.artwork=add(input.artwork,input.artwork.name,input.artwork.type);
  const manifest=validateProjectManifest({format:'music-sync-project',version:1,name:input.name||input.sources.a?.name||'MusicSync Project',
    createdAt:input.createdAt||new Date().toISOString(),assets:descriptors,state});
  return {manifest,assets};
}

/** Validate first, then hydrate into an isolated result. Callers commit only after this resolves. */
export async function restoreProjectSession(imported:{manifest:ProjectManifest;assets:Map<string,File>},options:SessionRestoreOptions):Promise<SessionCaptureInput&{name:string;stemOrigins:Map<File,File>}> {
  const {signal,inspect,progress}=options;signal?.throwIfAborted();
  const manifest=validateProjectManifest(imported.manifest,signal),raw=manifest.state;
  if(!keys(raw,['schemaVersion','settings','sources','stems','committed','studio','options','reference','soundReference','artwork'])||raw.schemaVersion!==1||!object(raw.sources)||
    !keys(raw.sources,['a','b']))reject();
  const savedSettings=settings(raw.settings),stems=tracks(raw.stems),committed=tracks(raw.committed),savedStudio=studio(raw.studio);
  options.validateSettings?.(savedSettings);
  if(!raw.sources.a)reject('保存された原音Aがありません。');
  if(savedSettings.selected==='b'&&!raw.sources.b)reject();
  const used=new Set<string>(),asset=(id:unknown,type:'audio'|'plane'|'image'):File=>{
    if(!text(id,64))reject();const descriptor=manifest.assets.find(item=>item.id===id),file=imported.assets.get(id);
    if(!descriptor||!(file instanceof File)||file.size!==descriptor.size||file.name!==descriptor.name||file.type!==descriptor.mimeType)reject('保存素材が一致しません。');
    const allowed=type==='audio'?['audio/wav','audio/flac']:type==='plane'?['application/octet-stream']:['image/jpeg','image/png'];
    if(!allowed.includes(file.type)||(type==='audio'&&(!file.size||!/\.(wav|flac)$/i.test(file.name)))||
      (type==='image'&&(!file.size||file.size>2*1024**2)))reject('保存素材の形式が不正です。');
    used.add(id);return file;
  };
  const stemOrigins=new Map<File,File>();
  function restoreTrack(entry:SavedStem):StemFileEntry{
    const file=asset(entry.asset,'audio');
    if(entry.original!==undefined){
      const original=asset(entry.original,'audio'),previous=stemOrigins.get(file);
      if(previous&&previous!==original)reject('同じ分離素材の原曲が一致しません。');
      stemOrigins.set(file,original);
    }
    return {...metadata(entry),file};
  }
  const staged=stems.map(restoreTrack),applied=committed.map(restoreTrack);
  let savedOptions:{signature:string;reference?:File}|undefined;
  if(raw.options!==undefined){if(!object(raw.options)||!keys(raw.options,['signature','reference'])||!text(raw.options.signature,32768))reject();
    savedOptions={signature:raw.options.signature,...(raw.options.reference===undefined?{}:{reference:asset(raw.options.reference,'audio')})};}
  if(savedStudio?.stabilize&&!savedOptions?.reference)reject('安定化の比較用原曲がありません。');
  const reference=raw.reference===undefined?undefined:asset(raw.reference,'audio');
  let soundReference:SessionCaptureInput['soundReference'];
  if(raw.soundReference!==undefined){const saved=raw.soundReference;
    if(!object(saved)||!keys(saved,['asset','strength','enabled'])||!number(saved.strength,0,1)||typeof saved.enabled!=='boolean')reject('リファレンスの設定が不正です。');
    // Only the original file and user intent are stored. The host rebuilds its spectral profile before committing.
    soundReference={file:asset(saved.asset,'audio'),strength:saved.strength,enabled:saved.enabled};}
  const artwork=raw.artwork===undefined?undefined:asset(raw.artwork,'image');
  const savedSources:Partial<Record<'a'|'b',{record:SavedSource;input:ProjectInspectionInput;original?:File}>>={};let bytes=0;
  for(const slot of ['a','b'] as const){const value=raw.sources[slot];if(value===undefined)continue;
    if(!object(value)||!keys(value,['name','data','original','mix','processing'])||!text(value.name)||!object(value.data))reject();
    const data=value.data;let input:ProjectInspectionInput;
    if(data.kind==='file'){if(!keys(data,['kind','asset']))reject();const file=asset(data.asset,'audio');
      if(file.type!=='audio/wav'||!/\.wav$/i.test(file.name))reject('ファイル形式のA/B復元にはWAVを使用してください。');input={kind:'file',file};}
    else if(data.kind==='planar'){
      if(!keys(data,['kind','sampleRate','frames','planes'])||!Number.isInteger(data.sampleRate)||!number(data.sampleRate,8000,192000)||
        !Number.isSafeInteger(data.frames)||!number(data.frames,1,(data.sampleRate as number)*600)||!Array.isArray(data.planes)||
        ![1,2].includes(data.planes.length)||new Set(data.planes).size!==data.planes.length)reject();
      const planes=data.planes.map(id=>asset(id,'plane')),size=(data.frames as number)*planes.length*4;
      if(size>memoryLimit||planes.some(file=>file.size!==(data.frames as number)*4))reject('保存PCMが96 MiBを超えているか長さが不正です。');
      bytes+=size;input={kind:'planar',sampleRate:data.sampleRate as number,frames:data.frames as number,planes};
    }else reject();
    if(value.mix!==undefined){const mix=value.mix;
      if(!object(mix)||!keys(mix,['mode','tracks','attenuationDb'])||!mode(mix.mode)||!Array.isArray(mix.tracks)||mix.tracks.length!==committed.length||
        mix.tracks.length<2||!number(mix.attenuationDb,-120,0))reject('保存STEMレポートが不正です。');
      const ids=new Set<string>();for(const item of mix.tracks){const parsed=track(item,false);if(ids.has(parsed.id)||!committed.some(entry=>entry.id===parsed.id))reject();ids.add(parsed.id);}
    }
    processingInfo(value.processing,input.kind==='planar'?input.sampleRate:192000);
    savedSources[slot]={record:value as unknown as SavedSource,input,...(value.original===undefined?{}:{original:asset(value.original,'audio')})};
  }
  if(savedSources.a&&savedSources.b&&savedSources.a.input.kind!==savedSources.b.input.kind)reject('A/Bの保存方式が一致しません。');
  if(bytes>192*1024**2||used.size!==manifest.assets.length||imported.assets.size!==manifest.assets.length)reject('保存素材の合計または一覧が一致しません。');
  // Every original is checked again; saved analysis numbers never determine processing decisions.
  const checked=new Map<File,AnalysisResult>();let jobs=0,done=0;
  const fileList=[...new Set([...staged,...applied].map(item=>item.file).concat([...stemOrigins.values()],Object.values(savedSources).flatMap(item=>item?.original?[item.original]:[]),savedOptions?.reference?[savedOptions.reference]:[],reference?[reference]:[]))];
  jobs=Object.keys(savedSources).length+fileList.length;
  const report=(fraction:number,label:string)=>progress?.((done+fraction)/Math.max(1,jobs),label);
  async function check(input:ProjectInspectionInput,retainAudio:boolean){signal?.throwIfAborted();
    const result=await inspect(input,{signal,retainAudio,progress:(fraction,label)=>report(fraction,label)});signal?.throwIfAborted();sampleInfo(result.result);done++;return result;}
  for(const file of fileList){const found=await check({kind:'file',file},false);checked.set(file,found.result);}
  const descriptors=(entries:StemFileEntry[])=>entries.map(entry=>({...metadata(entry),name:entry.file.name,...sampleInfo(checked.get(entry.file)!)}));
  // Uncommitted workspace edits may intentionally be incomplete. Only committed mixes require a valid mix plan.
  if(applied.length>=2)planStemMix(descriptors(applied),savedSources.a?.record.mix?.mode||savedSettings.stemMode,savedSources.a?.input.kind==='file'?'file':'memory');
  const sources:SessionCaptureInput['sources']={};let actualBytes=0;
  for(const slot of ['a','b'] as const){const saved=savedSources[slot];if(!saved)continue;
    const inspected=await check(saved.input,true),info=sampleInfo(inspected.result);let audio:AudioData|undefined;
    if(saved.input.kind==='planar'){
      audio=inspected.audio;if(!audio||audio.sampleRate!==saved.input.sampleRate||audio.channels.length!==saved.input.planes.length||
        info.sampleRate!==saved.input.sampleRate||info.frames!==saved.input.frames||info.channels!==saved.input.planes.length||
        audio.channels.some(channel=>!(channel instanceof Float32Array)||channel.length!==info.frames))reject('保存PCMの解析結果が一致しません。');
    }
    if(audio){const size=audio.channels.reduce((sum,channel)=>sum+channel.byteLength,0);actualBytes+=size;if(size>memoryLimit||actualBytes>192*1024**2)reject('復元PCMが保存上限を超えています。');}
    const processing=processingInfo(saved.record.processing,info.sampleRate);
    const source:SessionSource={...(audio?{audio}:{file:(saved.input as {file:File}).file}),result:inspected.result,name:saved.record.name,
      ...(saved.original?{originalFile:saved.original}:{}),...(processing?{processing}: {})};
    if(saved.record.mix){const mix=saved.record.mix,rawDescriptors=descriptors(applied);
      const trackDescriptors=mix.tracks.map(item=>({...rawDescriptors.find(entry=>entry.id===item.id)!,...item}));
      const plan=planStemMix(trackDescriptors,mix.mode,audio?'memory':'file');
      if(info.sampleRate!==plan.sampleRate||info.channels!==2||info.frames!==plan.frames)reject('保存されたSTEMミックスと素材の音声形式が一致しません。');
      source.stemMix={version:1,plan,tracks:trackDescriptors.map(descriptor=>({descriptor,analysis:checked.get(applied.find(entry=>entry.id===descriptor.id)!.file)!})),
        attenuationDb:mix.attenuationDb,warnings:['プロジェクトを復元しました。素材を再解析しました。以前の自動判定・補修レポートは再利用していません。']};
    }
    sources[slot]=source;
  }
  if(sources.a&&sources.b)createComparisonPlan(sources.a.result,sources.b.result);else singleSourceGainDb(sources.a!.result);
  const active=sources[savedSettings.selected];const position=active?Math.min(savedSettings.position,active.result.durationSeconds):0;
  signal?.throwIfAborted();progress?.(1,'プロジェクトを復元する準備ができました。');
  return {...savedSettings,name:manifest.name,createdAt:manifest.createdAt,sources,stems:staged,committedStemInputs:applied,stemOrigins,
    committedStemStudio:savedStudio,committedStemOptions:savedOptions,reference,soundReference,artwork,position};
}
