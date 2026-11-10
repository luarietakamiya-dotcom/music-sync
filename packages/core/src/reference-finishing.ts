import {analyzeAudio,analyzeAdaptiveFeatures,analyzePerceptualFeatures,type AdaptiveFeatures,type PerceptualFeatures} from '@music-sync/audio-analysis';
import {createReferenceProcessor,defaultProcessingChain,processAudio,type ProcessingResult,type ReferenceDspPlan} from '@music-sync/dsp';
import {validateAudio,type AnalysisResult,type AudioData} from '@music-sync/shared';
import {evaluateAutoQuality} from './auto/quality-evaluator.js';
import type {AutoMode} from './auto/mix-planner.js';

export const REFERENCE_BANDS=['bass','warmth','body','presence','treble'] as const;
export type ReferenceBand=typeof REFERENCE_BANDS[number];
export interface ReferenceProfile {
  version:1;algorithmVersion:'1';frequencyCeilingHz:10000;sampleRate:number;durationSeconds:number;confidence:number;
  shares:Record<ReferenceBand,number>;crestFactorDb:number;dynamicDensity:number;bandRangeDb:number;
}
export interface ReferenceSelection {profile:ReferenceProfile;strength:number}
export interface ReferencePlan extends ReferenceDspPlan {
  strength:number;confidence:number;distanceBefore:number;explanations:string[];skipped:string[];
}
export interface ReferenceAttempt {
  iteration:number;plan:ReferencePlan;after:AnalysisResult;reductionDb:number;distanceBefore:number;distanceAfter:number;reasons:string[];
}
export interface ReferenceResult {
  version:1;status:'accepted'|'rejected'|'skipped';selection:ReferenceSelection;before:AnalysisResult;
  attempts:ReferenceAttempt[];explanations:string[];reasons:string[];processed?:ProcessingResult;
}
export interface ReferenceOptions {
  maxIterations?:number;signal?:AbortSignal;onProgress?:(fraction:number)=>void;targetLufs?:number;ceilingDb?:number;
  originalAnalysis?:AnalysisResult;originalFeatures?:AdaptiveFeatures;mode?:AutoMode;reductionDb?:number;
}
const clamp=(n:number,min:number,max:number)=>Math.max(min,Math.min(max,n));
function shares(features:PerceptualFeatures):Record<ReferenceBand,number>{
  const b=features.bands,values={bass:b.sub.mean+b.low.mean,warmth:b.lowMid.mean,body:b.mid.mean,presence:b.upperMid.mean+b.presence.mean,treble:b.high.mean};
  const total=Object.values(values).reduce((sum,n)=>sum+n,0);
  if(!Number.isFinite(total)||total<.1||Object.values(values).some(n=>!Number.isFinite(n)||n<0))throw new Error('比較に使える周波数成分を測定できません。');
  return Object.fromEntries(REFERENCE_BANDS.map(key=>[key,values[key]/total])) as Record<ReferenceBand,number>;
}
function bandRange(features:PerceptualFeatures):number{
  return Object.values(features.bands).reduce((sum,b)=>sum+b.mean*b.rangeDb,0);
}
function measurementsUsable(analysis:AnalysisResult,features:PerceptualFeatures):boolean{
  return analysis.sampleRate>=24000&&analysis.durationSeconds>=2&&analysis.integratedLufs!==null&&analysis.rmsDbfs!==null&&
    analysis.crestFactorDb!==null&&Number.isFinite(analysis.crestFactorDb)&&analysis.clippedSamples===0&&features.confidence>=.5&&features.windows>=20;
}

