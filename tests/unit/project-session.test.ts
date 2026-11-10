import {expect,it} from 'vitest';
import {analyzeAudio,encodeFloatWav,planStemMix,mixStems,type AudioData} from '@music-sync/core';
import {decodeWav} from '../../apps/web/src/decode';
import {captureProjectSession,restoreProjectSession,type SessionCaptureInput,type SessionInspectionInput,type ProjectInspectionOptions} from '../../apps/web/src/project-session';
import {exportProject,importProject} from '../../apps/web/src/project-archive';

const audio=(scale=0.1):AudioData=>({sampleRate:8000,channels:[0,1].map(()=>Float32Array.from({length:800},(_,i)=>Math.sin(i*0.2)*scale))});
function fixture():SessionCaptureInput{
 const a=audio(),b=audio(0.2),raw=new File([encodeFloatWav(a)],'歌.wav',{type:'audio/wav'}),other=new File([encodeFloatWav(b)],'伴奏.wav',{type:'audio/wav'});
 const stems=[{id:'voice',file:raw,role:'vocal' as const,gainDb:0,pan:0,muted:false,restorationEnabled:false},
  {id:'inst',file:other,role:'instrumental' as const,gainDb:-1,pan:0,muted:false}];
 const analysis=analyzeAudio(a),descriptors=stems.map(entry=>({...entry,name:entry.file.name,sampleRate:8000,channels:2,frames:800}));
 const report={version:1 as const,plan:planStemMix(descriptors,'vocal-instrumental'),attenuationDb:-2,warnings:[],tracks:descriptors.map(descriptor=>({descriptor,analysis:{...analysis,clippedSamples:123456}}))};
 return {sources:{a:{audio:a,result:analysis,name:'原音A',originalFile:raw,stemMix:report},b:{audio:b,result:analyzeAudio(b),name:'仕上がりB'}},
  stems:stems.map(entry=>({...entry,gainDb:entry.gainDb+0.5})),committedStemInputs:stems,autoMode:'AUTO',controls:{'grain-mode':'strong','stem-auto-balance':true},
  exportSettings:{format:'mp3',bitrate:320,dither:true,metadata:{title:'夜の曲',artist:'作曲者'}},artwork:new File([new Uint8Array([137,80,78,71,13,10,26,10])],'表紙.png',{type:'image/png'}),
  selected:'b',matched:true,position:0.05,stemModeExplicit:true,stemMode:'vocal-instrumental',acceptedFinishSettings:'["AUTO"]',
  committedStemStudio:{restore:true,repair:{grain:'strong'},doubleAmount:0,doubleMs:30},committedStemOptions:{signature:'{"restore":true}'},explanations:{finish:'自然に整えました'}};
}
async function inspect(input:SessionInspectionInput,options:ProjectInspectionOptions){
 options.signal?.throwIfAborted();
 const data=input.kind==='planar'?{sampleRate:input.sampleRate,channels:await Promise.all(input.planes.map(async plane=>new Float32Array(await plane.arrayBuffer())))}:decodeWav(await input.file.arrayBuffer());
 const result=analyzeAudio(data);options.progress?.(1,'解析中');return {result,...(options.retainAudio?{audio:data}:{})};
}
async function archive(input=fixture()){
 const saved=captureProjectSession(input),blob=await exportProject(saved.manifest,saved.assets);
 return importProject(new File([blob!],'session.zip'));
}

it('captures PCM planes, original materials, pending/committed edits, artwork/settings and restores byte exact audio',async()=>{
 const input=fixture(),before=input.sources.a!.audio!.channels[0].slice(),saved=captureProjectSession(input);
 expect(saved.manifest.assets.length).toBe(7); // 2 original files, 4 PCM planes and a cover; raw files are deduplicated.
 expect(JSON.stringify(saved.manifest.state)).not.toContain('clippedSamples');
 const restored=await restoreProjectSession(await archive(input),{inspect});
 expect(restored.sources.a!.audio!.channels[0]).toEqual(before);expect(input.sources.a!.audio!.channels[0]).toEqual(before);
 expect(restored.stems[0].gainDb).toBe(0.5);expect(restored.committedStemInputs[0].gainDb).toBe(0);
 expect(restored.sources.a!.originalFile).toBe(restored.stems[0].file);
 expect(restored.sources.a!.stemMix!.tracks[0].analysis.clippedSamples).toBe(0);
 expect(restored.sources.a!.stemMix!.plan.tracks[1].gainDb).toBe(-1);
 expect(restored.exportSettings).toEqual(input.exportSettings);expect(restored.artwork!.name).toBe('表紙.png');
 expect(restored.selected).toBe('b');expect(restored.position).toBe(0.05);expect(restored.controls).toEqual(input.controls);
});

