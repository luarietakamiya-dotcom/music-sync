import separate from '@audio/neural-separate';
import * as ort from 'onnxruntime-web/webgpu';
import wasmModule from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url';
import wasmBinary from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url';
import {createMixtureMasks, type AudioData} from '@music-sync/core';
import {separationModel, separationTargets, isDirectSeparationMode, type DirectSeparationMode} from './separation-protocol';

type Notify = (fraction:number|undefined,text:string)=>void;
type Backend = 'webgpu'|'wasm';
type Model = ReturnType<typeof separationModel>;
type Feed = {data:Float32Array;dims:number[];type:string};
type Output = {data:Float32Array;dims:number[]};
// Structural types avoid requiring WebGPU declarations on browsers without WebGPU.
interface AdapterInfo {isFallbackAdapter?:boolean;vendor?:string;architecture?:string;description?:string}
interface HardwareAdapter {info?:AdapterInfo;isFallbackAdapter?:boolean}
interface GpuNavigator {gpu?:{requestAdapter(options:{powerPreference:'high-performance';forceFallbackAdapter:false}):Promise<HardwareAdapter|null>}}

/** All model code and weights are self-hosted; no song bytes leave the Worker. */
async function modelBytes(model:Model,notify:Notify):Promise<Uint8Array>{
  const bundleUrl=import.meta.url,url=new URL('../'+model.path,bundleUrl);
  if(url.origin!==self.location.origin)throw new Error('分離モデルはこのサイト内から読み込む必要があります。');
  const response=await fetch(url,{cache:'force-cache',credentials:'same-origin',redirect:'error'});
  if(!response.ok)throw new Error('分離モデルを取得できませんでした。接続を確認して再実行してください。');
  const declaredLength=response.headers.get('content-length'),encoding=response.headers.get('content-encoding');
  if((!encoding||encoding==='identity')&&declaredLength!==null&&Number(declaredLength)!==model.bytes){
    await response.body?.cancel().catch(()=>{});throw new Error('分離モデルのサイズが一致しません。');
  }
  const bytes=new Uint8Array(model.bytes);let received=0;
  const reader=response.body?.getReader();
  if(reader){
    try{
      while(true){
        const {value,done}=await reader.read();if(done)break;
        if(received+value.length>bytes.length)throw new Error('分離モデルのサイズが一致しません。');
        bytes.set(value,received);received+=value.length;
        notify(.03+.16*received/bytes.length,'AIモデルを準備しています… '+Math.round(received/bytes.length*100)+'%');
      }
    }catch(error){await reader.cancel().catch(()=>{});throw error;}
    finally{reader.releaseLock();}
  }else throw new Error('このブラウザでは分離モデルを安全に読み込めません。最新のPC版ブラウザを使用してください。');
  if(received!==bytes.length)throw new Error('分離モデルのダウンロードが途中で止まりました。');
  const digest=await crypto.subtle.digest('SHA-256',bytes);
  const hash=Array.from(new Uint8Array(digest),value=>value.toString(16).padStart(2,'0')).join('');
  if(hash!==model.sha256)throw new Error('分離モデルの検証に失敗しました。ページを再読み込みして再実行してください。');
  return bytes;
}

async function hardwareAdapter():Promise<HardwareAdapter|undefined>{
  try{
    const adapter=await (navigator as unknown as GpuNavigator).gpu?.requestAdapter({powerPreference:'high-performance',forceFallbackAdapter:false});
    if(!adapter||(adapter.info?.isFallbackAdapter??adapter.isFallbackAdapter)!==false)return;
    const identity=[adapter.info?.vendor,adapter.info?.architecture,adapter.info?.description].filter(Boolean).join(' ');
    if(/swiftshader|llvmpipe|lavapipe|software|basic render/i.test(identity))return;
    return adapter;
  }catch{/* Missing or denied hardware acceleration uses the explicit CPU route. */}
}

function finiteSamples(data:Float32Array){
  for(const value of data)if(!Number.isFinite(value))throw new Error('分離結果に不正なサンプルがあります。');
}
const sameShape=(actual:readonly (string|number)[],expected:readonly number[])=>actual.length===expected.length&&actual.every((value,index)=>value===expected[index]);