/** Gain-normalized common bands exclude 10k–Nyquist so 44.1/48/96k measurements remain comparable. No LUFS target is copied. */
export function profileFromMeasurements(analysis:AnalysisResult,features:PerceptualFeatures):ReferenceProfile{
  if(!measurementsUsable(analysis,features))throw new Error('リファレンスは24 kHz以上、2秒以上の音楽を選んでください。無音・クリッピング・解析の確かさが低い素材は使えません。');
  const profile:ReferenceProfile={version:1,algorithmVersion:'1',frequencyCeilingHz:10000,sampleRate:analysis.sampleRate,durationSeconds:analysis.durationSeconds,
    confidence:features.confidence,shares:shares(features),crestFactorDb:analysis.crestFactorDb!,dynamicDensity:features.features.dynamicDensity.value,bandRangeDb:bandRange(features)};
  validateReferenceProfile(profile);return profile;
}
export function analyzeReference(audio:AudioData):ReferenceProfile{
  validateAudio(audio);return profileFromMeasurements(analyzeAudio(audio),analyzePerceptualFeatures(audio));
}
export function validateReferenceProfile(profile:ReferenceProfile):void{
  if(!profile||profile.version!==1||profile.algorithmVersion!=='1'||profile.frequencyCeilingHz!==10000||
    !Number.isInteger(profile.sampleRate)||profile.sampleRate<24000||profile.sampleRate>192000||!Number.isFinite(profile.durationSeconds)||profile.durationSeconds<2||profile.durationSeconds>1200||
    !Number.isFinite(profile.confidence)||profile.confidence<.5||profile.confidence>1||!profile.shares||
    REFERENCE_BANDS.some(key=>!Number.isFinite(profile.shares[key])||profile.shares[key]<0||profile.shares[key]>1)||
    Math.abs(REFERENCE_BANDS.reduce((sum,key)=>sum+profile.shares[key],0)-1)>.00001||
    !Number.isFinite(profile.crestFactorDb)||profile.crestFactorDb<0||profile.crestFactorDb>80||
    !Number.isFinite(profile.dynamicDensity)||profile.dynamicDensity<0||profile.dynamicDensity>1||
    !Number.isFinite(profile.bandRangeDb)||profile.bandRangeDb<0||profile.bandRangeDb>120)throw new Error('リファレンス解析データが不正です。');
}
export function validateReferenceSelection(selection:ReferenceSelection):void{
  if(!selection||!Number.isFinite(selection.strength)||selection.strength<0||selection.strength>1)throw new Error('リファレンスの適用量が不正です。');
  validateReferenceProfile(selection.profile);
}
export function referenceDistance(features:PerceptualFeatures,profile:ReferenceProfile):number{
  validateReferenceProfile(profile);const source=shares(features);
  const tone=REFERENCE_BANDS.reduce((sum,key)=>sum+clamp(10*Math.log10((source[key]+.005)/(profile.shares[key]+.005)),-12,12)**2,0)/REFERENCE_BANDS.length;
  return Math.sqrt(tone)+.12*Math.min(12,Math.abs(features.crestDb-profile.crestFactorDb));
}

/** Analysis selects small corrections; existing matches and missing bands never trigger obligatory DSP. */
export function planReferenceCorrection(before:AnalysisResult,features:PerceptualFeatures,profile:ReferenceProfile,strength=.65,options:{compressionBudgetDb?:number}={}):ReferencePlan{
  validateReferenceSelection({profile,strength});
  const plan:ReferencePlan={bands:[],strength,confidence:Math.min(features.confidence,profile.confidence),distanceBefore:0,explanations:[],skipped:[]};
  if(!measurementsUsable(before,features)){plan.skipped.push('比較に使える帯域と確かさが不足しているため、リファレンス補正を見送りました。');return plan;}
  plan.distanceBefore=referenceDistance(features,profile);
  if(!strength){plan.skipped.push('リファレンスの適用量が0のため、追加の加工は行いませんでした。');return plan;}
  const source=shares(features),frequency={bass:100,warmth:280,body:700,presence:2200,treble:6500};
  const labels={bass:'低音の厚み',warmth:'低中域の暖かさ',body:'中域のバランス',presence:'輪郭と存在感',treble:'高域の明るさ'};
  const differences=REFERENCE_BANDS.map(key=>({key,delta:10*Math.log10((profile.shares[key]+.005)/(source[key]+.005))}));
  const priority=({key,delta}:{key:ReferenceBand;delta:number})=>Math.abs(delta)*(delta<0?1.3:1)*(key==='bass'||key==='treble'?1.2:1);
  const selected=differences.filter(({key,delta})=>Math.abs(delta)>1&&source[key]>.005&&profile.shares[key]>.005).sort((a,b)=>priority(b)-priority(a)).slice(0,3);
  for(const {key,delta} of selected){
    const gainDb=clamp(delta*.6*strength,-1.5,1.5);
    if(Math.abs(gainDb)<.2)continue;
    plan.bands.push({frequencyHz:frequency[key],gainDb,q:.7});
    plan.explanations.push(`${labels[key]}を、お手本の傾向へ控えめに${gainDb>0?'近づけました':'整理しました'}。`);
  }
  const sum=plan.bands.reduce((n,b)=>n+Math.abs(b.gainDb),0);if(sum>4)for(const band of plan.bands)band.gainDb*=4/sum;
  const densityGap=before.crestFactorDb!-profile.crestFactorDb,budget=options.compressionBudgetDb??.8;
  if(!Number.isFinite(budget)||budget<0||budget>3)throw new Error('リファレンスの圧縮上限が不正です。');
  if(densityGap>2&&before.crestFactorDb!>=9&&bandRange(features)>=3&&(before.truePeakDbtp??0)<-1.25&&budget>.05){
    const maxReductionDb=Math.min(.8,budget,(densityGap-1.5)*.2*strength);
    if(maxReductionDb>.1){plan.density={maxReductionDb,thresholdDbfs:Math.max(-80,Math.min(0,before.rmsDbfs!+3)),ratio:1.35,attackMs:20,releaseMs:140};
      plan.explanations.push('強弱の余裕を確認し、お手本の密度へ向けて軽く整えました。');}
  }else if(densityGap>2)plan.skipped.push('強弱とピークの余裕を優先し、密度を上げる追加圧縮は行いませんでした。');
  if(!plan.bands.length&&!plan.density)plan.skipped.push('測定上はお手本に近いか、安全に変えられる差が小さいため、追加の加工は行いませんでした。');
  return plan;
}

