import {expect,test,type Page} from '@playwright/test';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {wav} from '../helpers/audio';

const rate=44100,frames=rate*12;
function musicalFixture(){
 const channels=[new Float32Array(frames),new Float32Array(frames)],frequencies=[40,110,280,650,1600,3300,7000,11000];
 const weights=[.06,.18,.14,.17,.18,.13,.10,.04];let seed=173;
 for(let frame=0;frame<frames;frame++){
  const time=frame/rate,beat=time%.5,envelope=(.7+.1*Math.sin(2*Math.PI*time*.7))*Math.min(1,time/.03,(12-time)/.08);
  let mid=0,side=0;
  for(let band=0;band<frequencies.length;band++){
   const level=Math.sqrt(weights[band])*.13;
   mid+=level*Math.sin(2*Math.PI*frequencies[band]*time+band*.47);
   side+=level*Math.sin(2*Math.PI*(frequencies[band]+7)*time+band*.73);
  }
  seed=(Math.imul(seed,1664525)+1013904223)>>>0;
  const kick=.012*Math.exp(-beat*35)*Math.sin(2*Math.PI*65*beat),hat=(seed/2**32-.5)*.006*Math.exp(-beat*110);
  channels[0][frame]=envelope*(mid+side*.15+kick+hat);
  channels[1][frame]=envelope*(mid-side*.15+kick-hat);
 }
 return {sampleRate:rate,channels};
}
async function pair(page:Page){return Promise.all(['a-name','b-name','a-lufs','b-lufs'].map(id=>page.locator('#'+id).innerText()));}
interface CapturedInput {file:File;segments:number}
async function originalHash(page:Page){return page.evaluate(async()=>{
 const input=(window as unknown as {__realSeparationInputs:CapturedInput[]}).__realSeparationInputs[0];
 const digest=await crypto.subtle.digest('SHA-256',await input.file.arrayBuffer());
 return {hash:[...new Uint8Array(digest)].map(value=>value.toString(16).padStart(2,'0')).join(''),segments:input.segments};
});}
function accumulateFloatWav(bytes:Buffer,sum:Float64Array[]){
 expect(bytes.toString('ascii',0,4)).toBe('RIFF');expect(bytes.toString('ascii',8,12)).toBe('WAVE');
 let data=-1,length=0,format=0,channels=0,sampleRate=0,bits=0;
 for(let offset=12;offset+8<=bytes.length;){
  const size=bytes.readUInt32LE(offset+4),start=offset+8;expect(start+size).toBeLessThanOrEqual(bytes.length);
  const tag=bytes.toString('ascii',offset,offset+4);
  if(tag==='fmt '){format=bytes.readUInt16LE(start);channels=bytes.readUInt16LE(start+2);sampleRate=bytes.readUInt32LE(start+4);bits=bytes.readUInt16LE(start+14);}
  if(tag==='data'){data=start;length=size;}
  offset=start+size+(size&1);
 }
 expect(format).toBe(3);expect(bits).toBe(32);expect(channels).toBe(2);expect(sampleRate).toBe(rate);
 expect(data).toBeGreaterThanOrEqual(44);expect(length/8).toBe(frames);expect(bytes.length).toBe(56+frames*8);
 let finite=true;
 for(let frame=0;frame<frames;frame++)for(let channel=0;channel<2;channel++){
  const sample=bytes.readFloatLE(data+frame*8+channel*4);finite&&=Number.isFinite(sample);sum[channel][frame]+=sample;
 }
 expect(finite).toBe(true);
}

