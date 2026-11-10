import type { AudioData } from '@music-sync/shared';
import { createBiquad } from './index.js';

export interface DynamicEqBand { frequencyHz:number; q:number; thresholdDb:number; maxReductionDb:number; attackMs:number; releaseMs:number }
export interface MultibandParameters { lowHz:number; highHz:number; bands: readonly { thresholdDb:number; maxReductionDb:number }[]; attackMs:number; releaseMs:number }
const range=(x:number,min:number,max:number)=>{if(!Number.isFinite(x)||x<min||x>max)throw new Error('Invalid band dynamics parameter');};
function envelopeParameters(sr:number,attack:number,release:number) {
  range(attack,2,100);range(release,30,500);
  return [1-Math.exp(-1/(sr*attack/1000)),1-Math.exp(-1/(sr*release/1000))];
}
/** Bell-shaped parallel band attenuation with a stereo-linked RMS sidechain.
 * Reduction only; caller must pass an owned buffer. */
export function applyDynamicEqToOwned(audio:AudioData,bands:readonly DynamicEqBand[]):void {
  if(!bands.length||bands.length>3)throw new Error('Dynamic EQ supports 1–3 bands');
  for(const band of bands){
    range(band.frequencyHz,30,audio.sampleRate*0.4);range(band.q,0.5,3);range(band.thresholdDb,-90,0);range(band.maxReductionDb,0,2);
    const [attack,release]=envelopeParameters(audio.sampleRate,band.attackMs,band.releaseMs);
    if(band.maxReductionDb===0)continue;
    const w=2*Math.PI*band.frequencyHz/audio.sampleRate,alpha=Math.sin(w)/(2*band.q),a0=1+alpha;
    const filters=audio.channels.map(()=>createBiquad([alpha/a0,0,-alpha/a0,-2*Math.cos(w)/a0,(1-alpha)/a0]));
    const values=new Float64Array(audio.channels.length);let power=0,reduction=0;
    for(let i=0;i<audio.channels[0].length;i++){
      let instant=0;
      for(let c=0;c<audio.channels.length;c++){const x=filters[c](audio.channels[c][i]);values[c]=x;instant=Math.max(instant,x*x);}
      power+=(instant>power?attack:release)*(instant-power);
      const over=Math.max(0,10*Math.log10(Math.max(1e-12,power))-band.thresholdDb),target=Math.min(band.maxReductionDb,over*0.5);
      reduction+=(target>reduction?attack:release)*(target-reduction);
      const gain=10**(-reduction/20)-1;
      for(let c=0;c<audio.channels.length;c++)audio.channels[c][i]+=values[c]*gain;
    }
  }
}
/** Complementary first-order splits: low + (upper-low) + (dry-upper) = dry.
 * Linked attenuation avoids phase mismatch between channel sidechains. */
export function applyMultibandToOwned(audio:AudioData,params:MultibandParameters):void {
  range(params.lowHz,100,300);range(params.highHz,1500,Math.min(6000,audio.sampleRate*0.4));
  if(params.bands.length!==3)throw new Error('Multiband requires low/mid/high');
  for(const band of params.bands){range(band.thresholdDb,-90,0);range(band.maxReductionDb,0,1.5);}
  const [attack,release]=envelopeParameters(audio.sampleRate,params.attackMs,params.releaseMs);
  if(params.bands.every(b=>b.maxReductionDb===0))return;
  const low=new Float64Array(audio.channels.length),upper=low.slice(),parts=new Float64Array(audio.channels.length*3);
  const powers=new Float64Array(3),reduction=powers.slice(),gains=powers.slice();
  const lc=1-Math.exp(-2*Math.PI*params.lowHz/audio.sampleRate),hc=1-Math.exp(-2*Math.PI*params.highHz/audio.sampleRate);
  for(let i=0;i<audio.channels[0].length;i++){
    for(let c=0;c<audio.channels.length;c++){
      const x=audio.channels[c][i];low[c]+=lc*(x-low[c]);upper[c]+=hc*(x-upper[c]);
      parts[c*3]=low[c];parts[c*3+1]=upper[c]-low[c];parts[c*3+2]=x-upper[c];
    }
    for(let b=0;b<3;b++){
      let instant=0;for(let c=0;c<audio.channels.length;c++)instant=Math.max(instant,parts[c*3+b]**2);
      powers[b]+=(instant>powers[b]?attack:release)*(instant-powers[b]);
      const target=Math.min(params.bands[b].maxReductionDb,Math.max(0,10*Math.log10(Math.max(1e-12,powers[b]))-params.bands[b].thresholdDb)*0.4);
      reduction[b]+=(target>reduction[b]?attack:release)*(target-reduction[b]);gains[b]=10**(-reduction[b]/20);
    }
    for(let c=0;c<audio.channels.length;c++){
      // Add only the changed contribution so completely inactive processing is bit-exact.
      let delta=0;for(let b=0;b<3;b++)delta+=parts[c*3+b]*(gains[b]-1);audio.channels[c][i]+=delta;
    }
  }
}
