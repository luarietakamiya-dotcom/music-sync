import {expect,it} from 'vitest';
import type {AudioData} from '@music-sync/shared';
import {planSeparation,renderSeparation,SEPARATION_LIMITS,type SeparationInput,type SeparationModel,type SeparationRenderer} from '../../packages/core/src/source-separation';

const model=(overlap=.5):SeparationModel=>({id:'deterministic-test',kind:'music',targets:['vocals','accompaniment'],segmentSeconds:2,overlap});
function source(frames=48017,channels:1|2=2):AudioData{
 return {sampleRate:8000,channels:Array.from({length:channels},(_,channel)=>Float32Array.from({length:frames},(_,frame)=>
  frame===0?.63:frame===frames-1?-.47:Math.sin(frame*.03+channel*.4)*.23+Math.cos(frame*.011)*.07))};
}
const dimensions=(audio:AudioData):SeparationInput=>({sampleRate:audio.sampleRate,frames:audio.channels[0].length,channels:audio.channels.length as 1|2});
function parts(audio:AudioData):Record<string,AudioData>{return Object.fromEntries([['vocals',.25],['accompaniment',.75]].map(([name,gain])=>
 [name,{sampleRate:audio.sampleRate,channels:audio.channels.map(channel=>channel.map(value=>value*Number(gain)))}]));}
function harness(audio:AudioData){
 const writes=new Map<string,AudioData[]>(),events:string[]=[];
 const adapter:SeparationRenderer={
  async read(start,count){events.push('read:'+start);return {sampleRate:audio.sampleRate,channels:audio.channels.map(channel=>channel.subarray(start,start+count))};},
  async infer(input){events.push('infer');return parts(input);},
  async write(target,chunk){events.push('write:'+target);const list=writes.get(target)??[];list.push(chunk);writes.set(target,list);},
 };
 const joined=(target:string)=>[0,1].map(channel=>Float32Array.from((writes.get(target)??[]).flatMap(chunk=>Array.from(chunk.channels[channel]))));
 return {adapter,writes,events,joined};
}
function close(actual:number,expected:number){expect(Math.abs(actual-expected)).toBeLessThan(1e-6);}

it('plans bounded immutable segment metadata and preserves actual provider target names',()=>{
 const targets=['Kick','Snare','Hi-Hat','Toms','Cymbals'],input={sampleRate:8000,channels:1 as const,frames:40001};
 const requested={id:'drum-fixture',kind:'drums' as const,targets,segmentSeconds:2,overlap:.5},plan=planSeparation({...input,audio:new Float32Array(4)} as SeparationInput,
  {...requested,session:{weights:new Float32Array(4)}} as SeparationModel);
 expect(plan.starts).toEqual([0,8000,16000,24000,32000]);expect(plan.segmentFrames).toBe(16000);expect(plan.stepFrames).toBe(8000);
 expect(plan.outputBytes).toBe(40001*8*5);expect(plan.outputChannels).toBe(2);
 expect(Object.isFrozen(plan)).toBe(true);expect(Object.isFrozen(plan.starts)).toBe(true);expect(Object.isFrozen(plan.targets)).toBe(true);
 expect(Object.isFrozen(plan.input)).toBe(true);expect(Object.isFrozen(plan.model)).toBe(true);expect(Object.isFrozen(plan.model.targets)).toBe(true);
 expect('audio' in plan.input).toBe(false);expect('session' in plan.model).toBe(false);
 targets[0]='Changed';input.frames=3;expect(plan.targets[0]).toBe('Kick');expect(plan.input.frames).toBe(40001);
});

