import {expect,it} from 'vitest';
import type {AnalysisResult} from '@music-sync/shared';
import {planBatchLoudness,BATCH_LOUDNESS_LIMITS} from '../../packages/core/src/batch-loudness';
function analysis(lufs=-16,peak=-3):AnalysisResult{return {schemaVersion:1,algorithmVersion:'0.1.0',sampleRate:48000,channels:2,frames:48000*3,durationSeconds:3,
 samplePeakDbfs:peak-.1,rmsDbfs:lufs,integratedLufs:lufs,truePeakDbtp:peak,truePeakMethod:'4x-windowed-sinc-estimate',crestFactorDb:12,
 stereoCorrelation:.8,sideEnergyPercent:8,clippedSamples:0,dcOffset:[0,0],waveform:[],warnings:[]};}

it('chooses one safe common LUFS without extra compression and preserves song ordering',()=>{
 const inputs=[{id:'loud',analysis:analysis(-12,-1)},{id:'medium',analysis:analysis(-18,-2)},{id:'quiet',analysis:analysis(-24,-10)}],before=JSON.stringify(inputs);
 const result=planBatchLoudness(inputs,{targetLufs:-14});
 expect(result.commonTargetLufs).toBe(-21);expect(result.tracks.map(track=>track.id)).toEqual(['loud','medium','quiet']);
 expect(result.tracks.map(track=>track.gainDb)).toEqual([-9,-3,3]);expect(result.tracks.every(track=>track.expectedLufs===-21)).toBe(true);
 expect(JSON.stringify(inputs)).toBe(before);expect(result.notes.join(' ')).toContain('リミッターは使いません');
});

it('uses peak headroom instead of limiter-based target chasing',()=>{
 const result=planBatchLoudness([{id:'peak-limited',analysis:analysis(-22,-.5)},{id:'other',analysis:analysis(-14,-4)}]);
 expect(result.commonTargetLufs).toBe(-22.5);expect(result.tracks[0].gainDb).toBe(-.5);expect(result.tracks[1].gainDb).toBe(-8.5);
 for(const track of result.tracks){expect(track.gainDb!).toBeLessThanOrEqual(3);expect(track.expectedTruePeakDbtp!).toBeLessThanOrEqual(-1);}
});

it('excludes clipped, silent, malformed and extremely quiet songs independently without changing their order',()=>{
 const result=planBatchLoudness([
  {id:'clipped',analysis:{...analysis(),clippedSamples:1}},
  {id:'silent',analysis:{...analysis(),integratedLufs:null}},
  {id:'broken',analysis:{...analysis(),durationSeconds:4}},
  {id:'inaudible',analysis:analysis(-65,-40)},
  {id:'floor',analysis:analysis(-50,-30)},
  {id:'ok',analysis:analysis(-18,-6)},
 ]);
 expect(result.tracks.map(track=>track.status)).toEqual(['unavailable','unavailable','unavailable','unavailable','unavailable','ready']);
 expect(result.tracks.slice(0,5).every(track=>track.gainDb===null&&track.reason)).toBe(true);expect(result.commonTargetLufs).toBe(-16);
 expect(result.tracks[5].gainDb).toBe(2);
});

it('returns no common target when nothing is measurable, including empty input',()=>{
 expect(planBatchLoudness([]).commonTargetLufs).toBeNull();
 const result=planBatchLoudness([{id:'bad',analysis:{...analysis(),truePeakDbtp:NaN}}]);
 expect(result.commonTargetLufs).toBeNull();expect(result.tracks[0].status).toBe('unavailable');
});

it('rejects ambiguous IDs, oversized batches and unsafe requested targets or ceilings',()=>{
 expect(()=>planBatchLoudness([{id:'same',analysis:analysis()},{id:'same',analysis:analysis()}])).toThrow();
 expect(()=>planBatchLoudness(Array.from({length:BATCH_LOUDNESS_LIMITS.maxTracks+1},(_,i)=>({id:String(i),analysis:analysis()})))).toThrow('20');
 for(const options of [{targetLufs:Infinity},{targetLufs:-8},{targetLufs:-41},{ceilingDb:0},{ceilingDb:-7}])expect(()=>planBatchLoudness([{id:'a',analysis:analysis()}],options)).toThrow();
});

it('honors a lower delivery ceiling and never boosts above three LU even with abundant headroom',()=>{
 const result=planBatchLoudness([{id:'a',analysis:analysis(-24,-20)},{id:'b',analysis:analysis(-18,-2)}],{targetLufs:-12,ceilingDb:-3});
 expect(result.commonTargetLufs).toBe(-21);expect(result.tracks.map(track=>track.gainDb)).toEqual([3,-3]);
 expect(result.tracks.every(track=>track.expectedTruePeakDbtp!<=-3)).toBe(true);
});
