import { expect, it } from 'vitest';
import { Zip, ZipPassThrough, strToU8, zipSync } from 'fflate';
import { exportProject, importProject, validateProjectManifest, PROJECT_ARCHIVE_LIMITS,
  type ProjectManifest } from '../../apps/web/src/project-archive';

function fixture(data = Uint8Array.from({length:150021},(_,i)=>i%251)) {
  const image = new Uint8Array([137,80,78,71,13,10,26,10]);
  const manifest:ProjectManifest = {format:'music-sync-project',version:1,createdAt:'2026-11-10T01:02:03.000Z',
    name:'日本語のミックス',assets:[
      {id:'voice',path:'assets/voice.bin',name:'0 主旋律.wav',mimeType:'audio/wav',size:data.length},
      {id:'cover',path:'assets/cover.bin',name:'ジャケット.png',mimeType:'image/png',size:image.length},
    ],state:{controls:{output:'youtube',enabled:true,amount:35},stems:[{id:'voice',repair:false}],text:'始めから再開'} };
  return {manifest,assets:[{id:'voice',file:new Blob([data])},{id:'cover',file:new Blob([image])}],data,image};
}
const file = (data:BlobPart|Blob)=>new File([data],'session.musicsync.zip',{type:'application/zip'});
async function encoded(f=fixture()){return (await exportProject(f.manifest,f.assets))!;}
function records(data:Uint8Array) {
  const view=new DataView(data.buffer,data.byteOffset,data.byteLength),end=data.length-22;
  const list:number[]=[];let at=view.getUint32(end+16,true);
  for(let i=0;i<view.getUint16(end+10,true);i++){
    list.push(at);at+=46+view.getUint16(at+28,true)+view.getUint16(at+30,true)+view.getUint16(at+32,true);
  }
  return {view,list,end};
}
function streamed(entries:[string,Uint8Array][]) {
  const chunks:Uint8Array[]=[];
  const zip=new Zip((error,data)=>{if(error)throw error;chunks.push(data.slice());});
  for(const [name,bytes] of entries){const part=new ZipPassThrough(name);zip.add(part);part.push(bytes,true);}
  zip.end();return new Blob(chunks as Uint8Array<ArrayBuffer>[]);
}

it('round-trips Unicode material names, JSON settings and exact files independently of caller asset ordering',async()=>{
  const f=fixture(),before=JSON.stringify(f.manifest),saved=f.data.slice();
  const output=await exportProject(f.manifest,[...f.assets].reverse());
  const result=await importProject(file(output!));
  expect(result.manifest).toEqual(f.manifest);expect(JSON.stringify(f.manifest)).toBe(before);
  expect(result.assets.size).toBe(2);expect(result.assets.get('voice')!.name).toBe('0 主旋律.wav');
  expect(result.assets.get('voice')!.type).toBe('audio/wav');
  expect(new Uint8Array(await result.assets.get('voice')!.arrayBuffer())).toEqual(saved);
  expect(new Uint8Array(await result.assets.get('cover')!.arrayBuffer())).toEqual(f.image);
  expect(f.data).toEqual(saved);
});

it('writes identical bytes through an awaited streaming sink and keeps writes sequential',async()=>{
  const f=fixture(),parts:BlobPart[]=[];let active=false,maxChunk=0,writes=0;
  const result=await exportProject(f.manifest,f.assets,{async write(chunk){
    expect(active).toBe(false);active=true;await Promise.resolve();
    maxChunk=Math.max(maxChunk,chunk.length);parts.push(chunk.slice().buffer as ArrayBuffer);writes++;active=false;
  }});
  expect(result).toBeUndefined();expect(writes).toBeGreaterThan(3);expect(maxChunk).toBeLessThanOrEqual(65536);
  const buffered=await encoded(f);
  expect(new Uint8Array(await new Blob(parts).arrayBuffer())).toEqual(new Uint8Array(await buffered.arrayBuffer()));
});

it('rejects corrupted material CRCs, truncated ZIPs, conflicting headers and overlapping entries',async()=>{
  const original=new Uint8Array(await (await encoded()).arrayBuffer());
  const bad=original.slice(),indexed=records(bad),entry=indexed.list[1];
  const local=indexed.view.getUint32(entry+42,true);
  const start=local+30+indexed.view.getUint16(local+26,true)+indexed.view.getUint16(local+28,true);
  bad[start+12]^=1;
  await expect(importProject(file(bad))).rejects.toThrow('CRC');
  await expect(importProject(file(original.slice(0,-5)))).rejects.toThrow();
  const conflict=original.slice(),headers=records(conflict);headers.view.setUint16(local+8,8,true);
  await expect(importProject(file(conflict))).rejects.toThrow();
  const overlap=original.slice(),map=records(overlap);map.view.setUint32(map.list[1]+42,0,true);
  await expect(importProject(file(overlap))).rejects.toThrow();
});

