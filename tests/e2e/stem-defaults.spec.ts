import {expect,test,type Page} from '@playwright/test';
import {createHash} from 'node:crypto';
import {tone,wav} from '../helpers/audio';

type RequestSnapshot={kind:string;studio:{restore:boolean;doubleAmount:number;doubleMs:number;stabilize?:unknown}|null;
 clarity:boolean;vocalSupport:boolean;reference:boolean;roles:string[]};
type Observation={requests:RequestSnapshot[];files:File[]};
const materials=()=>[['Guitar.wav',440],['Bass.wav',110],['Drums.wav',180]] .map(([name,frequency])=>({
 name:String(name),mimeType:'audio/wav',buffer:Buffer.from(wav(tone({sampleRate:48000,seconds:3,frequency:Number(frequency),amplitude:.05}),32,true)),
}));
async function observe(page:Page){
 await page.addInitScript(()=>{
  const state={requests:[] as unknown[],files:[] as File[]};Object.defineProperty(window,'__stemDefaults',{value:state});
  const post=Worker.prototype.postMessage;
  Worker.prototype.postMessage=function(message:unknown,options?:Transferable[]|StructuredSerializeOptions){
   const request=message as {kind?:string;studio?:unknown;clarity?:boolean;vocalSupport?:boolean;reference?:File;tracks?:{role:string;file:File}[]};
   if(['file-stems','stems-import'].includes(request?.kind??'')&&request.tracks){
    state.requests.push({kind:request.kind,studio:request.studio?structuredClone(request.studio):null,clarity:!!request.clarity,
     vocalSupport:!!request.vocalSupport,reference:!!request.reference,roles:request.tracks.map(track=>track.role)});
    state.files=request.tracks.map(track=>track.file);
   }
   Reflect.apply(post,this,options===undefined?[message]:[message,options]);
  };
 });
}
async function request(page:Page){return page.evaluate(()=>(window as unknown as {__stemDefaults:Observation}).__stemDefaults.requests.at(-1)!);}
async function pair(page:Page){return Promise.all(['a-name','b-name','a-lufs','b-lufs'].map(id=>page.locator('#'+id).innerText()));}

test('STEM options start open and enabled, reach the real Worker and protect original files',async({page})=>{
 await observe(page);await page.goto('/');
 for(const id of ['stem-auto-options','stem-studio-controls'])await expect(page.locator('#'+id)).toHaveJSProperty('open',true);
 for(const id of ['stem-multitrack-auto','stem-vocal-support','studio-restore','guitar-double'])await expect(page.locator('#'+id)).toBeChecked();
 await expect(page.locator('#stem-stabilize')).not.toBeChecked();await expect(page.locator('#stem-reference')).toHaveValue('');
 const originals=materials();await page.locator('#stem-file-input').setInputFiles(originals);
 await expect(page.locator('#stem-status')).toContainText('3素材を読み込み');await expect(page.locator('#stem-track-list .stem-track')).toHaveCount(3);
 const sent=await request(page);expect(sent.kind).toBe('file-stems');expect(sent.studio).toMatchObject({restore:true,doubleAmount:65,doubleMs:30});
 expect(sent.clarity).toBe(true);expect(sent.vocalSupport).toBe(true);expect(sent.reference).toBe(false);expect(sent.studio?.stabilize).toBeUndefined();
 expect(sent.roles).toEqual(['guitar','bass','drums']);await expect(page.locator('#stem-status')).toContainText('ギター1素材にHuman Double');
 await expect(page.locator('#stem-status')).toContainText('素材ファイルは保持しています');await expect(page.locator('#clipped')).toHaveText('0');
 const hashes=await page.evaluate(async()=>Promise.all((window as unknown as {__stemDefaults:Observation}).__stemDefaults.files.map(async file=>{
  const digest=await crypto.subtle.digest('SHA-256',await file.arrayBuffer());return [...new Uint8Array(digest)].map(byte=>byte.toString(16).padStart(2,'0')).join('');
 })));
 expect(hashes).toEqual(originals.map(file=>createHash('sha256').update(file.buffer).digest('hex')));
 for(const original of originals)await expect(page.getByRole('button',{name:original.name+' だけを聴く',exact:true})).toBeEnabled();
 await expect(page.locator('#error')).toBeHidden();
});

test('turning the defaults off survives closing the panels and selects the unprocessed STEM import path',async({page})=>{
 await observe(page);await page.goto('/');
 for(const id of ['stem-multitrack-auto','stem-vocal-support','studio-restore','guitar-double'])await page.locator('#'+id).uncheck();
 for(const id of ['stem-auto-options','stem-studio-controls']){
  await page.locator('#'+id+' > summary').click();await expect(page.locator('#'+id)).toHaveJSProperty('open',false);
  await page.locator('#'+id+' > summary').click();await expect(page.locator('#'+id)).toHaveJSProperty('open',true);
 }
 for(const id of ['stem-multitrack-auto','stem-vocal-support','studio-restore','guitar-double'])await expect(page.locator('#'+id)).not.toBeChecked();
 await page.locator('#stem-file-input').setInputFiles(materials());await expect(page.locator('#stem-status')).toContainText('3素材を読み込み');
 const sent=await request(page);expect(sent.kind).toBe('stems-import');expect(sent.studio).toBeNull();expect(sent.clarity).toBe(false);expect(sent.vocalSupport).toBe(false);
 await expect(page.locator('#stem-status')).not.toContainText('Human Double');await expect(page.locator('#stem-track-list')).not.toContainText('ジャリつき補修');
});

test('failed and cancelled imports with the new defaults retain the existing Original and Processed pair',async({page})=>{
 await page.goto('/');await page.locator('#demo-button').click();await expect(page.locator('#mode-AUTO')).toBeEnabled();await page.locator('#mode-AUTO').click();
 await expect(page.locator('#finish-explanation')).toContainText('候補を用意しました');const before=await pair(page);
 await page.locator('#stem-file-input').setInputFiles([materials()[0],{name:'broken.wav',mimeType:'audio/wav',buffer:Buffer.from('invalid WAV')}]);
 await expect(page.locator('#stem-status')).toContainText('読み込めませんでした');expect(await pair(page)).toEqual(before);await expect(page.locator('#select-b')).toBeEnabled();
 await page.locator('#stem-clear').click();
 let release!:()=>void,entered!:()=>void,handled!:()=>void;
 const gate=new Promise<void>(resolve=>{release=resolve;}),arrived=new Promise<void>(resolve=>{entered=resolve;}),completed=new Promise<void>(resolve=>{handled=resolve;});
 await page.route('**/workers.json',async route=>{entered();await gate;try{await route.continue();}finally{handled();}});
 try{
  await page.locator('#stem-file-input').setInputFiles(materials());await arrived;await expect(page.locator('#processing-overlay')).toBeVisible();
  await page.locator('#cancel-button').click();release();await completed;await expect(page.locator('#processing-overlay')).toBeHidden();
  await expect(page.locator('#stem-status')).toContainText('キャンセル');expect(await pair(page)).toEqual(before);await expect(page.locator('#select-b')).toBeEnabled();
 }finally{release();await completed;await page.unroute('**/workers.json');}
});
