import {expect,test,type Page} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {wav} from '../helpers/audio';

const rate=44100,frames=rate*2,drumIds=['kick','snare','hh','toms','percussion','remaining-drums'];
const detailedIds=['vocals','bass','other',...drumIds];
function percussiveFixture(){
 const channels=[new Float32Array(frames),new Float32Array(frames)];let seed=271,low=0;
 for(let frame=0;frame<frames;frame++){
  const time=frame/rate,beat=time%.5,snare=(time+.25)%.5,hat=time%.125,perc=time%(1/3);
  seed=(Math.imul(seed,1664525)+1013904223)>>>0;const noise=seed/2**32-.5;low+=.12*(noise-low);const high=noise-low;
  const kick=.16*Math.exp(-beat*35)*Math.sin(2*Math.PI*(48*beat+2*(1-Math.exp(-beat*35))));
  const hit=.12*Math.exp(-snare*35)*high,hh=.055*Math.exp(-hat*130)*high;
  const tom=time>1.5?.065*Math.exp(-(time-1.5)*18)*Math.sin(2*Math.PI*150*(time-1.5)):0;
  const percussion=.025*Math.exp(-perc*65)*Math.sin(2*Math.PI*700*perc),shimmer=.014*Math.exp(-beat*7)*high;
  const fade=Math.min(1,time/.003,(2-time)/.015);
  channels[0][frame]=fade*(kick+hit+hh+tom+percussion+shimmer);
  channels[1][frame]=fade*(kick+hit*.97+hh*.8+tom+percussion*.85-shimmer);
 }
 return {sampleRate:rate,channels};
}
const input=(name:string)=>({name,mimeType:'audio/wav',buffer:Buffer.from(wav(percussiveFixture(),32,true))});
async function pair(page:Page){return Promise.all(['a-name','b-name','a-lufs','b-lufs'].map(id=>page.locator('#'+id).innerText()));}
async function priorCandidate(page:Page){
 await page.goto('/');await page.locator('#demo-button').click();await expect(page.locator('#mode-AUTO')).toBeEnabled();await page.locator('#mode-AUTO').click();
 await expect(page.locator('#finish-explanation')).toContainText('候補を用意しました');await page.locator('#separation-panel > summary').click();
}
async function resultIds(page:Page){return page.locator('.separation-track').evaluateAll(elements=>elements.map(element=>(element as HTMLElement).dataset.stemId));}
function addFloatWav(bytes:Buffer,sum:Float64Array[]){
 expect(bytes.toString('ascii',0,4)).toBe('RIFF');expect(bytes.toString('ascii',8,12)).toBe('WAVE');
 let data=-1,length=0;
 for(let offset=12;offset+8<=bytes.length;){
  const tag=bytes.toString('ascii',offset,offset+4),size=bytes.readUInt32LE(offset+4),start=offset+8;expect(start+size).toBeLessThanOrEqual(bytes.length);
  if(tag==='fmt '){expect(bytes.readUInt16LE(start)).toBe(3);expect(bytes.readUInt16LE(start+2)).toBe(2);expect(bytes.readUInt32LE(start+4)).toBe(rate);expect(bytes.readUInt16LE(start+14)).toBe(32);}
  if(tag==='data'){data=start;length=size;}offset=start+size+(size&1);
 }
 expect(data).toBe(56);expect(length/8).toBe(frames);expect(bytes.length).toBe(56+frames*8);let finite=true;
 for(let frame=0;frame<frames;frame++)for(let channel=0;channel<2;channel++){
  const value=bytes.readFloatLE(data+frame*8+channel*4);finite&&=Number.isFinite(value);sum[channel][frame]+=value;
 }
 expect(finite).toBe(true);
}