it('rejects traversal paths, duplicate names, extra files, compression, encryption and ZIP64 metadata',async()=>{
  const f=fixture(new Uint8Array([1,2,3])),manifest=strToU8(JSON.stringify(f.manifest));
  const base:[string,Uint8Array][]=[['manifest.json',manifest],['assets/voice.bin',f.data],['assets/cover.bin',f.image]];
  await expect(importProject(file(streamed([...base,['../unsafe.bin',new Uint8Array([1])]])))).rejects.toThrow();
  await expect(importProject(file(streamed([...base,['assets/voice.bin',f.data]])))).rejects.toThrow();
  await expect(importProject(file(streamed([...base,['assets/extra.bin',f.data]])))).rejects.toThrow();
  const compressed=zipSync(Object.fromEntries(base));
  await expect(importProject(file(compressed))).rejects.toThrow();
  const bytes=new Uint8Array(await streamed(base).arrayBuffer()),encrypted=bytes.slice(),meta=records(encrypted);
  meta.view.setUint16(meta.list[0]+8,1,true);
  await expect(importProject(file(encrypted))).rejects.toThrow();
  const zip64=bytes.slice(),z=records(zip64);z.view.setUint32(z.end+16,0xffffffff,true);
  await expect(importProject(file(zip64))).rejects.toThrow();
});

it('validates manifest domain, safe JSON, MIME/IDs, duplicate assets and allocation budgets before saving',async()=>{
  const f=fixture(new Uint8Array([1,2,3]));
  for(const invalid of [
    {...f.manifest,version:2}, {...f.manifest,state:{value:Infinity}},
    {...f.manifest,state:JSON.parse('{"__proto__":{"polluted":true}}')},
    {...f.manifest,state:{nested:{constructor:{}}}},
    {...f.manifest,assets:[{...f.manifest.assets[0],path:'../voice.bin'}]},
    {...f.manifest,assets:[{...f.manifest.assets[0],mimeType:'text/html'}]},
    {...f.manifest,assets:[{...f.manifest.assets[0],size:PROJECT_ARCHIVE_LIMITS.assetBytes+1}]},
    {...f.manifest,assets:[f.manifest.assets[0],f.manifest.assets[0]]},
  ])expect(()=>validateProjectManifest(invalid)).toThrow();
  await expect(exportProject(f.manifest,[f.assets[0],f.assets[0]])).rejects.toThrow();
  await expect(exportProject(f.manifest,[{id:'voice',file:new Blob()},f.assets[1]])).rejects.toThrow();
  class LargeBlob extends Blob {get size(){return 260*1024**2;}}
  const huge={...f.manifest,assets:[{...f.manifest.assets[0],size:260*1024**2}]};
  await expect(exportProject(huge,[{id:'voice',file:new LargeBlob()}])).rejects.toThrow('一時保存');
});

it('rejects a valid ZIP whose settings describe missing or differently sized material',async()=>{
  const f=fixture(new Uint8Array([1,2,3]));
  const zip=(manifest:ProjectManifest)=>zipSync({'manifest.json':strToU8(JSON.stringify(manifest)),
    'assets/voice.bin':f.data,'assets/cover.bin':f.image},{level:0});
  await expect(importProject(file(zip({...f.manifest,assets:f.manifest.assets.slice(0,1)})))).rejects.toThrow();
  await expect(importProject(file(zip({...f.manifest,assets:[{...f.manifest.assets[0],size:4},f.manifest.assets[1]]})))).rejects.toThrow('サイズ');
});

it('cancels streamed export/import between bounded chunks and never returns a partial project',async()=>{
  const f=fixture(),cancel=new AbortController();let writes=0;
  await expect(exportProject(f.manifest,f.assets,{signal:cancel.signal,async write(){writes++;},progress(){cancel.abort();}})).rejects.toThrow();
  expect(writes).toBeGreaterThan(0);
  const saved=file(await encoded(f)),reading=new AbortController();
  await expect(importProject(saved,{signal:reading.signal,progress(){reading.abort();}})).rejects.toThrow();
  const early=new AbortController();early.abort();
  await expect(exportProject(f.manifest,f.assets,{signal:early.signal})).rejects.toThrow();
  await expect(importProject(saved,{signal:early.signal})).rejects.toThrow();
});

it('imports using bounded slices rather than reading full asset/archive buffers',async()=>{
  const f=fixture(new Uint8Array(400000)),archive=await encoded(f),sizes:number[]=[];
  class ObservedFile extends File {
    slice(start?:number,end?:number,type?:string){
      const part=super.slice(start,end,type),read=part.arrayBuffer.bind(part);
      part.arrayBuffer=()=>{sizes.push(part.size);return read();};return part;
    }
    arrayBuffer():Promise<ArrayBuffer>{throw new Error('Full archive allocation is prohibited');}
  }
  const restored=await importProject(new ObservedFile([archive],'session.zip'));
  expect(restored.assets.get('voice')!.size).toBe(400000);
  expect(Math.max(...sizes)).toBeLessThanOrEqual(65557);
});
