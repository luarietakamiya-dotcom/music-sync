import {describe,expect,it} from 'vitest';
import {analyzeAudio,analyzePerceptualFeatures,analyzeAdaptiveFeatures} from '@music-sync/audio-analysis';
import type {AudioData} from '@music-sync/shared';
import {analyzeReference,profileFromMeasurements,validateReferenceSelection,planReferenceCorrection,applyReferenceFinishing,evaluateReferenceQuality,type ReferenceProfile} from '../../packages/core/src/reference-finishing';
import {createReferenceProcessor} from '../../packages/dsp/src/reference-stream';
import {autoMixMaster} from '../../packages/core/src/auto/engine';
import {perceptualFixture} from '../fixtures/perceptual';

const select=(profile:ReferenceProfile,strength=.65)=>({profile,strength});
const measures=(audio:AudioData)=>({analysis:analyzeAudio(audio),features:analyzePerceptualFeatures(audio)});
function arrangement(sampleRate:number):AudioData{
  const hz=[50,110,280,700,1700,3600,7000],channels=[new Float32Array(sampleRate*3)];
  for(let n=0;n<channels[0].length;n++){
    const time=n/sampleRate,envelope=.6+.2*Math.sin(2*Math.PI*.7*time);
    channels[0][n]=hz.reduce((sum,f,c)=>sum+.035*Math.sin(2*Math.PI*f*time+c*.37),0)*envelope;
  }
  return {sampleRate,channels};
}