it('checks host settings and archive/schema references before any audio hydration',async()=>{
 const imported=await archive();let calls=0;const counted=async(input:SessionInspectionInput,options:ProjectInspectionOptions)=>{calls++;return inspect(input,options);};
 await expect(restoreProjectSession(imported,{inspect:counted,validateSettings(){throw new Error('unknown control');}})).rejects.toThrow('unknown control');expect(calls).toBe(0);
 const state=imported.manifest.state as {sources:{a:{data:{planes:string[]}}}};
 state.sources.a.data.planes=['missing'];
 await expect(restoreProjectSession(imported,{inspect:counted})).rejects.toThrow();expect(calls).toBe(0);
});

it('rejects malformed controls, export settings, stem gain/IDs and forged processing before hydration',async()=>{
 for(const mutate of [
  (input:SessionCaptureInput)=>{input.controls.bad=2 as unknown as string;},
  (input:SessionCaptureInput)=>{input.exportSettings.metadata.title='x'.repeat(1001);},
  (input:SessionCaptureInput)=>{input.stems[0].gainDb=7;},
  (input:SessionCaptureInput)=>{input.stems[1].id=input.stems[0].id;},
 ]){const input=fixture();mutate(input);expect(()=>captureProjectSession(input)).toThrow();}
 const imported=await archive();(imported.manifest.state.sources as Record<string,unknown>).b={name:'B',data:{kind:'file',asset:'asset_0'},processing:{chain:{},maxReductionDb:0,peakGuardDb:0}};
 let calls=0;await expect(restoreProjectSession(imported,{async inspect(input,options){calls++;return inspect(input,options);}})).rejects.toThrow();expect(calls).toBe(0);
});

it('cancels hydration without changing source buffers or returning a partial result',async()=>{
 const input=fixture(),before=input.sources.a!.audio!.channels[0].slice(),controller=new AbortController();
 await expect(restoreProjectSession(await archive(input),{signal:controller.signal,async inspect(value,options){const result=await inspect(value,options);controller.abort();return result;}})).rejects.toThrow();
 expect(input.sources.a!.audio!.channels[0]).toEqual(before);
});

it('retains file-backed long audio without forcing it into PCM and clamps playback to recomputed duration',async()=>{
 const input=fixture(),original=input.sources.a!.originalFile!;
 input.sources={a:{file:original,name:'file A',result:input.sources.a!.result}};input.selected='a';input.position=2;input.stems=[];input.committedStemInputs=[];
 const restored=await restoreProjectSession(await archive(input),{inspect});
 expect(restored.sources.a!.file).toBeInstanceOf(File);expect(restored.sources.a!.audio).toBeUndefined();expect(restored.position).toBe(0.1);
});

it('rejects oversized planar representations from metadata before reading samples',async()=>{
 const imported=await archive(),state=imported.manifest.state as {sources:{a:{data:{frames:number;sampleRate:number;planes:string[]}}}};
 const id=state.sources.a.data.planes[0],descriptor=imported.manifest.assets.find(item=>item.id===id)!;
 const frames=96*1024**2/4+1;state.sources.a.data.frames=frames;state.sources.a.data.sampleRate=48000;descriptor.size=frames*4;
 class SizedFile extends File {get size(){return frames*4;}}
 imported.assets.set(id,new SizedFile([],descriptor.name,{type:descriptor.mimeType}));let calls=0;
 await expect(restoreProjectSession(imported,{async inspect(value,options){calls++;return inspect(value,options);}})).rejects.toThrow();expect(calls).toBe(0);
});

it('rejects an empty source map and incompatible recomputed A/B before a caller can commit',async()=>{
 const empty=fixture();empty.sources={};expect(()=>captureProjectSession(empty)).toThrow('原音A');
 const imported=await archive(),state=imported.manifest.state as {sources:{b:{data:{sampleRate:number}}}};
 state.sources.b.data.sampleRate=16000;
 await expect(restoreProjectSession(imported,{inspect})).rejects.toThrow('サンプルレート');
 const missing=await archive();missing.manifest.state.sources={};
 await expect(restoreProjectSession(missing,{inspect})).rejects.toThrow('原音A');
});

it('preserves a selected pending reference separately from the committed reference',async()=>{
 const input=fixture();input.committedStemOptions!.reference=input.stems[0].file;input.reference=input.stems[1].file;
 const restored=await restoreProjectSession(await archive(input),{inspect});
 expect(restored.committedStemOptions!.reference!.name).toBe('歌.wav');expect(restored.reference!.name).toBe('伴奏.wav');
 expect(restored.committedStemOptions!.reference).not.toBe(restored.reference);
});

