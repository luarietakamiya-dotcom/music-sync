import type { AudioData } from '@music-sync/shared';
import { createBiquad } from './index.js';
import { peakingCoefficients } from './processing.js';

export interface ReferenceDspPlan {
  bands: { frequencyHz:number;gainDb:number;q:number }[];
  density?: { maxReductionDb:number;thresholdDbfs:number;ratio:number;attackMs:number;releaseMs:number };
}
export type ReferenceStreamProcessor=((owned:AudioData)=>void)&{reductionDb():number};
const bounded=(n:number,min:number,max:number)=>{if(!Number.isFinite(n)||n<min||n>max)throw new Error('リファレンス補正のDSP設定が不正です。');};

/** Continuous, linked stereo processing of caller-owned chunks. No PCM is retained. */
export function createReferenceProcessor(plan:ReferenceDspPlan,sampleRate:number,channels:number):ReferenceStreamProcessor {
  bounded(sampleRate,24000,192000);
  if(!Number.isInteger(sampleRate)||![1,2].includes(channels)||!plan||!Array.isArray(plan.bands)||plan.bands.length>3)
    throw new Error('リファレンス補正の形式が不正です。');
  let sum=0;
  const coefficients=plan.bands.map(b=>{
    bounded(b.frequencyHz,40,Math.min(10000,sampleRate*.4));bounded(b.gainDb,-1.5,1.5);bounded(b.q,.45,1.2);sum+=Math.abs(b.gainDb);
    return peakingCoefficients(sampleRate,b.frequencyHz,b.gainDb,b.q);
  });
  if(sum>4.000001)throw new Error('リファレンスの帯域補正量が大きすぎます。');
  const filters=Array.from({length:channels},()=>coefficients.map(c=>createBiquad(c)));
  const density=plan.density?{...plan.density}:undefined;
  if(density){
    bounded(density.maxReductionDb,0,.8);bounded(density.thresholdDbfs,-80,0);bounded(density.ratio,1,1.5);
    bounded(density.attackMs,10,40);bounded(density.releaseMs,80,250);
  }
  let level=0,gainDb=0,maximum=0;
  const attack=1-Math.exp(-1/(sampleRate*(density?.attackMs??20)/1000));
  const release=1-Math.exp(-1/(sampleRate*(density?.releaseMs??120)/1000));
  const process=(owned:AudioData)=>{
    const frames=owned?.channels?.[0]?.length??0;
    if(owned.sampleRate!==sampleRate||owned.channels.length!==channels||!frames||owned.channels.some(c=>!(c instanceof Float32Array)||c.length!==frames))
      throw new Error('リファレンス補正の連続チャンクが不正です。');
    // Validate before mutating an owned block, avoiding partial writes on malformed PCM.
    for(const channel of owned.channels)for(const value of channel)if(!Number.isFinite(value)||Math.abs(value)>32)throw new Error('音声に不正な値があります。');
    for(let i=0;i<frames;i++){
      let peak=0;
      for(let c=0;c<channels;c++){
        let value=owned.channels[c][i];for(const filter of filters[c])value=filter(value);
        owned.channels[c][i]=value;peak=Math.max(peak,Math.abs(value));
      }
      if(density){
        level+=(peak>level?attack:release)*(peak-level);
        const over=Math.max(0,20*Math.log10(Math.max(level,1e-12))-density.thresholdDbfs);
        const target=-Math.min(density.maxReductionDb,over*(1-1/density.ratio));
        gainDb+=(target<gainDb?attack:release)*(target-gainDb);maximum=Math.max(maximum,-gainDb);
        const gain=10**(gainDb/20);for(const channel of owned.channels)channel[i]*=gain;
      }
    }
  };
  return Object.assign(process,{reductionDb:()=>maximum});
}