test('REAL Mega53 separates a two-second drum recording into six honest parts without replacing A/B',async({page,context})=>{
 // The real model evaluates a fixed roughly three-second window; CPU/WASM takes about 45 s plus loading/IO.
 test.setTimeout(180000);
 const errors:string[]=[],external:string[]=[],uploads:string[]=[],models:string[]=[];
 const origin=new URL(String(test.info().project.use.baseURL??'http://127.0.0.1:4173')).origin;
 page.on('pageerror',error=>errors.push(error.message));context.on('request',request=>{
  const url=request.url();if(/^https?:/.test(url)&&new URL(url).origin!==origin)external.push(url);
  if(!['GET','HEAD'].includes(request.method()))uploads.push(request.method()+' '+url);
  if(/\/models\/mega53-drums\/mega53-drums-2044dee8\.int8\.onnx(?:\?|$)/.test(url))models.push(url);
 });
 await priorCandidate(page);const before=await pair(page),source=percussiveFixture();
 await page.locator('#separation-input').setInputFiles(input('synthetic-drums-2s.wav'));await page.locator('#separation-mode').selectOption('drums');
 await page.locator('#separation-run').click();await expect(page.locator('.separation-track')).toHaveCount(6,{timeout:150000});
 await expect(page.locator('#processing-overlay')).toBeHidden();expect(await resultIds(page)).toEqual(drumIds);expect(await pair(page)).toEqual(before);
 const remaining=page.locator('.separation-track[data-stem-id="remaining-drums"] strong');
 await expect(remaining).toContainText(/残り|remaining/i);await expect(remaining).not.toHaveText(/^(?:シンバル|cymbals?)$/i);
 const sum=[new Float64Array(frames),new Float64Array(frames)];
 for(const id of drumIds){const pending=page.waitForEvent('download');await page.locator(`.separation-track[data-stem-id="${id}"]`).getByRole('button',{name:/WAV保存/}).click();
  const saved=await pending;expect(saved.suggestedFilename()).toBe('synthetic-drums-2s_'+id+'.wav');addFloatWav(await readFile((await saved.path())!),sum);}
 let error=0;for(let channel=0;channel<2;channel++)for(let frame=0;frame<frames;frame++)error+=(sum[channel][frame]-source.channels[channel][frame])**2;
 // Functional file/reconstruction coverage only: no nonzero-part, SDR or subjective separation-quality claim.
 expect(Math.sqrt(error/(frames*2))).toBeLessThan(1e-5);expect(models.length).toBeGreaterThan(0);
 expect(errors).toEqual([]);expect(external).toEqual([]);expect(uploads).toEqual([]);
});

// Explicit test double for the next two orchestration tests. It performs no neural inference.
// It writes genuine OPFS Float32 WAVs so the production client, lease handling and normal STEM mixer still run.
const mockWorker=String.raw`
async function audio(request){
 if(request.audio)return request.audio;
 const bytes=await request.file.arrayBuffer(),view=new DataView(bytes);let rate=0,count=0,bits=0,format=0,start=-1,size=0;
 const tag=offset=>String.fromCharCode(...new Uint8Array(bytes,offset,4));
 for(let offset=12;offset+8<=bytes.byteLength;){const length=view.getUint32(offset+4,true),data=offset+8;
  if(tag(offset)==='fmt '){format=view.getUint16(data,true);count=view.getUint16(data+2,true);rate=view.getUint32(data+4,true);bits=view.getUint16(data+14,true);}
  if(tag(offset)==='data'){start=data;size=length;}offset=data+length+(length&1);
 }
 if(format!==3||bits!==32||start<0)throw Error('Mock Worker expects Float32 WAV');
 const frames=size/(count*4),channels=Array.from({length:count},()=>new Float32Array(frames));
 for(let frame=0;frame<frames;frame++)for(let channel=0;channel<count;channel++)channels[channel][frame]=view.getFloat32(start+(frame*count+channel)*4,true);
 return {sampleRate:rate,channels};
}
function wav(source,gain){
 const frames=source.channels[0].length,bytes=new ArrayBuffer(56+frames*8),view=new DataView(bytes);
 const tag=(offset,text)=>{for(let i=0;i<text.length;i++)view.setUint8(offset+i,text.charCodeAt(i));};
 tag(0,'RIFF');view.setUint32(4,48+frames*8,true);tag(8,'WAVE');tag(12,'fmt ');view.setUint32(16,16,true);view.setUint16(20,3,true);
 view.setUint16(22,2,true);view.setUint32(24,source.sampleRate,true);view.setUint32(28,source.sampleRate*8,true);view.setUint16(32,8,true);view.setUint16(34,32,true);
 tag(36,'fact');view.setUint32(40,4,true);view.setUint32(44,frames,true);tag(48,'data');view.setUint32(52,frames*8,true);let peak=0;
 for(let frame=0;frame<frames;frame++)for(let channel=0;channel<2;channel++){
  const value=source.channels[Math.min(channel,source.channels.length-1)][frame]*gain;peak=Math.max(peak,Math.abs(value));view.setFloat32(56+(frame*2+channel)*4,value,true);
 }return {bytes,peak};
}
self.onmessage=event=>{void(async()=>{
 const request=event.data;if(request.kind!=='separate')throw Error('Unexpected mock request');
 const source=await audio(request),targets=request.plan.targets,targetPeaks={};let maxPeak=0;
 for(const target of targets){const rendered=wav(source,1/targets.length),stream=await request.destinations[target].createWritable();
  try{await stream.write(rendered.bytes);await stream.close();}catch(error){await stream.abort().catch(()=>{});throw error;}
  targetPeaks[target]=rendered.peak;maxPeak=Math.max(maxPeak,rendered.peak);
 }
 self.postMessage({type:'separation-result',report:{frames:source.channels[0].length,segments:request.plan.starts.length,maxPeak,targetPeaks,
  model:request.mode==='drums'?'Mega53 Drums':'SCNet',sampleRate:source.sampleRate,residualRmsRatio:0,backend:'wasm'}});
})().catch(error=>self.postMessage({type:'error',message:error.message}));};
`;
async function mockOrchestration(page:Page){
 const response=await page.request.get('/workers.json'),manifest=await response.json();
 let armed=false,lookups=0,entered=false,release!:()=>void,complete!:()=>void;
 const gate=new Promise<void>(resolve=>{release=resolve;}),handled=new Promise<void>(resolve=>{complete=resolve;});
 const url='**/assets/mock-drum-separation.worker.js';
 await page.route(url,route=>route.fulfill({status:200,contentType:'text/javascript',body:mockWorker}));
 await page.route('**/workers.json',async route=>{
  const held=armed&&++lookups===2;if(held){entered=true;await gate;}
  try{await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({...manifest,separation:'assets/mock-drum-separation.worker.js'})});}
  finally{if(held)complete();}
 });
 return {armSecond(){armed=true;lookups=0;},get entered(){return entered;},async release(){release();if(entered)await handled;},
  async close(){release();if(entered)await handled;await page.unroute('**/workers.json');await page.unroute(url);}};
}
async function candidates(page:Page){return page.evaluate(async()=>{
 const root=await navigator.storage.getDirectory();let folder:FileSystemDirectoryHandle;
 try{folder=await root.getDirectoryHandle('music-sync-candidates');}catch(error){if(error instanceof DOMException&&error.name==='NotFoundError')return [];throw error;}
 const names:string[]=[];for await(const name of (folder as FileSystemDirectoryHandle&{keys():AsyncIterable<string>}).keys())names.push(name);
 return names.sort();
});}

