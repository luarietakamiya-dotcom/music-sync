import type { AudioData } from '@music-sync/shared';

/** Original deterministic multitone arrangements, no third-party recordings.
 * Spectral/temporal counterexamples, not a substitute for licensed music listening. */
export const fixtureNames = ['balanced','bass-heavy','muddy','harsh','bright','dull','narrow','excessive-stereo','transient-heavy','overcompressed','wet','intermittent-harsh','low-bursts'] as const;
export type FixtureName = typeof fixtureNames[number];
export const fixtureExpectations = {
  balanced:'No corrective EQ or multiband', 'bass-heavy':'lowEndBuildup', muddy:'muddiness', harsh:'harshness',bright:'brightness',dull:'dullness',
  narrow:'Low side energy; no automatic widening', 'excessive-stereo':'phaseRisk / lowSpread', 'transient-heavy':'High punch; no attack boost',
  overcompressed:'Higher dynamic density than transient-heavy',wet:'Wet tendency; reduced LIVE addition',
  'intermittent-harsh':'Temporal band contrast; Dynamic EQ', 'low-bursts':'Low band range greater than mid; selective dynamics',
} satisfies Record<FixtureName,string>;
export function perceptualFixture(name:FixtureName,seconds=4):AudioData{
  const sampleRate=24000,frames=Math.round(sampleRate*seconds),channels=[new Float32Array(frames),new Float32Array(frames)];
  const profiles:Partial<Record<FixtureName,number[]>>={
    'bass-heavy':[0.2,0.64,0.04,0.03,0.03,0.025,0.02,0.015],muddy:[0.03,0.05,0.72,0.06,0.06,0.04,0.025,0.015],
    harsh:[0.03,0.05,0.04,0.06,0.18,0.58,0.04,0.02],bright:[0.01,0.04,0.04,0.05,0.06,0.08,0.6,0.12],
    dull:[0.07,0.13,0.16,0.42,0.21,0.009,0.0008,0.0002],
  };
  const weights=profiles[name]??[0.06,0.18,0.14,0.17,0.18,0.13,0.10,0.04],frequencies=[40,110,280,650,1600,3300,7000,11000];
  for(let i=0;i<frames;i++){
    const t=i/sampleRate,beat=t%0.5;
    let envelope=0.7+0.1*Math.sin(2*Math.PI*t*0.7);
    if(name==='transient-heavy')envelope=Math.exp(-beat*45);
    if(name==='wet')envelope=0.15+0.85*Math.exp(-beat*4);
    if(name==='overcompressed')envelope=1;
    let mid=0,side=0;
    for(let b=0;b<8;b++){
      let amplitude=Math.sqrt(weights[b])*0.13;
      if(name==='intermittent-harsh'&&b===5&&t%2>1.35)amplitude*=5;
      if(name==='low-bursts'&&b===1)amplitude*=t%2>1.35?5:0.15;
      mid+=amplitude*Math.sin(2*Math.PI*frequencies[b]*t+b*0.47);
      side+=amplitude*Math.sin(2*Math.PI*(frequencies[b]+7)*t+b*0.73);
    }
    const width=name==='narrow'?0:name==='excessive-stereo'?2:name==='wet'?0.9:0.15;
    channels[0][i]=envelope*(mid+side*width);channels[1][i]=envelope*(mid-side*width);
    if(name==='overcompressed'){channels[0][i]=0.2*Math.tanh(channels[0][i]*12);channels[1][i]=0.2*Math.tanh(channels[1][i]*12);}
  }
  return {sampleRate,channels};
}