test('real local SCNet separates a two-window song, preserves A/B and keeps staged WAVs after clearing the panel',async({page,context})=>{
 // Real single-thread CPU/WASM inference runs two 11-second windows, roughly 20 s each plus model/IO overhead.
 test.setTimeout(180000);
 const errors:string[]=[],external:string[]=[],uploads:string[]=[],models:string[]=[];
 const origin=new URL(String(test.info().project.use.baseURL??'http://127.0.0.1:4173')).origin;
 page.on('pageerror',error=>errors.push(error.message));
 context.on('request',request=>{
  const url=request.url();if(/^https?:/.test(url)&&new URL(url).origin!==origin)external.push(url);
  if(!['GET','HEAD'].includes(request.method()))uploads.push(request.method()+' '+url);
  if(/\/models\/scnet-small\/.*\.onnx(?:\?|$)/.test(url))models.push(url);
 });
 // Timer control expires completed downloads' grace leases later; model code/network are never replaced.
 await page.clock.install();await page.clock.resume();
 await page.addInitScript(()=>{
  const inputs:CapturedInput[]=[];Object.defineProperty(window,'__realSeparationInputs',{value:inputs});
  const post=Worker.prototype.postMessage;
  Worker.prototype.postMessage=function(message:unknown,options?:Transferable[]|StructuredSerializeOptions){
   const request=message as {kind?:string;file?:File;plan?:{starts?:number[]}};
   if(request?.kind==='separate'&&request.file instanceof File)inputs.push({file:request.file,segments:request.plan?.starts?.length??0});
   Reflect.apply(post,this,options===undefined?[message]:[message,options]);
  };
 });
 const source=musicalFixture(),buffer=Buffer.from(wav(source,32,true)),expectedHash=createHash('sha256').update(buffer).digest('hex');
 await page.goto('/');await page.locator('#file-input').setInputFiles({name:'local-synthetic-12s.wav',mimeType:'audio/wav',buffer});
 await expect(page.locator('#mode-AUTO')).toBeEnabled();await page.locator('#mode-AUTO').click();
 await expect(page.locator('#finish-explanation')).toContainText('候補を用意しました',{timeout:30000});const before=await pair(page);
 await page.locator('#separation-panel > summary').click();await expect(page.locator('#separation-mode')).toHaveValue('four');
 await expect(page.locator('#separation-source-name')).toContainText('local-synthetic-12s.wav');await expect(page.locator('#separation-run')).toBeEnabled();
 await page.locator('#separation-run').click();
 const rows=page.locator('#separation-results .separation-track');await expect(rows).toHaveCount(4,{timeout:150000});
 await expect(page.locator('#processing-overlay')).toBeHidden();await expect(page.locator('#separation-status')).toContainText('4素材に分離しました');
 expect(await rows.evaluateAll(elements=>elements.map(element=>(element as HTMLElement).dataset.stemId))).toEqual(['vocals','drums','bass','other']);
 expect(await pair(page)).toEqual(before);await expect(page.locator('#select-b')).toBeEnabled();await expect(page.locator('#match-toggle')).toBeChecked();
 expect(await originalHash(page)).toEqual({hash:expectedHash,segments:2});expect(models.length).toBeGreaterThan(0);
 const summed=[new Float64Array(frames),new Float64Array(frames)];
 for(const target of ['vocals','drums','bass','other']){
  const downloaded=page.waitForEvent('download');await page.locator(`.separation-track[data-stem-id="${target}"]`).getByRole('button',{name:/WAV保存/}).click();
  const saved=await downloaded;expect(saved.suggestedFilename()).toBe(`local-synthetic-12s_${target}.wav`);
  accumulateFloatWav(await readFile((await saved.path())!),summed);
 }
 // Residual folding plus overlap-add should reconstruct the mix. This is functional coverage, not SDR or musical-quality evidence.
 let difference=0;
 for(let channel=0;channel<2;channel++)for(let frame=0;frame<frames;frame++)difference+=(summed[channel][frame]-source.channels[channel][frame])**2;
 expect(Math.sqrt(difference/(frames*2))).toBeLessThan(1e-5);
 // Remove independent download leases before exercising the STEM workspace's ownership.
 await page.clock.fastForward(61000);
 await page.locator('#separation-stage').click();await expect(page.locator('#stem-track-list .stem-track')).toHaveCount(4);
 expect(await pair(page)).toEqual(before);
 await page.locator('#separation-clear').click();await expect(rows).toHaveCount(0);expect(await pair(page)).toEqual(before);
 await expect(page.locator('#studio-restore')).toBeChecked();await expect(page.locator('#guitar-double')).toBeChecked();
 await page.locator('#stem-render').click();await expect(page.locator('#stem-status')).toContainText('4素材を読み込み',{timeout:30000});
 await expect(page.locator('#select-b')).toBeDisabled();await expect(page.locator('#a-name')).toContainText('STEM Mix');
 await page.locator('#stem-track-list .stem-track').first().getByRole('button',{name:/だけを聴く$/}).click();
 await expect(page.locator('#stem-solo-dialog')).toBeVisible();await expect(page.locator('#stem-solo-play')).toHaveText('一時停止');
 await expect(page.locator('#stem-solo-description')).toContainText(/元の素材|補修前/);await page.locator('#stem-solo-close').click();
 await page.locator('#stem-render').click();await expect(page.locator('#stem-status')).toContainText('4素材を読み込み',{timeout:30000});
 expect(await originalHash(page)).toEqual({hash:expectedHash,segments:2});
 await expect(page.locator('#separation-run')).toBeEnabled();await expect(page.locator('#separation-source-name')).toContainText('local-synthetic-12s.wav');
 await expect(page.locator('#error')).toBeHidden();expect(errors).toEqual([]);expect(external).toEqual([]);expect(uploads).toEqual([]);
});