it.each([0,.5,.9])('reconstructs a prime-length input without gaps, edge loss or padded tail (overlap=%s)',async overlap=>{
 const original=source(),before=original.channels.map(channel=>channel.slice()),test=harness(original),plan=planSeparation(dimensions(original),model(overlap));
 const fractions:number[]=[];test.adapter.progress=progress=>{fractions.push(progress.fraction);};
 const summary=await renderSeparation(plan,test.adapter),vocal=test.joined('vocals'),accompaniment=test.joined('accompaniment');
 expect(summary.frames).toBe(48017);expect(summary.segments).toBe(plan.starts.length);
 for(let channel=0;channel<2;channel++){
  expect(vocal[channel].length).toBe(original.channels[channel].length);
  for(let frame=0;frame<original.channels[channel].length;frame++)close(vocal[channel][frame]+accompaniment[channel][frame],original.channels[channel][frame]);
  close(vocal[channel][0],original.channels[channel][0]*.25);close(vocal[channel].at(-1)!,original.channels[channel].at(-1)!*.25);
 }
 expect(original.channels).toEqual(before);expect(fractions.at(-1)).toBe(1);expect(fractions.every((fraction,index)=>Number.isFinite(fraction)&&fraction>=0&&fraction<=1&&(!index||fraction>=fractions[index-1]))).toBe(true);
 for(const chunks of test.writes.values()){
  expect(chunks.length).toBe(plan.starts.length);expect(chunks.slice(0,-1).every(chunk=>chunk.channels[0].length===plan.stepFrames)).toBe(true);
  expect(chunks.every(chunk=>chunk.channels[0].length<=plan.segmentFrames)).toBe(true);
 }
 expect(test.events.slice(0,4)).toEqual(['read:0','infer','write:vocals','write:accompaniment']);
});

it.each([1,997,16000,16001,32003])('duplicates mono into stereo and emits exactly %s frames',async frames=>{
 const original=source(frames,1),test=harness(original),plan=planSeparation(dimensions(original),model());let calls=0;
 test.adapter.infer=async input=>{
  calls++;expect(input.channels.length).toBe(2);expect(input.channels[0].length).toBe(plan.segmentFrames);expect(input.channels[0]).toEqual(input.channels[1]);
  if(calls===plan.starts.length){const valid=frames-plan.starts[calls-1];expect(input.channels[0].subarray(valid).every(value=>value===0)).toBe(true);}
  return parts(input);
 };
 await renderSeparation(plan,test.adapter);expect(calls).toBe(plan.starts.length);
 for(const target of plan.targets){const joined=test.joined(target);expect(joined[0].length).toBe(frames);expect(joined[0]).toEqual(joined[1]);}
});

it('protects read views of Original even when inference mutates its owned input',async()=>{
 const original=source(),before=original.channels.map(channel=>channel.slice()),test=harness(original),plan=planSeparation(dimensions(original),model());
 test.adapter.infer=async input=>{input.channels[0].fill(.5);input.channels[1].fill(-.5);return parts(input);};
 await renderSeparation(plan,test.adapter);expect(original.channels).toEqual(before);
 for(const value of test.joined('vocals')[0])close(value,.125);
 for(const value of test.joined('accompaniment')[1])close(value,-.375);
});

it('reports peaks without clipping or independently normalizing loud stems',async()=>{
 const original={sampleRate:8000,channels:[new Float32Array(31).fill(.75)]},test=harness(original);
 const plan=planSeparation(dimensions(original),{...model(),targets:['loud']});
 test.adapter.infer=async input=>({loud:{sampleRate:input.sampleRate,channels:input.channels.map(channel=>channel.map(value=>value*2))}});
 const summary=await renderSeparation(plan,test.adapter);
 expect(test.joined('loud')[0]).toEqual(new Float32Array(31).fill(1.5));expect(summary.maxPeak).toBe(1.5);expect(summary.targetPeaks.loud).toBe(1.5);
});

it.each(['read','infer','write'] as const)('checks cancellation after asynchronous %s and never returns a partial result',async stage=>{
 const original=source(),before=original.channels.map(channel=>channel.slice()),test=harness(original),controller=new AbortController();
 const callback=test.adapter[stage];test.adapter.signal=controller.signal;
 if(stage==='read')test.adapter.read=async(...args)=>{const value=await (callback as SeparationRenderer['read'])(...args);controller.abort();return value;};
 if(stage==='infer')test.adapter.infer=async(...args)=>{const value=await (callback as SeparationRenderer['infer'])(...args);controller.abort();return value;};
 if(stage==='write')test.adapter.write=async(...args)=>{await (callback as SeparationRenderer['write'])(...args);controller.abort();};
 await expect(renderSeparation(planSeparation(dimensions(original),model()),test.adapter)).rejects.toThrow();
 expect(test.events.filter(event=>event.startsWith('read:'))).toHaveLength(1);
 expect(test.events.filter(event=>event.startsWith('write:')).length).toBe(stage==='write'?1:0);expect(original.channels).toEqual(before);
});