export function evaluateReferenceQuality(before:AnalysisResult,after:AnalysisResult,beforeFeatures:PerceptualFeatures,afterFeatures:PerceptualFeatures,profile:ReferenceProfile,
  options:{ceilingDb?:number;requestedLufs?:number;reductionDb?:number}={}):{accepted:boolean;reasons:string[];distanceBefore:number;distanceAfter:number}{
  const reasons:string[]=[],ceiling=options.ceilingDb??-1,distanceBefore=referenceDistance(beforeFeatures,profile),distanceAfter=referenceDistance(afterFeatures,profile);
  if(!Number.isFinite(distanceAfter)||distanceBefore-distanceAfter<.005)reasons.push('お手本への測定上の接近を確認できませんでした。');
  if(after.sampleRate!==before.sampleRate||after.channels!==before.channels||after.frames!==before.frames)reasons.push('音源の長さ・形式が変化しました。');
  if(after.integratedLufs===null||after.rmsDbfs===null||after.truePeakDbtp===null||![after.integratedLufs,after.rmsDbfs,after.truePeakDbtp].every(Number.isFinite))reasons.push('処理後の音量を測定できません。');
  if(after.clippedSamples||(after.truePeakDbtp??Infinity)>ceiling+.0001)reasons.push('ピーク保護条件を満たしません。');
  if((options.reductionDb??0)>3)reasons.push('全体の圧縮量が安全範囲を超えました。');
  if(before.crestFactorDb!==null&&after.crestFactorDb!==null&&before.crestFactorDb-after.crestFactorDb>1.2)reasons.push('強弱を抑えすぎています。');
  if(after.dcOffset.length!==after.channels||after.dcOffset.some((x,i)=>!Number.isFinite(x)||Math.abs(x)>Math.max(.003,Math.abs(before.dcOffset[i])+.001)))reasons.push('DCオフセットが悪化しました。');
  if(before.stereoCorrelation!==null&&(after.stereoCorrelation===null||after.stereoCorrelation<before.stereoCorrelation-.06))reasons.push('ステレオの安定性が下がりました。');
  if(Math.abs((after.sideEnergyPercent??0)-(before.sideEnergyPercent??0))>4)reasons.push('ステレオの広がりが変わりすぎました。');
  const target=options.requestedLufs??before.integratedLufs;
  if(target!==null&&target!==undefined&&after.integratedLufs!==null&&Math.abs(after.integratedLufs-target)>Math.max(.6,Math.abs((before.integratedLufs??target)-target)+.15))
    reasons.push('選んだ出力音量から離れすぎました。');
  const highBefore=beforeFeatures.bands.upperMid.mean+beforeFeatures.bands.presence.mean,highAfter=afterFeatures.bands.upperMid.mean+afterFeatures.bands.presence.mean;
  if(afterFeatures.features.harshness.value>beforeFeatures.features.harshness.value+.08||highAfter>highBefore+.055)reasons.push('高域の偏りまたは刺さりが増えました。');
  if(afterFeatures.features.lowEndBuildup.value>beforeFeatures.features.lowEndBuildup.value+.08)reasons.push('低域の濁りが増えました。');
  return {accepted:!reasons.length,reasons,distanceBefore,distanceAfter};
}

