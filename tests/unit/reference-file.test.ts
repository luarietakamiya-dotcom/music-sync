import {beforeEach,expect,it,vi} from 'vitest';
import {encodeFloatWav} from '@music-sync/core';
import {analyzeAudio} from '@music-sync/audio-analysis';
import {analyzeReference} from '../../packages/core/src/reference-finishing';
import {finishReferenceFile} from '../../apps/web/src/reference-file';
import {perceptualFixture} from '../fixtures/perceptual';

let scratches:ReturnType<typeof memoryFile>[]=[];
vi.mock('../../apps/web/src/candidate-file',()=>({CandidateFile:class{
  record=memoryFile();handle=Promise.resolve(this.record.handle);
  constructor(){scratches.push(this.record);}
  async discard(){this.record.discarded=true;}
}}));
function memoryFile(initial=new File([],'scratch.wav'),failWrite=false){
  let file=initial,opens=0,commits=0;const record={discarded:false,handle:{} as FileSystemFileHandle,opens:()=>opens,commits:()=>commits};
  record.handle={async getFile(){return file;},async createWritable(){
    opens++;const parts:BlobPart[]=[];
    const stream=new WritableStream<ArrayBuffer|Uint8Array>({write(data){
      if(failWrite)throw new Error('commit disk failure');
      parts.push(data instanceof ArrayBuffer?data.slice(0):new Uint8Array(data).buffer);
    },close(){file=new File(parts,'candidate.wav',{type:'audio/wav'});commits++;}});
    return Object.assign(stream,{
      async write(data:ArrayBuffer|Uint8Array){const writer=stream.getWriter();try{await writer.write(data);}finally{writer.releaseLock();}},
      async close(){const writer=stream.getWriter();try{await writer.close();}finally{writer.releaseLock();}},
    }) as unknown as FileSystemWritableFileStream;
  }} as unknown as FileSystemFileHandle;return record;
}
function base(){
  const audio=perceptualFixture('bass-heavy'),analysis=analyzeAudio(audio),file=new File([encodeFloatWav(audio)],'base.wav',{type:'audio/wav'});
  return {file,analysis,original:analysis};
}
beforeEach(()=>{scratches=[];});

it('evaluates separate streaming scratch before one destination commit and preserves its source file',async()=>{
  const input=base(),original=new Uint8Array(await input.file.arrayBuffer()),destination=memoryFile(input.file);
  const result=await finishReferenceFile(input,{profile:analyzeReference(perceptualFixture('balanced')),strength:.65},destination.handle);
  expect(result.reference.status,result.reference.reasons.join(' ')).toBe('accepted');expect(destination.opens()).toBe(1);expect(destination.commits()).toBe(1);
  expect(result.file.size).toBe(input.file.size);expect(result.analysis.clippedSamples).toBe(0);expect(result.analysis.truePeakDbtp!).toBeLessThanOrEqual(-1);
  expect(new Uint8Array(await input.file.arrayBuffer())).toEqual(original);expect(scratches.every(s=>s.discarded)).toBe(true);
  const attempt=result.reference.attempts.at(-1)!;expect(attempt.distanceAfter).toBeLessThan(attempt.distanceBefore);
});

it('leaves the accepted destination untouched when all three whole-original quality gates reject',async()=>{
  const input=base(),destination=memoryFile(input.file);
  const result=await finishReferenceFile({...input,original:{...input.original,rmsDbfs:input.original.rmsDbfs!-20}},
    {profile:analyzeReference(perceptualFixture('bright')),strength:.65},destination.handle);
  expect(result.reference.status).toBe('rejected');expect(result.reference.attempts).toHaveLength(3);expect(destination.opens()).toBe(0);
  expect(result.file).toBe(input.file);expect(result.analysis).toBe(input.analysis);expect(scratches).toHaveLength(3);expect(scratches.every(s=>s.discarded)).toBe(true);
});

it('skips matching and lower-rate sources without scratch writes or destination changes',async()=>{
  const input=base(),destination=memoryFile(input.file),source=perceptualFixture('bass-heavy');
  const match=await finishReferenceFile(input,{profile:analyzeReference(source),strength:.65},destination.handle);
  expect(match.reference.status).toBe('skipped');expect(destination.opens()).toBe(0);expect(scratches).toHaveLength(0);
  const low={sampleRate:16000,channels:source.channels},analysis=analyzeAudio(low),file=new File([encodeFloatWav(low)],'low.wav');
  const result=await finishReferenceFile({file,analysis,original:analysis},{profile:analyzeReference(source),strength:.65},destination.handle);
  expect(result.reference.status).toBe('skipped');expect(result.reference.explanations.join(' ')).toContain('24 kHz');expect(scratches).toHaveLength(0);
});

it('propagates a destination-copy failure rather than returning a potentially overwritten base snapshot',async()=>{
  const input=base(),destination=memoryFile(input.file,true);
  await expect(finishReferenceFile(input,{profile:analyzeReference(perceptualFixture('balanced')),strength:.65},destination.handle)).rejects.toThrow('commit disk failure');
  expect(destination.opens()).toBe(1);expect(destination.commits()).toBe(0);expect(scratches.every(s=>s.discarded)).toBe(true);
});

it('aborts a rendering scratch on a host cancellation exception before touching destination',async()=>{
  const input=base(),destination=memoryFile(input.file);
  await expect(finishReferenceFile(input,{profile:analyzeReference(perceptualFixture('balanced')),strength:.65},destination.handle,
    fraction=>{if(fraction>=.26)throw new Error('Processing cancelled');})).rejects.toThrow('cancelled');
  expect(destination.opens()).toBe(0);expect(scratches).toHaveLength(1);expect(scratches[0].discarded).toBe(true);
});
