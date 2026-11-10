import { beforeAll, expect, it } from 'vitest';
import { analyzeAudio, encodeFloatWav, finishStemMix, mixStems, renderFileStems, resolveStemGrainRestoration, type AudioData, type StemMixResult, type StemDescriptor } from '@music-sync/core';
import { renderLong } from '../../apps/web/src/long-render';
let mix: StemMixResult;
const selection = { grain:'strong' as const, amount:100 };
beforeAll(async () => {
  const rate=48000, frames=rate*2;
  let seed=37, low=0;
  const voice=Float32Array.from({length:frames},(_,i)=>{
    seed=(Math.imul(seed,1664525)+1013904223)>>>0;
    const noise=(seed/2**32-0.5)*0.15; low+=0.28*(noise-low);
    return 0.1*Math.sin(2*Math.PI*220*i/rate)+0.025*Math.sin(2*Math.PI*3300*i/rate)+noise-low;
  });
  const clean=Float32Array.from({length:frames},(_,i)=>0.04*Math.sin(2*Math.PI*120*i/rate));
  const tracks=[voice,clean].map((pcm,i)=>{
    const descriptor:StemDescriptor={id:String(i),name:String(i),role:i?'instrumental':'vocal',sampleRate:rate,channels:1,frames,gainDb:0,pan:0,muted:false};
    return {descriptor,async *open(){for(let at=0;at<frames;at+=65536)yield {sampleRate:rate,channels:[pcm.subarray(at,at+65536)]};}};
  });
  const channels=[new Float32Array(frames),new Float32Array(frames)];
  let offset=0;
  const result=await renderFileStems(tracks,{mode:'vocal-instrumental',autoBalance:false,blockFrames:65536,
    studio:{restore:true,repair:selection,treble:'off',doubleAmount:0,doubleMs:30},
    async write(block){block.channels.forEach((ch,c)=>channels[c].set(ch,offset));offset+=block.channels[0].length;}
  });
  mix={audio:{sampleRate:rate,channels},analysis:result.analysis,report:result.report};
});
it('records raw source evidence and per-track accepted/skipped grain decisions',()=>{
  expect(mix.report.tracks[0].restoration?.grain?.status).toBe('applied');
  expect(mix.report.tracks[1].restoration?.grain?.status).toBe('skipped');
  expect(mix.report.tracks[0].analysis.frames).toBe(mix.audio.channels[0].length);
  expect(mix.report.tracks[0].analysis.clippedSamples).toBe(0);
});
it('reuses accepted material repairs in normal automatic finishing and permits an explicit additional candidate',()=>{
  const before=JSON.stringify(mix.report), input={...selection};
  const result=finishStemMix(mix,'AUTO',{treble:'off',repairControls:input});
  expect(result.status).toBe('accepted');
  expect(result.grain?.status).toBe('skipped');expect(result.grain?.inheritedTracks).toBe(1);
  expect(result.explanations.join(' ')).toContain('1素材');
  const override=finishStemMix(mix,'AUTO',{treble:'off',repairControls:{...selection,repeatGrain:true}});
  expect(override.grain?.inheritedTracks).toBeUndefined();
  expect(override.grain?.mode).toBe('strong');
  expect(input).toEqual(selection); expect(JSON.stringify(mix.report)).toBe(before);
});
it('preserves legacy reports and ignores muted, unmatched and rejected material repairs',()=>{
  const audio:AudioData={sampleRate:8000,channels:[new Float32Array(8000).fill(0.01)]};
  const descriptor=(id:string):StemDescriptor=>({id,name:id,role:'other',sampleRate:8000,channels:1,frames:8000,gainDb:0,pan:0,muted:false});
  const legacy=mixStems(['a','b'].map(id=>({descriptor:descriptor(id),audio}))).report;
  expect(resolveStemGrainRestoration(legacy,selection).controls).toEqual(selection);
  for(const status of ['skipped','reverted'] as const){
    const copy=structuredClone(mix.report);copy.tracks[0].restoration!.grain!.status=status;
    expect(resolveStemGrainRestoration(copy,selection).appliedTracks).toBe(0);
  }
  const copy=structuredClone(mix.report);
  const muted={...copy,plan:{...copy.plan,tracks:copy.plan.tracks.map((track,i)=>({...track,muted:i===0 || track.muted}))}};
  expect(resolveStemGrainRestoration(muted,selection).appliedTracks).toBe(0);
  const renamed=structuredClone(mix.report);renamed.tracks[0].descriptor.id='unmatched';
  expect(resolveStemGrainRestoration(renamed,selection).appliedTracks).toBe(0);
});
it('uses the same decision in the file-backed adapter without applying memory-bus validation',async()=>{
  let saved=new Blob();
  const destination={async createWritable(){const parts:BlobPart[]=[];return {
    async write(part:BlobPart){parts.push(part);},async close(){saved=new Blob(parts);},async abort(){},
  };},async getFile(){return new File([saved],'candidate.wav',{type:'audio/wav'});}} as unknown as FileSystemFileHandle;
  const result=await renderLong({kind:'long-render',file:new File([encodeFloatWav(mix.audio)],'source.wav'),
    destination,before:analyzeAudio(mix.audio),sourceMix:mix.report,mode:'AUTO',
    live:{venue:'concert-hall',intensity:'standard'},output:'auto',treble:'off',repairControls:selection},()=>{});
  expect(result.grain.inheritedTracks).toBe(1);
  expect(result.file.size).toBe(56+mix.audio.channels[0].length*8);
  expect(result.result.clippedSamples).toBe(0);
});