/** Final optional stage. Bounded retries always restart from the accepted base candidate. */
export function applyReferenceFinishing(input:AudioData,selection:ReferenceSelection,options:ReferenceOptions={}):ReferenceResult{
  validateReferenceSelection(selection);const count=options.maxIterations??3,ceiling=options.ceilingDb??-1,reduction=options.reductionDb??0;
  if(!Number.isInteger(count)||count<1||count>3||!Number.isFinite(ceiling)||ceiling< -12||ceiling> -1||!Number.isFinite(reduction)||reduction<0||reduction>12||
    (options.targetLufs!==undefined&&(!Number.isFinite(options.targetLufs)||options.targetLufs< -30||options.targetLufs> -6)))throw new Error('リファレンス仕上げの設定が不正です。');
  const progress=(f:number)=>{if(options.signal?.aborted)throw new Error('Processing cancelled');options.onProgress?.(f);if(options.signal?.aborted)throw new Error('Processing cancelled');};
  progress(0);validateAudio(input);
  if(input.channels.reduce((n,c)=>n+c.byteLength,0)>96*1024**2)throw new Error('リファレンス仕上げは展開後96 MiBまでです。');
  const before=analyzeAudio(input),features=analyzePerceptualFeatures(input),adaptive=analyzeAdaptiveFeatures(input);
  const result:ReferenceResult={version:1,status:'rejected',selection:structuredClone(selection),before,attempts:[],explanations:[],reasons:[]};
  const requestedLufs=options.targetLufs??before.integratedLufs??-16;
  if(!measurementsUsable(before,features)){result.status='skipped';result.explanations=['比較に使える帯域と確かさが不足しているため、リファレンス補正を見送りました。'];progress(1);return result;}
  for(let i=0;i<count;i++){
    progress(.05+i*.3);
    const plan=planReferenceCorrection(before,features,selection.profile,selection.strength*[1,.5,.25][i],{compressionBudgetDb:Math.max(0,Math.min(.8,3-reduction))});
    if(!plan.bands.length&&!plan.density){
      result.status=result.attempts.length?'rejected':'skipped';
      result.explanations=result.attempts.length?['補正量を弱めると有効な変更が残らなかったため、お手本への補正は採用せず元の候補を保ちました。']:plan.skipped;
      progress(1);return result;
    }
    const audio={sampleRate:input.sampleRate,channels:input.channels.map(c=>c.slice())},processor=createReferenceProcessor(plan,input.sampleRate,input.channels.length);
    for(let offset=0;offset<audio.channels[0].length;offset+=65536){progress(.08+i*.3);processor({sampleRate:audio.sampleRate,channels:audio.channels.map(c=>c.subarray(offset,offset+65536))});}
    const intermediate=analyzeAudio(audio),chain=defaultProcessingChain();chain.limiter.ceilingDb=ceiling;
    const headroom=ceiling-Math.max(intermediate.truePeakDbtp??Infinity,intermediate.samplePeakDbfs??Infinity),budget=Math.max(0,3-reduction-processor.reductionDb());
    chain.gainDb=Math.max(-24,Math.min(6,requestedLufs-(intermediate.integratedLufs??requestedLufs),headroom+Math.min(.4,budget)));
    if(Math.abs(chain.gainDb)<.02&&headroom>=0){chain.gainDb=0;chain.bypass=true;}
    const processed=processAudio(audio,chain,()=>{if(options.signal?.aborted)throw new Error('Processing cancelled');});progress(.22+i*.3);
    const after=analyzeAudio(processed.audio),afterPerceptual=analyzePerceptualFeatures(processed.audio),afterAdaptive=analyzeAdaptiveFeatures(processed.audio);
    const reductionDb=reduction+processor.reductionDb()+processed.maxReductionDb-processed.peakGuardDb;
    const evaluation=evaluateReferenceQuality(before,after,features,afterPerceptual,selection.profile,{ceilingDb:ceiling,requestedLufs,reductionDb});
    const whole=evaluateAutoQuality(options.originalAnalysis??before,after,options.originalFeatures??adaptive,afterAdaptive,options.mode??'AUTO',reductionDb);
    const reasons=[...new Set([...evaluation.reasons,...whole.reasons])];result.attempts.push({iteration:i+1,plan,after,reductionDb,distanceBefore:evaluation.distanceBefore,distanceAfter:evaluation.distanceAfter,reasons});result.reasons=reasons;
    if(!reasons.length){result.status='accepted';result.processed=processed;result.explanations=[...plan.explanations,...plan.skipped,...(i?['測定条件に合わせ、お手本への補正量を弱めました。']:[])];progress(1);return result;}
  }
  result.explanations=['お手本への補正候補は採用せず、安全に仕上がった元の候補を保ちました。'];progress(1);return result;
}