export async function createSeparationInference(mode:DirectSeparationMode,notify:Notify){
  if(!isDirectSeparationMode(mode))throw new Error('分離モードが不正です。');
  const model=separationModel(mode),targets=separationTargets(mode);
  const bins=model.n/2+1,inputShape=[1,4,bins,model.frames],outputShape=[1,4*model.learnedTargets.length,bins,model.frames];
  // One pinned entry and matching Asyncify assets serve both providers. No SAB/isolation is required.
  ort.env.wasm.numThreads=1;ort.env.wasm.proxy=false;
  ort.env.wasm.wasmPaths={mjs:wasmModule,wasm:wasmBinary};
  const bytes=await modelBytes(model,notify),used=new Set<Backend>();
  let session:ort.InferenceSession|undefined,provider:Backend='wasm',cpuFallbackUsed=false;
  let disposed=false,pending:Promise<Record<string,AudioData>>|undefined,residualPower=0,inputPower=0;

  async function releaseSession(){const owned=session;session=undefined;if(owned)await owned.release();}
  async function openSession(backend:Backend){
    provider=backend;
    session=await ort.InferenceSession.create(bytes,{
      executionProviders:[backend],graphOptimizationLevel:'all',enableCpuMemArena:false,enableMemPattern:false,
      preferredOutputLocation:'cpu',
    });
    const input=session.inputMetadata[0],output=session.outputMetadata[0];
    if(session.inputNames.length!==1||session.inputNames[0]!=='mix_spec'||session.outputNames.length!==1||session.outputNames[0]!=='stems_spec'||
      !input?.isTensor||input.type!=='float32'||!sameShape(input.shape,inputShape)||
      !output?.isTensor||output.type!=='float32'||!sameShape(output.shape,outputShape))
      throw new Error('分離モデルの入出力形式が一致しません。');
  }
  async function cpuFallback(){
    if(cpuFallbackUsed||disposed)throw new Error('AI分離エンジンを再起動できませんでした。');
    cpuFallbackUsed=true;
    // A failed GPU session is never reused. Partial session-creation cleanup is owned by ORT.
    await releaseSession().catch(()=>{});
    notify(undefined,'GPUでの分離を続けられないためCPUへ切り替えます。処理に時間とメモリが必要です…');
    await openSession('wasm');
  }
  try{
    const adapter=await hardwareAdapter();
    if(adapter){
      ort.env.webgpu.adapter=adapter;
      notify(undefined,'GPUでAI分離エンジンを起動しています…');
      try{await openSession('webgpu');}catch{await cpuFallback();}
    }else{
      cpuFallbackUsed=true;
      notify(undefined,'CPUでAI分離エンジンを起動しています。処理に時間とメモリが必要です…');
      await openSession('wasm');
    }
  }catch(error){await releaseSession().catch(()=>{});throw error;}

  async function runOnce(feeds:Record<string,Feed>):Promise<Record<string,Output>>{
    if(disposed||!session)throw new Error('AI分離エンジンは終了しています。');
    const tensors:Record<string,ort.Tensor>={};let outputs:ort.InferenceSession.ReturnType|undefined;
    try{
      for(const [name,value] of Object.entries(feeds))tensors[name]=new ort.Tensor('float32',value.data,value.dims);
      used.add(provider);outputs=await session.run(tensors);
      const tensor=outputs.stems_spec;
      if(Object.keys(outputs).length!==1||!tensor||tensor.type!=='float32'||!sameShape(tensor.dims,outputShape)||
        !(tensor.data instanceof Float32Array)||tensor.data.length!==outputShape.reduce((product,size)=>product*size,1))
        throw new Error('分離モデルの出力形式が一致しません。');
      if(model.mixtureMasks){
        const data=createMixtureMasks(feeds.mix_spec.data,tensor.data,{channels:2,sources:model.learnedTargets.length,bins,frames:model.frames});
        return {stems_spec:{data,dims:[1,4*targets.length,bins,model.frames]}};
      }
      finiteSamples(tensor.data);
      // ORT's CPU output owns its typed array. Keep that array, then dispose the Tensor wrapper.
      return {stems_spec:{data:tensor.data,dims:Array.from(tensor.dims)}};
    }finally{
      if(outputs)for(const tensor of Object.values(outputs))tensor.dispose();
      for(const tensor of Object.values(tensors))tensor.dispose();
    }
  }
  const adapter={
    inputs:[{name:'mix_spec',dims:inputShape}],outputs:[{name:'stems_spec'}],
    free(){/* The factory owns one session across Core's bounded windows. */},
    async run(feeds:Record<string,Feed>):Promise<Record<string,Output>>{
      const feed=feeds.mix_spec;
      if(Object.keys(feeds).length!==1||!feed||feed.type!=='float32'||!sameShape(feed.dims,inputShape)||
        !(feed.data instanceof Float32Array)||feed.data.length!==inputShape.reduce((product,size)=>product*size,1))
        throw new Error('分離する音声の解析形式が一致しません。');
      finiteSamples(feed.data);
      try{return await runOnce(feeds);}
      catch(error){
        if(provider!=='webgpu'||cpuFallbackUsed||disposed)throw error;
        await cpuFallback();return runOnce(feeds);
      }
    },
  };

  async function inferWindow(audio:AudioData,actualFrames:number):Promise<Record<string,AudioData>>{
    if(!audio||!Number.isInteger(audio.sampleRate)||audio.sampleRate<8000||audio.sampleRate>192000||
      !Array.isArray(audio.channels)||![1,2].includes(audio.channels.length)||
      !Number.isSafeInteger(actualFrames)||actualFrames<0||audio.channels.some(channel=>!(channel instanceof Float32Array)||channel.length!==audio.channels[0].length)||
      actualFrames>audio.channels[0].length||audio.channels[0].length>Math.ceil(audio.sampleRate*model.segmentSeconds))
      throw new Error('分離する音声の長さ・形式が不正です。');
    const length=audio.channels[0].length;
    const channels:Float32Array[]=[audio.channels[0].subarray(0,actualFrames),audio.channels[Math.min(1,audio.channels.length-1)].subarray(0,actualFrames)];
    for(const channel of channels)finiteSamples(channel);
    const result:Record<string,AudioData>=Object.fromEntries(targets.map(target=>[target,{sampleRate:audio.sampleRate,channels:[new Float32Array(length),new Float32Array(length)]}]));
    if(channels.every(channel=>channel.every(sample=>sample===0)))return result;
    const modelTargets=model.mixtureMasks?[...model.learnedTargets,model.residualTarget]:[...model.learnedTargets];
    const separated=await separate({channelData:channels,sampleRate:audio.sampleRate},{
      model:{url:bytes,targets:modelTargets},modelType:'complex',n:model.n,hop:model.hop,window:model.window,normalized:model.normalized,
      segment:model.graphSegment,frames:model.frames,step:1,fade:0,targetRate:model.sampleRate,standardize:model.standardize,session:()=>adapter,
    });
    if(separated.sampleRate!==audio.sampleRate||separated.residual.length!==2||
      separated.residual.some(channel=>channel.length!==actualFrames)||modelTargets.some(target=>
        !Array.isArray(separated.stems[target])||separated.stems[target].length!==2||separated.stems[target].some(channel=>channel.length!==actualFrames)))
      throw new Error('分離結果の長さ・レートが一致しません。');
    let blockInput=0,blockResidual=0;
    for(let channel=0;channel<2;channel++)for(let frame=0;frame<actualFrames;frame++){
      const original=channels[channel][frame],residual=separated.residual[channel][frame];
      if(!Number.isFinite(residual))throw new Error('分離結果に不正なサンプルがあります。');
      blockInput+=original*original;blockResidual+=residual*residual;
      if(mode==='two'){
        const vocal=separated.stems.vocals[channel][frame];result.vocals.channels[channel][frame]=vocal;
        result.instrumental.channels[channel][frame]=original-vocal;
      }else{
        for(const target of targets)result[target].channels[channel][frame]=separated.stems[target][channel][frame]+(target===model.residualTarget?residual:0);
      }
    }
    // Reject broken inference BEFORE folding numerical/SRC remainder into the declared residual target.
    // This is a reconstruction-safety check, not a musical-quality guarantee.
    if(blockInput>1e-12&&blockResidual/blockInput>.75**2)throw new Error('分離結果と原音の差が大きいため、候補を採用しませんでした。');
    for(const target of targets)for(const channel of result[target].channels)finiteSamples(channel);
    inputPower+=blockInput;residualPower+=blockResidual;return result;
  }
  return {
    async infer(audio:AudioData,actualFrames:number):Promise<Record<string,AudioData>>{
      if(disposed)throw new Error('AI分離エンジンは終了しています。');
      if(pending)throw new Error('音源分離は1区間ずつ実行してください。');
      const run=inferWindow(audio,actualFrames);pending=run;
      try{return await run;}finally{pending=undefined;}
    },
    residualRmsRatio:()=>inputPower>0?Math.sqrt(residualPower/inputPower):0,
    // Reports selected execution providers across attempts, not per-operator GPU residency.
    backend:():'webgpu'|'wasm'|'mixed'=>used.size>1?'mixed':used.values().next().value??provider,
    async dispose(){disposed=true;await pending?.catch(()=>{});await releaseSession();},
  };
}