test('MOCK Worker orchestration replaces the coarse drum parent with six children and stages exactly nine parts',async({page})=>{
 await priorCandidate(page);const before=await pair(page),mock=await mockOrchestration(page);
 try{
  await page.locator('#separation-input').setInputFiles(input('mock-full-song.wav'));await page.locator('#separation-mode').selectOption('detailed');
  await page.locator('#separation-run').click();await expect(page.locator('.separation-track')).toHaveCount(9);
  await expect(page.locator('#processing-overlay')).toBeHidden();expect(await resultIds(page)).toEqual(detailedIds);
  await expect(page.locator('.separation-track[data-stem-id="drums"]')).toHaveCount(0);expect(await pair(page)).toEqual(before);
  await page.locator('#separation-stage').click();await expect(page.locator('#stem-track-list .stem-track')).toHaveCount(9);expect(await pair(page)).toEqual(before);
  const roles=await page.locator('#stem-track-list select[aria-label$=" の役割"]').evaluateAll(elements=>elements.map(element=>(element as HTMLSelectElement).value));
  expect(roles).toEqual(['vocal','bass','other',...drumIds.map(()=>'drums')]);
  await page.locator('#separation-clear').click();await expect(page.locator('.separation-track')).toHaveCount(0);expect(await pair(page)).toEqual(before);
  await page.locator('#stem-render').click();await expect(page.locator('#stem-status')).toContainText('9素材を読み込み',{timeout:30000});
  await expect(page.locator('#select-b')).toBeDisabled();await expect(page.locator('#a-name')).toContainText('9 tracks');
  await expect(page.locator('#separation-source-name')).toHaveText('現在のOriginalを分離：mock-full-song.wav');await expect(page.locator('#separation-run')).toBeEnabled();
 }finally{await mock.close();}
});

test('MOCK Worker phase-two cancellation removes provisional files and preserves prior results and A/B',async({page})=>{
 await priorCandidate(page);const before=await pair(page),mock=await mockOrchestration(page);
 try{
  await page.locator('#separation-input').setInputFiles(input('mock-old-result.wav'));await page.locator('#separation-mode').selectOption('four');await page.locator('#separation-run').click();
  await expect(page.locator('.separation-track')).toHaveCount(4);await expect(page.locator('#processing-overlay')).toBeHidden();
  const urls=await page.locator('.separation-track audio').evaluateAll(elements=>elements.map(element=>element.getAttribute('src'))),baseline=await candidates(page);
  expect(baseline.length).toBeGreaterThanOrEqual(5);mock.armSecond();
  await page.locator('#separation-mode').selectOption('detailed');await page.locator('#separation-run').click();await expect.poll(()=>mock.entered).toBe(true);
  await expect(page.locator('#processing-overlay')).toBeVisible();expect((await candidates(page)).length).toBeGreaterThan(baseline.length);
  await page.locator('#cancel-button').click();await mock.release();await expect(page.locator('#processing-overlay')).toBeHidden();
  await expect(page.locator('#separation-status')).toContainText('キャンセル');
  await expect.poll(()=>candidates(page),{timeout:10000}).toEqual(baseline);
  expect(await pair(page)).toEqual(before);expect(await resultIds(page)).toEqual(['vocals','drums','bass','other']);
  expect(await page.locator('.separation-track audio').evaluateAll(elements=>elements.map(element=>element.getAttribute('src')))).toEqual(urls);
  await expect(page.locator('#stem-track-list .stem-track')).toHaveCount(0);await expect(page.locator('#separation-stage')).toBeEnabled();await expect(page.locator('#select-b')).toBeEnabled();
 }finally{await mock.close();}
});