it('rejects file-backed FLAC sources while allowing original FLAC material assets',()=>{
 const input=fixture(),source=input.sources.a!,file=new File([new Uint8Array([1,2,3])],'original.flac',{type:'audio/flac'});
 source.originalFile=file;expect(()=>captureProjectSession(input)).not.toThrow();
 input.sources={a:{file,name:'unsupported file A',result:source.result}};
 expect(()=>captureProjectSession(input)).toThrow('WAV');
});

it('stores sound direction reference independently from STEM reference without trusting derived profiles',async()=>{
 const input=fixture();input.reference=input.stems[0].file;input.committedStemOptions!.reference=input.stems[0].file;
 input.soundReference={file:input.stems[1].file,strength:.65,enabled:true};
 const captured=captureProjectSession(input);expect(JSON.stringify(captured.manifest.state.soundReference)).not.toContain('profile');
 const restored=await restoreProjectSession(await archive(input),{inspect});
 expect(restored.soundReference!.file.name).toBe('伴奏.wav');expect(restored.soundReference!.strength).toBe(.65);expect(restored.soundReference!.enabled).toBe(true);
 expect(restored.reference!.name).toBe('歌.wav');expect(restored.committedStemOptions!.reference!.name).toBe('歌.wav');
 expect(restored.soundReference!.file).not.toBe(restored.reference);
});

it('rejects invalid reference strengths and serialized derived profiles before hydration',async()=>{
 for(const strength of [NaN,-.01,1.01,Infinity]){const input=fixture();input.soundReference={file:input.stems[0].file,strength,enabled:true};expect(()=>captureProjectSession(input)).toThrow('リファレンス');}
 const input=fixture();input.soundReference={file:input.stems[0].file,strength:.5,enabled:false};
 const imported=await archive(input);(imported.manifest.state.soundReference as Record<string,unknown>).profile={confidence:1};let calls=0;
 await expect(restoreProjectSession(imported,{async inspect(value,options){calls++;return inspect(value,options);}})).rejects.toThrow('リファレンス');expect(calls).toBe(0);
});

it('round-trips real peak-protected STEM mixing with signed attenuation and unchanged raw files',async()=>{
 const input=fixture(),materials=[audio(.75),audio(.7)],originalSamples=materials.map(material=>material.channels.map(channel=>channel.slice()));
 const wavBytes=materials.map(encodeFloatWav),entries=input.committedStemInputs.map((entry,index)=>({...entry,gainDb:0,
  file:new File([wavBytes[index]],entry.file.name,{type:'audio/wav'})}));
 const mixed=mixStems(entries.map((entry,index)=>({audio:materials[index],descriptor:{id:entry.id,name:entry.file.name,role:entry.role,
  gainDb:entry.gainDb,pan:entry.pan,muted:entry.muted,restorationEnabled:entry.restorationEnabled,sampleRate:8000,channels:2,frames:800}})),'vocal-instrumental');
 expect(mixed.report.attenuationDb).toBeLessThan(0);expect(mixed.report.tracks.every(track=>track.analysis.clippedSamples===0)).toBe(true);
 expect(mixed.analysis.clippedSamples).toBe(0);
 input.sources={a:{audio:mixed.audio,result:mixed.analysis,name:'Peak protected STEM mix',stemMix:mixed.report}};
 input.stems=entries;input.committedStemInputs=entries;input.committedStemStudio=undefined;input.committedStemOptions=undefined;input.selected='a';input.matched=false;
 const restored=await restoreProjectSession(await archive(input),{inspect});
 expect(restored.sources.a!.stemMix!.attenuationDb).toBe(mixed.report.attenuationDb);
 expect(restored.sources.a!.audio!.channels).toEqual(mixed.audio.channels);
 for(let index=0;index<entries.length;index++){
  expect(new Uint8Array(await restored.stems[index].file.arrayBuffer())).toEqual(new Uint8Array(wavBytes[index]));
  expect(materials[index].channels).toEqual(originalSamples[index]);
 }
});

it('rejects positive or out-of-range STEM attenuation before saving or hydrating',async()=>{
 for(const attenuation of [.01,2,NaN,Infinity,-120.01]){const input=fixture();input.sources.a!.stemMix!.attenuationDb=attenuation;
  expect(()=>captureProjectSession(input)).toThrow('ピーク保護ゲイン');}
 const imported=await archive();((imported.manifest.state.sources as {a:{mix:{attenuationDb:number}}}).a.mix).attenuationDb=2;let calls=0;
 await expect(restoreProjectSession(imported,{async inspect(value,options){calls++;return inspect(value,options);}})).rejects.toThrow('保存STEMレポート');
 expect(calls).toBe(0);
});