describe('reference-guided selective finishing',()=>{
  it('makes JSON gain-invariant profiles without copying a loudness target',()=>{
    const audio=arrangement(44100),quiet={sampleRate:audio.sampleRate,channels:audio.channels.map(ch=>Float32Array.from(ch,x=>x*.25))};
    const a=analyzeReference(audio),b=analyzeReference(quiet);
    for(const key of Object.keys(a.shares) as (keyof typeof a.shares)[])expect(a.shares[key]).toBeCloseTo(b.shares[key],6);
    expect(a.crestFactorDb).toBeCloseTo(b.crestFactorDb,6);expect(a.dynamicDensity).toBeCloseTo(b.dynamicDensity,6);
    expect(JSON.parse(JSON.stringify(a))).toEqual(a);expect(a).not.toHaveProperty('integratedLufs');
    expect(Object.values(a.shares).reduce((n,x)=>n+x,0)).toBeCloseTo(1,8);
  });
  it('uses common frequency bands for compatible 44.1 and 48kHz sources',()=>{
    const a=analyzeReference(arrangement(44100)),b=analyzeReference(arrangement(48000));
    for(const key of Object.keys(a.shares) as (keyof typeof a.shares)[])expect(a.shares[key]).toBeCloseTo(b.shares[key],2);
    expect(a.frequencyCeilingHz).toBe(10000);expect(b.frequencyCeilingHz).toBe(10000);
  });
  it('rejects silence, a narrow low-confidence reference and malformed profiles',()=>{
    expect(()=>analyzeReference({sampleRate:48000,channels:[new Float32Array(96000)]})).toThrow();
    expect(()=>analyzeReference({sampleRate:48000,channels:[Float32Array.from({length:96000},(_,n)=>.1*Math.sin(2*Math.PI*1000*n/48000))]})).toThrow();
    const good=analyzeReference(perceptualFixture('balanced'));
    for(const bad of [{...good,confidence:.1},{...good,shares:{...good.shares,bass:NaN}},{...good,durationSeconds:0},{...good,shares:{...good.shares,body:.99}}])
      expect(()=>validateReferenceSelection(select(bad))).toThrow();
    expect(()=>validateReferenceSelection(select(good,NaN))).toThrow();
  });
  it('changes its plan by input and selects no DSP for an existing match or zero strength',()=>{
    const profile=analyzeReference(perceptualFixture('balanced'));
    const plan=(name:Parameters<typeof perceptualFixture>[0])=>{const m=measures(perceptualFixture(name));return planReferenceCorrection(m.analysis,m.features,profile);};
    const bass=plan('bass-heavy'),bright=plan('bright'),same=plan('balanced');
    expect(bass.bands.find(b=>b.frequencyHz===100)?.gainDb).toBeLessThan(0);
    expect(bright.bands.find(b=>b.frequencyHz===6500)?.gainDb).toBeLessThan(0);expect(bass.bands).not.toEqual(bright.bands);
    expect(same.bands).toEqual([]);expect(same.density).toBeUndefined();
    const m=measures(perceptualFixture('bass-heavy')),zero=planReferenceCorrection(m.analysis,m.features,profile,0);
    expect(zero.bands).toEqual([]);expect(zero.density).toBeUndefined();
    for(const p of [bass,bright]){expect(p.bands.length).toBeLessThanOrEqual(3);expect(p.bands.reduce((n,b)=>n+Math.abs(b.gainDb),0)).toBeLessThanOrEqual(4.000001);}
  });
  it('allows only bounded density correction when measured dynamic range and peak headroom permit it',()=>{
    const target=analyzeReference(perceptualFixture('overcompressed'));
    const audio=perceptualFixture('transient-heavy'),m=measures(audio);
    const plan=planReferenceCorrection(m.analysis,m.features,target);
    expect(plan.density?.maxReductionDb).toBeGreaterThan(0);expect(plan.density!.maxReductionDb).toBeLessThanOrEqual(.8);
    expect(planReferenceCorrection(m.analysis,m.features,target,.65,{compressionBudgetDb:0}).density).toBeUndefined();
    expect(planReferenceCorrection({...m.analysis,truePeakDbtp:-1.1},m.features,target).density).toBeUndefined();
    const dense=measures(perceptualFixture('overcompressed'));expect(planReferenceCorrection(dense.analysis,dense.features,target).density).toBeUndefined();
  });
  it('keeps the streaming filter and linked dynamics exactly continuous across arbitrary chunks',()=>{
    const source=perceptualFixture('transient-heavy'),m=measures(source),plan=planReferenceCorrection(m.analysis,m.features,analyzeReference(perceptualFixture('overcompressed')));
    const whole={sampleRate:source.sampleRate,channels:source.channels.map(c=>c.slice())},split={sampleRate:source.sampleRate,channels:source.channels.map(c=>c.slice())};
    const a=createReferenceProcessor(plan,source.sampleRate,2),b=createReferenceProcessor(plan,source.sampleRate,2);a(whole);
    for(let offset=0;offset<split.channels[0].length;offset+=1379)b({sampleRate:split.sampleRate,channels:split.channels.map(c=>c.subarray(offset,offset+1379))});
    expect(split.channels).toEqual(whole.channels);expect(b.reductionDb()).toBe(a.reductionDb());expect(b.reductionDb()).toBeLessThanOrEqual(.8);
  });
  it('retains Original and produces only a measured improvement with protected peaks and own loudness',()=>{
    const source=perceptualFixture('bass-heavy'),saved=source.channels.map(c=>c.slice()),before=analyzeAudio(source),profile=analyzeReference(perceptualFixture('balanced'));
    const result=applyReferenceFinishing(source,select(profile));
    expect(result.status,result.reasons.join(' ')).toBe('accepted');const last=result.attempts.at(-1)!;
    expect(last.distanceAfter).toBeLessThan(last.distanceBefore);expect(last.after.clippedSamples).toBe(0);expect(last.after.truePeakDbtp!).toBeLessThanOrEqual(-.9999);
    expect(Math.abs(last.after.integratedLufs!-before.integratedLufs!)).toBeLessThan(.6);expect(source.channels).toEqual(saved);
  });
  it('rejects unsafe candidates and bounds every retry while restarting from the same original',()=>{
    const source=perceptualFixture('bass-heavy'),m=measures(source),profile=analyzeReference(perceptualFixture('bright'));
    const altered={...m.analysis,integratedLufs:m.analysis.integratedLufs!-20};
    const result=applyReferenceFinishing(source,select(profile),{maxIterations:3,originalAnalysis:altered,originalFeatures:analyzeAdaptiveFeatures(source)});
    expect(result.status).toBe('rejected');expect(result.processed).toBeUndefined();expect(result.attempts).toHaveLength(3);
    expect(result.attempts.map(a=>a.plan.strength)).toEqual([.65,.325,.1625]);
    expect(()=>applyReferenceFinishing(source,select(profile),{maxIterations:4})).toThrow();
    const unsafe=evaluateReferenceQuality(m.analysis,{...m.analysis,truePeakDbtp:.1,clippedSamples:2},m.features,m.features,profile);
    expect(unsafe.accepted).toBe(false);expect(unsafe.reasons.join(' ')).toContain('ピーク');
  });
  it('skips extra DSP on a match and supports cancellation before processing and between render/evaluation',()=>{
    const source=perceptualFixture('balanced'),profile=analyzeReference(source),saved=source.channels.map(c=>c.slice());
    expect(applyReferenceFinishing(source,select(profile)).status).toBe('skipped');
    const other=analyzeReference(perceptualFixture('bass-heavy'));
    for(const point of [0,.22]){
      const abort=new AbortController();expect(()=>applyReferenceFinishing(source,select(other),{signal:abort.signal,onProgress:f=>{if(f>=point)abort.abort();}})).toThrow('cancelled');
    }expect(source.channels).toEqual(saved);
  });
  it('keeps AUTO base candidate and requested output when reference is off or a reference candidate fails',()=>{
    const source=perceptualFixture('balanced'),profile=profileFromMeasurements(analyzeAudio(source),analyzePerceptualFeatures(source));
    const base=autoMixMaster(source),off=autoMixMaster(source,'AUTO',{reference:select(profile,0)});
    expect(base.status).toBe('accepted');expect(off.reference?.status).toBe('skipped');expect(off.processed!.audio).toEqual(base.processed!.audio);
    const requested=autoMixMaster(source,'AUTO',{preferences:{output:'youtube',controls:{vocal:0,bass:0,clarity:0,warmth:0,punch:0,width:0,density:0}},reference:select(analyzeReference(perceptualFixture('bass-heavy')))});
    expect(requested.status).toBe('accepted');expect(requested.preferences!.requestedLufs).toBe(-14);expect(requested.finalAfter).toEqual(analyzeAudio(requested.processed!.audio));
    expect(requested.reference).toBeDefined();
  });
});
