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
 expect(restored.stemOrigins).toEqual(new Map()); // Schema-v1 sessions without per-material provenance stay compatible.
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

it('preserves independent staged-song origins while A/B and a different committed mix remain unchanged',async()=>{
 const input=fixture(),oldOriginal=input.sources.a!.originalFile!,newOriginal=new File([encodeFloatWav(audio(.21))],'independent-song.wav',{type:'audio/wav'});
 const pending=input.stems.map((entry,index)=>({...entry,id:'pending-'+index,
  // Identical names must not confuse a pending material with the committed one.
  file:new File([encodeFloatWav(audio(.03*(index+1)))],entry.file.name,{type:'audio/wav'})}));
 input.stems=pending;input.stemOrigins=new Map([
  ...pending.map(entry=>[entry.file,newOriginal] as const),
  ...input.committedStemInputs.map(entry=>[entry.file,oldOriginal] as const),
 ]);
 const captured=captureProjectSession(input),saved=captured.manifest.state as unknown as {stems:{original:string}[];committed:{original:string}[]};
 expect(captured.assets.filter(asset=>asset.file===newOriginal)).toHaveLength(1);
 expect(saved.stems[0].original).toBe(saved.stems[1].original);
 expect(saved.stems[0].original).not.toBe(saved.committed[0].original);
 const inspectedFiles:File[]=[];
 const restored=await restoreProjectSession(await archive(input),{async inspect(value,options){
  if(value.kind==='file')inspectedFiles.push(value.file);return inspect(value,options);
 }});
 const restoredOriginal=restored.stemOrigins.get(restored.stems[0].file)!;
 expect(restored.sources.a!.name).toBe('原音A');expect(restored.sources.b!.name).toBe('仕上がりB');
 expect(restored.sources.a!.audio!.channels).toEqual(input.sources.a!.audio!.channels);
 expect(restoredOriginal.name).toBe('independent-song.wav');
 expect(restored.stemOrigins.get(restored.stems[1].file)).toBe(restoredOriginal);
 expect(restored.stemOrigins.get(restored.committedStemInputs[0].file)).toBe(restored.sources.a!.originalFile);
 expect(restored.stemOrigins.get(restored.committedStemInputs[1].file)).toBe(restored.sources.a!.originalFile);
 expect(restored.stems[0].file.name).toBe(restored.committedStemInputs[0].file.name);
 expect(restored.stems[0].file).not.toBe(restored.committedStemInputs[0].file);
 expect(restored.stemOrigins.size).toBe(4);
 expect(inspectedFiles.filter(file=>file===restoredOriginal)).toHaveLength(1);
 expect(new Uint8Array(await restoredOriginal.arrayBuffer())).toEqual(new Uint8Array(await newOriginal.arrayBuffer()));
});

it('retains per-material provenance through restore, a real STEM rebuild and a second save/restore',async()=>{
 const input=fixture(),original=new File([encodeFloatWav(audio(.19))],'full-source.wav',{type:'audio/wav'});
 delete input.sources.a!.stemMix;input.committedStemInputs=[];input.committedStemStudio=undefined;input.committedStemOptions=undefined;
 input.stemOrigins=new Map(input.stems.map(entry=>[entry.file,original]));
 const restored=await restoreProjectSession(await archive(input),{inspect});
 const rawBytes=await Promise.all(restored.stems.map(entry=>entry.file.arrayBuffer()));
 const tracks=await Promise.all(restored.stems.map(async entry=>{
  const material=decodeWav(await entry.file.arrayBuffer());
  return {audio:material,descriptor:{id:entry.id,name:entry.file.name,role:entry.role,gainDb:entry.gainDb,pan:entry.pan,
   muted:entry.muted,sampleRate:material.sampleRate,channels:material.channels.length,frames:material.channels[0].length}};
 }));
 const mixed=mixStems(tracks,restored.stemMode),restoredOriginal=restored.stemOrigins.get(restored.stems[0].file)!;
 restored.sources={a:{audio:mixed.audio,result:mixed.analysis,name:'Rebuilt A',stemMix:mixed.report,originalFile:restoredOriginal}};
 restored.committedStemInputs=restored.stems.map(entry=>({...entry}));restored.selected='a';restored.matched=false;
 const captured=captureProjectSession(restored),saved=captured.manifest.state as unknown as {
  sources:{a:{original:string}};stems:{original:string}[];committed:{original:string}[];
 };
 expect(saved.stems.every(entry=>entry.original===saved.sources.a.original)).toBe(true);
 expect(saved.committed.every(entry=>entry.original===saved.sources.a.original)).toBe(true);
 expect(captured.assets.filter(asset=>asset.file===restoredOriginal)).toHaveLength(1);
 const reopened=await restoreProjectSession(await archive(restored),{inspect});
 expect(reopened.sources.a!.name).toBe('Rebuilt A');expect(reopened.sources.b).toBeUndefined();
 expect(reopened.sources.a!.originalFile!.name).toBe('full-source.wav');expect(reopened.stemOrigins.size).toBe(2);
 for(let index=0;index<reopened.stems.length;index++){
  expect(reopened.stemOrigins.get(reopened.stems[index].file)).toBe(reopened.sources.a!.originalFile);
  expect(reopened.committedStemInputs[index].file).toBe(reopened.stems[index].file);
  expect(new Uint8Array(await reopened.stems[index].file.arrayBuffer())).toEqual(new Uint8Array(rawBytes[index]));
 }
 expect(new Uint8Array(await reopened.sources.a!.originalFile!.arrayBuffer())).toEqual(new Uint8Array(await original.arrayBuffer()));
});

