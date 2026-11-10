import { describe,it,expect } from 'vitest';
import { analyzePerceptualFeatures,PerceptualAnalyzer,PERCEPTUAL_BANDS,analyzeAudio,analyzeAdaptiveFeatures,planMixCorrection,detectPerceptualProblems,evaluatePerceptualQuality,autoMixMaster,createBlindComparison } from '@music-sync/core';
import { renderMix, type MixStage } from '@music-sync/dsp';
import { perceptualFixture } from '../fixtures/perceptual';
import { tone } from '../helpers/audio';

const plan=(name:Parameters<typeof perceptualFixture>[0],mode:'AUTO'|'LIVE'|'IMPACT'='AUTO')=>{
  const a=perceptualFixture(name),p=analyzePerceptualFeatures(a);return planMixCorrection(analyzeAudio(a),analyzeAdaptiveFeatures(a),mode,1,p);
};
describe('Phase 7 perceptual intelligence',()=>{
  it.each([[40,'sub'],[110,'low'],[280,'lowMid'],[650,'mid'],[1600,'upperMid'],[3300,'presence'],[7000,'high'],[11000,'air']] as const)('places %i Hz in %s without downmix cancellation',(frequency,band)=>{
    const audio=tone({sampleRate:24000,frequency,stereo:true});audio.channels[1].forEach((x,i)=>{audio.channels[1][i]=-x;});
    const p=analyzePerceptualFeatures(audio);expect(p.bands[band].mean).toBeGreaterThan(0.9);expect(p.sideRatio).toBeCloseTo(1,6);
  });
  it('spectral decisions are invariant to listening level',()=>{
    const a=perceptualFixture('muddy'),b={sampleRate:a.sampleRate,channels:a.channels.map(c=>c.map(x=>x*0.5))};
    const p=analyzePerceptualFeatures(a),q=analyzePerceptualFeatures(b);
    expect(q.features.muddiness.value).toBeCloseTo(p.features.muddiness.value,6);expect(q.centroidHz).toBeCloseTo(p.centroidHz,5);
  });
  it('eight spectral bands, distributions and arbitrary chunks are deterministic',()=>{
    const a=perceptualFixture('balanced'),p=analyzePerceptualFeatures(a),stream=new PerceptualAnalyzer(a.sampleRate,2);
    for(let offset=0;offset<a.channels[0].length;offset+=137)stream.push(a.channels.map(c=>c.subarray(offset,offset+137)));
    expect(stream.finish()).toEqual(p);expect(()=>stream.finish()).toThrow();
    expect(Object.keys(p.bands)).toEqual([...PERCEPTUAL_BANDS]);expect(Object.values(p.bands).reduce((s,b)=>s+b.mean,0)).toBeCloseTo(1,8);
    expect(p.centroidHz).toBeGreaterThan(1000);expect(p.rolloffHz).toBeGreaterThan(p.centroidHz);expect(p.windows).toBeGreaterThan(20);
  });
  it.each([['muddy','muddiness'],['harsh','harshness'],['dull','dullness'],['bass-heavy','lowEndBuildup'],['bright','brightness']] as const)('%s has stronger %s evidence than balanced', (fixture,feature)=>{
    const p=analyzePerceptualFeatures(perceptualFixture(fixture)),b=analyzePerceptualFeatures(perceptualFixture('balanced'));
    expect(p.features[feature].value).toBeGreaterThan(b.features[feature].value+0.15);
    expect(detectPerceptualProblems(p).some(i=>i.issue===feature&&i.confidence>=0.55)).toBe(true);
  });
  it('suppresses uncertain or mild processing and preserves healthy AUTO',()=>{
    expect(plan('balanced').stages.some(s=>['eq','dynamic-eq','multiband'].includes(s.kind))).toBe(false);
    const a=perceptualFixture('muddy'),p=analyzePerceptualFeatures(a);
    for(const value of Object.values(p.features))value.confidence=0.1;p.confidence=0.1;
    const mix=planMixCorrection(analyzeAudio(a),analyzeAdaptiveFeatures(a),'AUTO',1,p);
    expect(mix.perceptual!.decisions).toHaveLength(0);expect(mix.perceptual!.skippedProcessing.length).toBeGreaterThan(0);
    expect(analyzePerceptualFeatures(tone()).confidence).toBeLessThan(0.55);
  });
  it('distinguishes persistent from intermittent spectral excess',()=>{
    expect(plan('harsh').stages.some(s=>s.kind==='eq')).toBe(true);
    expect(plan('intermittent-harsh').stages.some(s=>s.kind==='dynamic-eq')).toBe(true);
    expect(plan('low-bursts').stages.some(s=>s.kind==='multiband')).toBe(true);
  });
  it('detects phase risk while never widening a narrow source',()=>{
    expect(plan('excessive-stereo').perceptual!.detectedIssues.some(i=>i.issue==='phaseRisk')).toBe(true);
    expect(plan('narrow','IMPACT').stages.some(s=>s.kind==='width'&&s.amount>1)).toBe(false);
    const a=perceptualFixture('excessive-stereo'),b=renderMix(a,[{kind:'bass-center',amount:0.75,crossoverHz:150}]);
    for(let i=0;i<a.channels[0].length;i+=101)expect(b.channels[0][i]+b.channels[1][i]).toBeCloseTo(a.channels[0][i]+a.channels[1][i],6);
  });
  it('recognizes wet tendency and strong attacks without treating either as a universal boost request',()=>{
    const wet=analyzePerceptualFeatures(perceptualFixture('wet')),dry=analyzePerceptualFeatures(perceptualFixture('transient-heavy'));
    expect(wet.features.ambience.value).toBeGreaterThan(dry.features.ambience.value);expect(wet.ambienceClass).toBe('Wet');
    expect(analyzePerceptualFeatures(perceptualFixture('balanced')).ambienceClass).not.toBe('Wet');
    const w=plan('wet','LIVE').stages.find(s=>s.kind==='live')!,d=plan('transient-heavy','LIVE').stages.find(s=>s.kind==='live')!;
    if(w.kind!=='live'||d.kind!=='live')throw new Error('Missing LIVE');expect(w.parameters.wet).toBeLessThan(d.parameters.wet);
    expect(plan('transient-heavy','IMPACT').stages.some(s=>s.kind==='dynamics'&&s.punchDb>0)).toBe(false);
    expect(analyzePerceptualFeatures(perceptualFixture('overcompressed')).features.dynamicDensity.value).toBeGreaterThan(dry.features.dynamicDensity.value);
  });
  it('Dynamic EQ attenuates a loud band, preserves quiet sections and Original',()=>{
    const a=tone({sampleRate:24000,frequency:3200,seconds:2,amplitude:0.01}),snapshot=a.channels[0].slice();
    for(let i=24000;i<48000;i++)a.channels[0][i]*=25; snapshot.set(a.channels[0]);
    const stage:MixStage={kind:'dynamic-eq',bands:[{frequencyHz:3200,q:1,thresholdDb:-30,maxReductionDb:2,attackMs:8,releaseMs:100}]};
    const b=renderMix(a,[stage]);expect(a.channels[0]).toEqual(snapshot);
    expect(b.channels[0].slice(1000,20000)).toEqual(a.channels[0].slice(1000,20000));
    const energy=(v:Float32Array)=>v.reduce((s,x)=>s+x*x,0);
    expect(energy(b.channels[0].slice(30000))).toBeLessThan(energy(a.channels[0].slice(30000))*0.85);
    expect(renderMix(a,[{...stage,bands:stage.bands.map(b=>({...b,maxReductionDb:0}))}]).channels).toEqual(a.channels);
  });
  it('3-band dynamics bypass reconstructs exactly and selectively reduces low energy',()=>{
    const a=perceptualFixture('bass-heavy'),base={lowHz:180,highHz:3500,attackMs:10,releaseMs:100,bands:[0,0,0].map(()=>({thresholdDb:-35,maxReductionDb:0}))};
    expect(renderMix(a,[{kind:'multiband',parameters:base}]).channels).toEqual(a.channels);
    const b=renderMix(a,[{kind:'multiband',parameters:{...base,bands:base.bands.map((v,i)=>({...v,maxReductionDb:i===0?1.5:0}))}}]);
    expect(analyzePerceptualFeatures(b).bands.low.rmsDb).toBeLessThan(analyzePerceptualFeatures(a).bands.low.rmsDb-0.3);
    expect(b.channels[0].every(Number.isFinite)).toBe(true);
  });
  it('objective gate requires improvement, rejects unrelated clarity loss, accepts successful correction',()=>{
    const a=perceptualFixture('muddy'),p=analyzePerceptualFeatures(a),mix=plan('muddy');
    expect(mix.perceptual!.decisions.length).toBeGreaterThan(0);
    expect(evaluatePerceptualQuality(p,p,mix.perceptual!).accepted).toBe(false);
    const b=analyzePerceptualFeatures(renderMix(a,mix.stages));expect(evaluatePerceptualQuality(p,b,mix.perceptual!).accepted).toBe(true);
    b.features.harshness.value=1;expect(evaluatePerceptualQuality(p,b,mix.perceptual!).accepted).toBe(false);
  });
  it('engine keeps bounded attempts, cancellation, deterministic results and immutable Original',()=>{
    const a=perceptualFixture('intermittent-harsh',2),original=a.channels.map(c=>c.slice());
    const first=autoMixMaster(a,'AUTO',{maxIterations:2});expect(first.attempts.length).toBeLessThanOrEqual(2);expect(a.channels).toEqual(original);
    expect(autoMixMaster(a,'AUTO',{maxIterations:2})).toEqual(first);
    const controller=new AbortController();expect(()=>autoMixMaster(a,'AUTO',{signal:controller.signal,onProgress:p=>{if(p.stage==='Evaluating')controller.abort();}})).toThrow('cancelled');
    expect(a.channels).toEqual(original);
  });
  it('future blind presentation requires loudness matching and a stable private mapping',()=>{
    const a=analyzeAudio(tone({amplitude:0.1})),b=analyzeAudio(tone({amplitude:0.2}));
    const trial=createBlindComparison(a,b,true);expect(trial.mapping).toEqual({X:'b',Y:'a'});expect(trial.matched).toBe(true);
    expect(a.integratedLufs!+trial.gainsDb.a).toBeCloseTo(b.integratedLufs!+trial.gainsDb.b,8);
    expect(()=>createBlindComparison(a,analyzeAudio(tone({amplitude:0})),false)).toThrow('matching');
  });
  it('new processors reject unsafe parameters; analysis respects limited bandwidth and silence',()=>{
    const a=tone();
    expect(()=>renderMix(a,[{kind:'dynamic-eq',bands:[{frequencyHz:2000,q:1,thresholdDb:-30,maxReductionDb:6,attackMs:8,releaseMs:120}]}])).toThrow();
    expect(()=>renderMix(a,[{kind:'multiband',parameters:{lowHz:180,highHz:3500,attackMs:10,releaseMs:100,bands:[]}}])).toThrow();
    const p=analyzePerceptualFeatures(tone({sampleRate:8000}));expect(p.features.dullness.confidence).toBe(0);
    const silence=analyzePerceptualFeatures(tone({amplitude:0}));expect(silence.confidence).toBe(0);expect(silence.windows).toBe(0);
  });
});
