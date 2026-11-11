import {planSeparation,renderSeparation,floatWavHeader,writeFloatSamples,StreamingAudioAnalyzer,type AudioData} from '@music-sync/core';
import {readWavFileMetadata,streamWavChunks} from './wav-stream';
import {createSeparationInference} from './separation-inference';
import {separationModel,separationTargets,SEPARATION_TRACKS,type SeparationRequest,type SeparationResponse} from './separation-protocol';

let working=false;
const send=(message:SeparationResponse)=>self.postMessage(message);
self.onmessage=(event:MessageEvent<SeparationRequest>)=>{void run(event.data).catch(error=>send({type:'error',message:error instanceof Error?error.message:'音源を分離できませんでした。'}));};
interface SyncOutput {
  write(buffer:Uint8Array,options:{at:number}):number;
  truncate(size:number):void;flush():void;close():void;
}
type SyncFile=FileSystemFileHandle&{createSyncAccessHandle():Promise<SyncOutput>};
async function run(request:SeparationRequest){
  if(working)throw new Error('音源分離は1曲ずつ実行してください。');
  working=true;
  const offsets=new Map<string,number>();let engine:Awaited<ReturnType<typeof createSeparationInference>>|undefined;
  /** No file lock survives a bounded write, particularly not an ONNX call.
   * Terminating a Worker in native WASM may delay async writable-stream cleanup;
   * keeping those streams across inference used to prevent UI-owned OPFS deletion.
   */
  async function writeOutput(target:string,bytes:ArrayBuffer,initialize=false){
    const destination=request.destinations[target] as SyncFile;
    if(typeof destination.createSyncAccessHandle!=='function')throw new Error('このブラウザでは分離結果を安全に保存できません。PCのChrome / Edgeを使用してください。');
    const access=await destination.createSyncAccessHandle();
    try{
      const start=initialize?0:offsets.get(target);
      if(start===undefined)throw new Error('分離音声の保存位置が不正です。');
      if(initialize)access.truncate(0);
      const data=new Uint8Array(bytes);let written=0;
      while(written<data.byteLength){
        const count=access.write(data.subarray(written),{at:start+written});
        if(!Number.isSafeInteger(count)||count<=0||count>data.byteLength-written)throw new Error('分離音声を最後まで保存できませんでした。');
        written+=count;
      }
      access.flush();offsets.set(target,start+written);
    }finally{access.close();}
  }
  try{
    if(request?.kind!=='separate'||!(request.file instanceof File)||!['four','two','drums'].includes(request.mode))throw new Error('分離リクエストが不正です。');
    const model=separationModel(request.mode),targets=separationTargets(request.mode),info=request.audio?undefined:await readWavFileMetadata(request.file);
    const input=info?{sampleRate:info.sampleRate,channels:info.channels as 1|2,frames:info.frames}:
      {sampleRate:request.audio!.sampleRate,channels:request.audio!.channels.length as 1|2,frames:request.audio!.channels[0].length};
    const plan=planSeparation(input,{id:model.id,kind:request.mode==='drums'?'drums':'music',targets,segmentSeconds:model.segmentSeconds,overlap:model.overlap});
    if(JSON.stringify(plan)!==JSON.stringify(request.plan)||Object.keys(request.destinations).length!==targets.length||targets.some(target=>!Object.hasOwn(request.destinations,target)))throw new Error('分離計画と出力先が一致しません。');
    for(const target of targets)await writeOutput(target,floatWavHeader(input.sampleRate,2,input.frames),true);
    engine=await createSeparationInference(request.mode,(fraction,text)=>send({type:'separation-progress',fraction,text}));
    let actualFrames=0;
    const summary=await renderSeparation(plan,{
      async read(start,frames){
        actualFrames=frames;
        if(request.audio)return {sampleRate:input.sampleRate,channels:request.audio.channels.map(channel=>channel.subarray(start,start+frames))};
        const channels=Array.from({length:input.channels},()=>new Float32Array(frames));let offset=0;
        for await(const block of streamWavChunks(request.file,{...info!,frames,dataOffset:info!.dataOffset+start*info!.align})){
          block.channels.forEach((channel,i)=>channels[i].set(channel,offset));offset+=block.channels[0].length;
        }
        return {sampleRate:input.sampleRate,channels};
      },
      infer:audio=>engine!.infer(audio,actualFrames),
      async write(target,audio){
        const bytes=new ArrayBuffer(audio.channels[0].length*8);writeFloatSamples(audio,new DataView(bytes));
        await writeOutput(target,bytes);
      },
      progress:({fraction,text})=>send({type:'separation-progress',fraction:.23+.62*fraction,text}),
    });
    await engine.dispose();const residualRmsRatio=engine.residualRmsRatio(),backend=engine.backend();engine=undefined;
    if(targets.some(target=>offsets.get(target)!==input.frames*8+56))throw new Error('分離音声の保存サイズが一致しません。');
    // Reopen and measure the actual files before the UI can see a successful result.
    for(const [index,target] of targets.entries()){
      send({type:'separation-progress',fraction:.85+.14*index/targets.length,text:SEPARATION_TRACKS[target].label+' の分離結果を確認しています…'});
      const file=await request.destinations[target].getFile(),metadata=await readWavFileMetadata(file);
      if(file.size!==input.frames*8+56||metadata.frames!==input.frames||metadata.channels!==2||metadata.sampleRate!==input.sampleRate)throw new Error('分離音声の長さが一致しません。');
      const meter=new StreamingAudioAnalyzer(input.sampleRate,2,input.frames);
      for await(const block of streamWavChunks(file,metadata))meter.push(block as AudioData);
      const analysis=meter.finish();
      if(analysis.durationSeconds!==input.frames/input.sampleRate)throw new Error('分離音声の再解析に失敗しました。');
    }
    send({type:'separation-result',report:{...summary,model:model.label,sampleRate:input.sampleRate,residualRmsRatio,backend}});
  }finally{await engine?.dispose().catch(()=>{});working=false;}
}
