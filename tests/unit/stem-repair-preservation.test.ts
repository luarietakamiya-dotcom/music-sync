import { expect, it } from 'vitest';
import { analyzeAudio, autoMixMaster, encodeFloatWav, finishStemMix, mixStems, resolveStemGrainRestoration,
  type AudioData, type StemDescriptor, type RepairControls } from '@music-sync/core';
import { renderLong } from '../../apps/web/src/long-render';

function materialMix(disabled=true) {
  const rate=48000,frames=rate*3;let seed=7,previous=0;
  const pcm=Float32Array.from({length:frames},(_,n)=>{
    seed=(Math.imul(seed,1664525)+1013904223)>>>0;
    const next=seed/2**32-.5,hiss=(next-previous)*.15;previous=next;
    return .12*Math.sin(2*Math.PI*440*n/rate)+(n>rate*.65&&n<rate*2.6?hiss:0);
  });
  const audio:AudioData={sampleRate:rate,channels:[pcm]};
  const descriptor=(id:string):StemDescriptor=>({id,name:id,role:'other',sampleRate:rate,channels:1,frames,gainDb:0,pan:0,muted:false});
  return mixStems([
    {descriptor:{...descriptor('texture'),...(disabled?{restorationEnabled:false}:{})},audio},
    {descriptor:descriptor('bass'),audio:{sampleRate:rate,channels:[Float32Array.from(pcm,(_,n)=>.025*Math.sin(2*Math.PI*110*n/rate))]}},
  ]);
}
const selection:RepairControls={grain:'strong',amount:100};

it('protects included OFF materials even when no other material has accepted repair, without mutating settings or metadata',()=>{
  const mix=materialMix(),before=JSON.stringify(mix.report),controls={...selection};
  const decision=resolveStemGrainRestoration(mix.report,controls);
  expect(decision.protectedTracks).toBe(1);
  expect(decision.suppressTreble).toBe(true);
  expect(decision.controls?.grain).toBe('off');
  expect(decision.report?.explanation).toContain('補修OFF');
  expect(controls).toEqual(selection);expect(JSON.stringify(mix.report)).toBe(before);
  const defaultSelection=resolveStemGrainRestoration(mix.report);
  expect(defaultSelection.suppressTreble).toBe(true);expect(defaultSelection.controls?.grain).toBe('off');
  expect(()=>resolveStemGrainRestoration(mix.report,{grain:'bad' as never})).toThrow();
});

it('leaves normal AUTO mix/master stages intact while suppressing whole-mix grain and treble repair',()=>{
  const mix=materialMix(),saved=mix.audio.channels.map(channel=>channel.slice());
  const preserved=finishStemMix(mix,'AUTO',{repairControls:selection,treble:'strong'});
  const reference=autoMixMaster(mix.audio,'AUTO',{repairControls:{...selection,grain:'off'},treble:'off'});
  expect(reference.status).toBe('accepted');
  expect(preserved.status).toBe(reference.status);
  expect(preserved.grain?.status).toBe('skipped');
  expect(preserved.treble?.mode).toBe('off');
  expect(preserved.explanations.join(' ')).toContain('補修OFF');
  expect(preserved.attempts.map(attempt=>attempt.mix.stages)).toEqual(reference.attempts.map(attempt=>attempt.mix.stages));
  expect(preserved.processed?.audio).toEqual(reference.processed?.audio);
  expect(mix.audio.channels).toEqual(saved);
});

it('allows the explicit additional-repair override and ignores muted or unmatched OFF metadata',()=>{
  const mix=materialMix();
  const override=resolveStemGrainRestoration(mix.report,{...selection,repeatGrain:true});
  expect(override.protectedTracks).toBe(1);expect(override.suppressTreble).toBe(false);
  expect(override.controls?.grain).toBe('strong');expect(override.preservationExplanation).toBeUndefined();
  const result=finishStemMix(mix,'AUTO',{treble:'strong',repairControls:{...selection,repeatGrain:true}});
  expect(result.grain?.mode).toBe('strong');expect(result.treble?.mode).toBe('strong');
  const muted=structuredClone(mix.report);muted.plan.tracks=muted.plan.tracks.map(track=>({...track,muted:track.id==='texture'}));
  expect(resolveStemGrainRestoration(muted,selection).suppressTreble).toBe(false);
  const unmatched=structuredClone(mix.report);unmatched.tracks[0].descriptor.id='unknown';
  expect(resolveStemGrainRestoration(unmatched,selection).suppressTreble).toBe(false);
  expect(resolveStemGrainRestoration(materialMix(false).report,selection).controls).toEqual(selection);
});

function destination() {
  let saved=new Blob();
  return {async createWritable(){const parts:BlobPart[]=[];return {
    async write(part:BlobPart){parts.push(part);},async close(){saved=new Blob(parts);},async abort(){},
  };},async getFile(){return new File([saved],'candidate.wav',{type:'audio/wav'});}} as unknown as FileSystemFileHandle;
}

it('uses the same OFF preservation for file-backed finishing and retains ordinary mastering output',async()=>{
  const mix=materialMix(),file=new File([encodeFloatWav(mix.audio)],'mix.wav');
  const common={kind:'long-render' as const,file,before:analyzeAudio(mix.audio),mode:'AUTO' as const,
    live:{venue:'concert-hall' as const,intensity:'standard' as const},output:'auto' as const};
  const preserved=await renderLong({...common,destination:destination(),sourceMix:mix.report,repairControls:selection,treble:'strong'},()=>{});
  const reference=await renderLong({...common,destination:destination(),repairControls:{...selection,grain:'off'},treble:'off'},()=>{});
  expect(preserved.grain.status).toBe('skipped');expect(preserved.repair.mode).toBe('off');
  expect(preserved.explanations.join(' ')).toContain('補修OFF');
  expect(preserved.gainDb).toBe(reference.gainDb);
  expect(new Uint8Array(await preserved.file.arrayBuffer())).toEqual(new Uint8Array(await reference.file.arrayBuffer()));
  expect(preserved.result.clippedSamples).toBe(0);
});
