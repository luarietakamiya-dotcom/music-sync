import {analyzeAudio,autoMixMaster,DEFAULT_FINISH_CONTROLS,DEFAULT_LIVE_SELECTION,StreamingAudioAnalyzer,validateAudio,
  floatWavHeader,writeFloatSamples,type AnalysisResult,type AudioData} from '@music-sync/core';
import {planBatchLoudness,BATCH_LOUDNESS_LIMITS} from '@music-sync/core';
import {decodeWav} from './decode';
import {renderLong} from './long-render';
import {LONG_WAV_LIMITS,readWavFileMetadata,streamWavChunks,type StreamWavInfo} from './wav-stream';
import type {BatchRequest,BatchResponse} from './batch-protocol';

const PCM_LIMIT=96*1024**2,BLOCK=65536;
const post=(response:BatchResponse)=>self.postMessage(response);
const progress=(id:string,fraction:number,text:string)=>post({type:'progress',id,fraction:Math.max(0,Math.min(1,fraction)),text});
const error:(message:string)=>never=message=>{throw new Error(message);};
function validId(id:string){if(typeof id!=='string'||!id||id.length>128||id.includes('\0'))error('曲IDが不正です。');}
function source(request:{file?:File;audio?:AudioData}){
  if((request.file===undefined)===(request.audio===undefined))error('音声ファイルまたはPCMを1つ指定してください。');
  if(request.file&&(!(request.file instanceof File)||!/\.wav$/i.test(request.file.name)))error('WorkerにはWAV、または展開済みのFLAC音声を渡してください。');
  if(request.audio){validateAudio(request.audio);if(request.audio.channels.reduce((sum,channel)=>sum+channel.byteLength,0)>PCM_LIMIT)error('FLACと短尺音源は展開後96 MiBまでです。');}
}
async function analyzeFile(file:File,id:string,start=0,range=1,info?:StreamWavInfo):Promise<AnalysisResult>{
  info??=await readWavFileMetadata(file);const meter=new StreamingAudioAnalyzer(info.sampleRate,info.channels,info.frames);let frames=0;
  for await(const chunk of streamWavChunks(file,info)){meter.push(chunk);frames+=chunk.channels[0].length;progress(id,start+range*frames/info.frames,'曲全体の音量とピークを測定しています…');}
  return meter.finish();
}
async function writeAudio(audio:AudioData,destination:FileSystemFileHandle,id:string,start=0,range=1){
  const frames=audio.channels[0].length,stream=await destination.createWritable();
  try{
    await stream.write(floatWavHeader(audio.sampleRate,audio.channels.length,frames));
    for(let offset=0;offset<frames;offset+=BLOCK){const chunk={sampleRate:audio.sampleRate,channels:audio.channels.map(channel=>channel.subarray(offset,offset+BLOCK))};
      const bytes=new ArrayBuffer(chunk.channels[0].length*chunk.channels.length*4);writeFloatSamples(chunk,new DataView(bytes));await stream.write(bytes);
      progress(id,start+range*Math.min(frames,offset+BLOCK)/frames,'仕上がりを一時ファイルに保存しています…');}
    await stream.close();
  }catch(failure){await stream.abort().catch(()=>{});throw failure;}
  const saved=await destination.getFile();if(saved.size!==56+frames*audio.channels.length*4)error('保存したWAVの長さが一致しません。');return saved;
}
function usable(analysis:AnalysisResult,id:string){
  const result=planBatchLoudness([{id,analysis}]).tracks[0];if(result.status!=='ready')error(result.reason||'音量を測定できません。');
}
function sameReport(expected:AnalysisResult,actual:AnalysisResult){
  if(!expected||expected.sampleRate!==actual.sampleRate||expected.channels!==actual.channels||expected.frames!==actual.frames||
    ['integratedLufs','rmsDbfs','truePeakDbtp','samplePeakDbfs'].some(key=>{
      const a=expected[key as keyof AnalysisResult],b=actual[key as keyof AnalysisResult];return typeof a!=='number'||typeof b!=='number'||!Number.isFinite(a)||Math.abs(a-b)>.05;
    }))error('一括調整の計画と候補ファイルの解析が一致しません。');
}
async function finish(request:Extract<BatchRequest,{kind:'batch-finish'}>){
  source(request);const {id,destination}=request;let input=request.audio,originalFile=request.file,originalAnalysis:AnalysisResult;
  let info:StreamWavInfo|undefined;
  if(request.file){info=await readWavFileMetadata(request.file);
    if(56+info.frames*info.channels*4>LONG_WAV_LIMITS.maxFileBytes)error('Float32 WAVの出力が512 MiBを超えます。サンプルレートまたは曲の長さを下げてください。');
    if(request.file.size<=100*1024**2&&info.frames*info.channels*4<=PCM_LIMIT&&info.frames/info.sampleRate<=600)
      input=decodeWav(await request.file.arrayBuffer(),PCM_LIMIT);
  }
  if(request.audio){
    if(!request.rawDestination)error('FLACの原音を保持する一時保存先がありません。');
    if(await destination.isSameEntry(request.rawDestination))error('原音と仕上がりには別の保存先を指定してください。');
    originalFile=await writeAudio(request.audio,request.rawDestination,id,0,.08);
  }
  if(input){
    const finished=autoMixMaster(input,request.mode??'AUTO',{treble:request.treble,repairControls:request.repairControls,
      aggression:request.aggression,soundColor:request.soundColor,live:request.live,reference:request.reference,
      preferences:{controls:request.controls??{...DEFAULT_FINISH_CONTROLS},output:request.output??'auto'},
      onProgress:step=>progress(id,.08+.7*step.fraction,({Analyzing:'音源を調べています…','Creating candidate':'必要な補正を選んでいます…',Evaluating:'候補が悪化していないか確認しています…',Finalizing:'仕上がりを確認しています…'})[step.stage]),
    });
    originalAnalysis=finished.before;
    if(originalAnalysis.clippedSamples>0)error('元音源にクリッピングがあります。この曲は自動採用しません。');
    if(!finished.processed||finished.status!=='accepted')error(finished.reasons.join(' ')||'品質条件を満たす仕上がりを作れませんでした。');
    const file=await writeAudio(finished.processed.audio,destination,id,.78,.1),analysis=await analyzeFile(file,id,.88,.12);
    usable(analysis,id);if(analysis.clippedSamples||analysis.truePeakDbtp!>-.999)error('保存した候補のピーク保護条件を満たしませんでした。');
    return {type:'batch-finished' as const,id,file,analysis,originalAnalysis,originalFile,status:'accepted' as const,
      notes:[...new Set([...finished.explanations,...(finished.reference?.explanations??[]),...(finished.reference?.reasons??[]),'一括の音量合わせは、この仕上がりを再測定してから行います。'])]};
  }
  if(request.soundColor&&request.soundColor.preset!=='none')error('長尺曲の一括仕上げでは音色プリセットを利用できません。音色を「原音」に戻してください。');
  originalAnalysis=await analyzeFile(request.file!,id,0,.12,info);usable(originalAnalysis,id);
  if(originalAnalysis.clippedSamples)error('元音源にクリッピングがあります。この曲は自動採用しません。');
  const rendered=await renderLong({kind:'long-render',file:request.file!,destination,before:originalAnalysis,mode:request.mode??'AUTO',
    output:request.output??'auto',live:request.live??DEFAULT_LIVE_SELECTION,controls:request.controls??{...DEFAULT_FINISH_CONTROLS},
    repairControls:request.repairControls,treble:request.treble,aggression:request.aggression,reference:request.reference},
  (fraction,stage)=>progress(id,.12+.88*fraction,stage));
  usable(rendered.result,id);
  return {type:'batch-finished' as const,id,file:rendered.file,analysis:rendered.result,originalAnalysis,originalFile,status:'accepted' as const,
    notes:[...rendered.explanations,'長尺WAVは分割処理しました。一括の音量合わせは、この仕上がりを再測定してから行います。']};
}
async function level(request:Extract<BatchRequest,{kind:'batch-level'}>){
  const {id,file,destination,gainDb}=request,ceiling=request.ceilingDb??-1;
  if(!(file instanceof File)||!Number.isFinite(gainDb)||gainDb< -160||gainDb>3||!Number.isFinite(ceiling)||ceiling< -6||ceiling> -1)error('一括調整のゲインまたはピーク上限が不正です。');
  const info=await readWavFileMetadata(file),before=await analyzeFile(file,id,0,.3,info);usable(before,id);sameReport(request.analysis,before);
  if(before.integratedLufs!+gainDb<BATCH_LOUDNESS_LIMITS.minCommonLufs-1e-6)error('指定音量が一括調整の最低音量を下回ります。');
  if(Math.max(before.truePeakDbtp!,before.samplePeakDbfs!)+gainDb>ceiling+1e-6)error('曲のピークを保ったまま指定音量にできません。');
  const gain=10**(gainDb/20),stream=await destination.createWritable();let frames=0;
  try{
    await stream.write(floatWavHeader(info.sampleRate,info.channels,info.frames));
    for await(const chunk of streamWavChunks(file,info)){
      for(const channel of chunk.channels)for(let i=0;i<channel.length;i++)channel[i]*=gain;
      const bytes=new ArrayBuffer(chunk.channels[0].length*info.channels*4);writeFloatSamples(chunk,new DataView(bytes));await stream.write(bytes);
      frames+=chunk.channels[0].length;progress(id,.3+.35*frames/info.frames,'曲ごとの音量差をゲインだけでそろえています…');
    }
    await stream.close();
  }catch(failure){await stream.abort().catch(()=>{});throw failure;}
  const saved=await destination.getFile();if(saved.size!==56+info.frames*info.channels*4)error('保存したWAVの長さが一致しません。');
  const after=await analyzeFile(saved,id,.65,.35);
  const delta=(a:number|null,b:number|null,expected:number,tolerance:number)=>a!==null&&b!==null&&Math.abs(a-b-expected)<=tolerance;
  if(after.sampleRate!==before.sampleRate||after.channels!==before.channels||after.frames!==before.frames||after.clippedSamples||
    after.truePeakDbtp===null||after.truePeakDbtp>ceiling+.001||!delta(after.integratedLufs,before.integratedLufs,gainDb,.15)||
    !delta(after.rmsDbfs,before.rmsDbfs,gainDb,.05)||!delta(after.crestFactorDb,before.crestFactorDb,0,.03)||
    (before.stereoCorrelation!==null&&!delta(after.stereoCorrelation,before.stereoCorrelation,0,.001))||
    (before.sideEnergyPercent!==null&&!delta(after.sideEnergyPercent,before.sideEnergyPercent,0,.01))||
    after.dcOffset.some((dc,index)=>Math.abs(dc-before.dcOffset[index]*gain)>1e-6))error('保存後の再測定で、音量または原音保護の条件を満たしませんでした。');
  return {type:'batch-level-result' as const,id,file:saved,analysis:after};
}
let working=false;
self.onmessage=(event:MessageEvent<unknown>)=>{
  if(!event.data||typeof event.data!=='object'||!('kind' in event.data)||typeof event.data.kind!=='string'){
    post({type:'error',message:'一括処理のリクエストが不正です。'});return;
  }
  const data=event.data as BatchRequest;
  const id='id' in data?data.id:undefined;
  if(working){post({type:'error',id,message:'一括処理が進行中です。曲を順に処理してください。'});return;}
  working=true;
  void(async()=>{
    try{
      if(data.kind!=='batch-plan')validId(data.id);
      if(data.kind==='batch-plan')post({type:'batch-plan-result',plan:planBatchLoudness(data.tracks,{targetLufs:data.targetLufs,ceilingDb:data.ceilingDb})});
      else if(data.kind==='batch-finish')post(await finish(data));
      else if(data.kind==='batch-level')post(await level(data));
      else if(data.kind==='batch-analyze'){
        source(data);const analysis=data.audio?analyzeAudio(data.audio,{onProgress:fraction=>progress(data.id,fraction,'音源を解析しています…')}):await analyzeFile(data.file!,data.id);
        post({type:'batch-analyzed',id:data.id,analysis});
      }else error('未対応の一括処理です。');
    }catch(failure){post({type:'error',id,message:failure instanceof Error?failure.message:'一括処理を完了できませんでした。'});}
    finally{working=false;}
  })();
};