it('uses exact material identity and excludes unrelated origin-map entries from the archive',()=>{
 const input=fixture(),unrelated=new File([encodeFloatWav(audio())],input.stems[0].file.name,{type:'audio/wav'});
 const privateOriginal=new File([encodeFloatWav(audio())],'unrelated-private-recording.wav',{type:'audio/wav'});
 input.stemOrigins=new Map([[unrelated,privateOriginal]]);
 const captured=captureProjectSession(input),saved=captured.manifest.state as unknown as {stems:{original?:string}[];committed:{original?:string}[]};
 expect(captured.manifest.assets).toHaveLength(7);
 expect(captured.manifest.assets.some(asset=>asset.name===privateOriginal.name)).toBe(false);
 expect([...saved.stems,...saved.committed].every(entry=>entry.original===undefined)).toBe(true);
});

it('rejects missing, malformed or non-audio origin references before any audio hydration',async()=>{
 for(const target of ['missing','cover','plane','empty','number'] as const){
  const input=fixture();input.stemOrigins=new Map([[input.stems[0].file,input.sources.a!.originalFile!]]);
  const imported=await archive(input),saved=imported.manifest.state as unknown as {stems:{original:unknown}[];sources:{a:{data:{planes:string[]}}}};
  saved.stems[0].original=target==='cover'?imported.manifest.assets.find(asset=>asset.mimeType==='image/png')!.id:
   target==='plane'?saved.sources.a.data.planes[0]:target==='empty'?'':target==='number'?42:'absent_asset';
  let calls=0;
  await expect(restoreProjectSession(imported,{async inspect(value,options){calls++;return inspect(value,options);}})).rejects.toThrow();
  expect(calls).toBe(0);
 }
});

it('rejects conflicting origins for one shared staged/committed material before hydration',async()=>{
 const input=fixture(),original=new File([encodeFloatWav(audio(.12))],'source.wav',{type:'audio/wav'});
 input.stemOrigins=new Map([[input.stems[0].file,original]]);
 const imported=await archive(input),saved=imported.manifest.state as unknown as {stems:{asset:string}[];committed:{original:string}[]};
 saved.committed[0].original=saved.stems[1].asset;let calls=0;
 await expect(restoreProjectSession(imported,{async inspect(value,options){calls++;return inspect(value,options);}})).rejects.toThrow('原曲が一致');
 expect(calls).toBe(0);
});

it('validates origin files on capture and re-analyzes purported audio rather than trusting its extension',async()=>{
 for(const invalid of [new File([],'empty.wav',{type:'audio/wav'}),new File(['text'],'notes.txt',{type:'text/plain'})]){
  const input=fixture();input.stemOrigins=new Map([[input.stems[0].file,invalid]]);
  expect(()=>captureProjectSession(input)).toThrow('WAV/FLAC');
 }
 const input=fixture(),before=input.sources.a!.audio!.channels[0].slice();
 input.stemOrigins=new Map([[input.stems[0].file,new File(['not an audio recording'],'forged.wav',{type:'audio/wav'})]]);
 let checkedOrigin=false;
 await expect(restoreProjectSession(await archive(input),{async inspect(value,options){
  if(value.kind==='file'&&value.file.name==='forged.wav')checkedOrigin=true;return inspect(value,options);
 }})).rejects.toThrow();
 expect(checkedOrigin).toBe(true);expect(input.sources.a!.audio!.channels[0]).toEqual(before);
});
