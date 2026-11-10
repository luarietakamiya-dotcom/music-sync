import type {AnalysisResult} from '@music-sync/shared';

export const BATCH_LOUDNESS_LIMITS=Object.freeze({maxTracks:20,maxBoostLu:3,minUsableLufs:-60,minCommonLufs:-40});
export interface BatchLoudnessInput {id:string;analysis:AnalysisResult}
export interface BatchLoudnessOptions {targetLufs?:number;ceilingDb?:number}
export interface BatchLoudnessTrackPlan {
  id:string;status:'ready'|'unavailable';beforeLufs:number|null;targetLufs:number|null;gainDb:number|null;
  expectedLufs:number|null;expectedTruePeakDbtp:number|null;reason:string|null;
}
export interface BatchLoudnessPlan {
  version:1;requestedTargetLufs:number;commonTargetLufs:number|null;ceilingDb:number;maxBoostLu:3;
  tracks:BatchLoudnessTrackPlan[];notes:string[];
}
const numeric=(value:unknown,min:number,max:number):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>=min&&value<=max;
function unavailable(analysis:AnalysisResult):string|null {
  if(!analysis||analysis.schemaVersion!==1||!Number.isInteger(analysis.sampleRate)||!numeric(analysis.sampleRate,8000,192000)||
    ![1,2].includes(analysis.channels)||!Number.isSafeInteger(analysis.frames)||!numeric(analysis.frames,1,analysis.sampleRate*1200)||
    !numeric(analysis.durationSeconds,0,1200)||Math.abs(analysis.durationSeconds-analysis.frames/analysis.sampleRate)>1e-6||
    !Number.isSafeInteger(analysis.clippedSamples)||!numeric(analysis.clippedSamples,0,analysis.frames*analysis.channels)||
    !Array.isArray(analysis.dcOffset)||analysis.dcOffset.length!==analysis.channels||analysis.dcOffset.some(value=>!numeric(value,-32,32)))
    return '解析結果の形式が不正なため、この曲をそろえる対象から外しました。';
  if(analysis.clippedSamples>0)return 'クリッピングがあるため、この曲を自動調整の対象から外しました。';
  if(analysis.integratedLufs===null||analysis.rmsDbfs===null||analysis.truePeakDbtp===null||analysis.samplePeakDbfs===null||analysis.crestFactorDb===null)
    return '無音や短い音源など、比較に必要な音量を測定できません。';
  if(!numeric(analysis.integratedLufs,-1000,100)||!numeric(analysis.rmsDbfs,-1000,100)||!numeric(analysis.truePeakDbtp,-1000,100)||
    !numeric(analysis.samplePeakDbfs,-1000,100)||!numeric(analysis.crestFactorDb,0,1000))return '解析値が不正なため、この曲をそろえる対象から外しました。';
  if(analysis.integratedLufs<BATCH_LOUDNESS_LIMITS.minUsableLufs)return '音量が極端に小さいため、素材を確認してください。この曲は一括調整から外しました。';
  return null;
}

/** Gain-only album consistency: the quietest safe ceiling limits every accepted song.
 * Measurements guide the level; they do not establish perceptual or artistic equivalence.
 */
export function planBatchLoudness(inputs:readonly BatchLoudnessInput[],options:BatchLoudnessOptions={}):BatchLoudnessPlan {
  if(!Array.isArray(inputs)||inputs.length>BATCH_LOUDNESS_LIMITS.maxTracks)throw new Error('一括仕上げは20曲までです。');
  const target=options.targetLufs??-16,ceiling=options.ceilingDb??-1;
  if(!numeric(target,-40,-9)||!numeric(ceiling,-6,-1))throw new Error('一括調整の音量またはピーク上限が対応範囲外です。');
  const ids=new Set<string>();
  const viable:{index:number;analysis:AnalysisResult;peak:number;maximum:number}[]=[];
  const tracks=inputs.map((input,index):BatchLoudnessTrackPlan=>{
    if(!input||typeof input.id!=='string'||!input.id||input.id.length>128||input.id.includes('\0')||ids.has(input.id))throw new Error('一括調整の曲IDが不正または重複しています。');
    ids.add(input.id);
    const analysis=input.analysis,reason=unavailable(analysis);
    const result:BatchLoudnessTrackPlan={id:input.id,status:'unavailable',beforeLufs:typeof analysis?.integratedLufs==='number'&&Number.isFinite(analysis.integratedLufs)?analysis.integratedLufs:null,
      targetLufs:null,gainDb:null,expectedLufs:null,expectedTruePeakDbtp:null,reason};
    if(reason)return result;
    const peak=Math.max(analysis.truePeakDbtp!,analysis.samplePeakDbfs!),maximum=analysis.integratedLufs!+Math.min(BATCH_LOUDNESS_LIMITS.maxBoostLu,ceiling-peak);
    if(maximum<BATCH_LOUDNESS_LIMITS.minCommonLufs){result.reason='ピークを保ったまま一括調整の最低音量へ届かないため、この曲は対象から外しました。';return result;}
    viable.push({index,analysis,peak,maximum});return result;
  });
  const common=viable.length?Math.min(target,...viable.map(item=>item.maximum)):null;
  for(const item of viable){
    const before=item.analysis.integratedLufs!,gain=Math.min(BATCH_LOUDNESS_LIMITS.maxBoostLu,ceiling-item.peak,common!-before);
    tracks[item.index]={id:tracks[item.index].id,status:'ready',beforeLufs:before,targetLufs:common,gainDb:Object.is(gain,-0)?0:gain,
      expectedLufs:before+gain,expectedTruePeakDbtp:item.analysis.truePeakDbtp!+gain,reason:null};
  }
  return {version:1,requestedTargetLufs:target,commonTargetLufs:common,ceilingDb:ceiling,maxBoostLu:3,tracks,
    notes:['音量調整は曲全体のゲインだけで行います。音量をそろえるための追加圧縮・リミッターは使いません。',
      'LUFS・推定True Peakによる音量の目安です。聴感や音質が同じになることを保証しません。',
      ...(common!==null&&common<target-0.01?['曲のピークと強弱を保つため、共通の音量を目標より低くしました。']:[])]};
}