it('rejects a pre-aborted render without invoking adapters',async()=>{
 const original=source(),test=harness(original),controller=new AbortController();controller.abort();test.adapter.signal=controller.signal;
 await expect(renderSeparation(planSeparation(dimensions(original),model()),test.adapter)).rejects.toThrow();expect(test.events).toEqual([]);
});

it.each(['missing','extra','rate','length','channels','nan','infinity'] as const)('rejects %s provider output before writing any target',async problem=>{
 const original=source(101),test=harness(original);test.adapter.infer=async input=>{
  const output=parts(input);
  if(problem==='missing')delete output.accompaniment;
  if(problem==='extra')output.unknown=output.vocals;
  if(problem==='rate')output.accompaniment={...output.accompaniment,sampleRate:16000};
  if(problem==='length')output.accompaniment={...output.accompaniment,channels:output.accompaniment.channels.map(channel=>channel.subarray(1))};
  if(problem==='channels')output.accompaniment={...output.accompaniment,channels:[output.accompaniment.channels[0]]};
  if(problem==='nan')output.accompaniment.channels[1][input.channels[0].length-1]=NaN;
  if(problem==='infinity')output.accompaniment.channels[1][0]=Infinity;
  return output;
 };
 await expect(renderSeparation(planSeparation(dimensions(original),model()),test.adapter)).rejects.toThrow();expect(test.writes.size).toBe(0);
});

it.each(['rate','length','channels','nan'] as const)('rejects malformed %s reads before inference',async problem=>{
 const original=source(101),test=harness(original);let inferred=false;test.adapter.infer=async input=>{inferred=true;return parts(input);};
 test.adapter.read=async()=>{
  if(problem==='rate')return {...original,sampleRate:16000};
  if(problem==='length')return {...original,channels:original.channels.map(channel=>channel.subarray(1))};
  if(problem==='channels')return {...original,channels:[original.channels[0]]};
  const channels=original.channels.map(channel=>channel.slice());channels[0][0]=NaN;return {...original,channels};
 };
 await expect(renderSeparation(planSeparation(dimensions(original),model()),test.adapter)).rejects.toThrow();expect(inferred).toBe(false);expect(test.writes.size).toBe(0);
});

it('bounds segment iterations and rejects forged starts before reading',async()=>{
 const original=source(),test=harness(original),plan=planSeparation(dimensions(original),model(.9));
 await expect(renderSeparation({...plan,starts:[0,0]},test.adapter)).rejects.toThrow('区間情報');
 await expect(renderSeparation({...plan,stepFrames:0},test.adapter)).rejects.toThrow('区間情報');expect(test.events).toEqual([]);
 const largest=planSeparation({sampleRate:8000,channels:2,frames:8000*1200},model(.9));
 expect(largest.starts.length).toBeLessThanOrEqual(SEPARATION_LIMITS.maxSegments);
 expect(largest.starts.every((start,index)=>index===0?start===0:start>largest.starts[index-1])).toBe(true);
});

it('rejects invalid metadata and unsafe target/segment parameters before allocation',()=>{
 const input={sampleRate:8000,channels:2 as const,frames:8000},valid=model();
 for(const bad of [{...input,sampleRate:7999},{...input,sampleRate:NaN},{...input,channels:3},{...input,frames:0},
  {...input,frames:8000*1200+1},{sampleRate:192000,channels:1,frames:70_000_000}])expect(()=>planSeparation(bad as SeparationInput,valid)).toThrow();
 for(const bad of [{...valid,targets:[]},{...valid,targets:['same','same']},{...valid,targets:['constructor']},
  {...valid,targets:Array.from({length:17},(_,index)=>String(index))},{...valid,segmentSeconds:1.99},{...valid,segmentSeconds:40.01},
  {...valid,overlap:-.01},{...valid,overlap:.9001},{...valid,overlap:NaN},{...valid,kind:'unknown'}])expect(()=>planSeparation(input,bad as SeparationModel)).toThrow();
});
