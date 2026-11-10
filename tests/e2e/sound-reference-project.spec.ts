import {expect,test,type Page} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {strFromU8,strToU8,unzipSync,zipSync} from 'fflate';
import {wav} from '../helpers/audio';
import {perceptualFixture,type FixtureName} from '../fixtures/perceptual';

function music(name:string,fixture:FixtureName='balanced'){
 return {name,mimeType:'audio/wav',buffer:Buffer.from(wav(perceptualFixture(fixture),32,true))};
}
async function pair(page:Page){return Promise.all(['a-name','b-name','a-lufs','b-lufs'].map(id=>page.locator('#'+id).innerText()));}
async function referenceCalls(page:Page){return page.evaluate(()=>(window as unknown as {__savedReferenceCalls:string[]}).__savedReferenceCalls);}
async function reveal(page:Page,selector:string){await page.locator(selector).evaluate(element=>{for(let parent=element.parentElement;parent;parent=parent.parentElement)if(parent instanceof HTMLDetailsElement)parent.open=true;});}

test('project restores disabled reference strength by fresh analysis and rejects a damaged reference without replacing current A/B',async({page})=>{
 await page.addInitScript(()=>{
  const calls:string[]=[];Object.defineProperty(window,'__savedReferenceCalls',{value:calls});
  const post=Worker.prototype.postMessage;
  Worker.prototype.postMessage=function(message:unknown,options?:Transferable[]|StructuredSerializeOptions){
   const request=message as {reference?:unknown;file?:File};
   if(request?.reference===true)calls.push(request.file?.name??'PCM');
   Reflect.apply(post,this,options===undefined?[message]:[message,options]);
  };
 });
 await page.goto('/');await page.locator('#file-input').setInputFiles(music('session-main.wav','bass-heavy'));
 await expect(page.locator('#mode-AUTO')).toBeEnabled();await page.locator('#mode-AUTO').click();
 await expect(page.locator('#finish-explanation')).toContainText('候補を用意しました');
 await reveal(page,'#reference-input');
 await page.locator('#reference-input').setInputFiles(music('stored-reference.wav'));
 await expect(page.locator('#reference-status')).toContainText('解析が完了');
 await page.locator('#reference-strength').selectOption('0.35');await page.locator('#reference-enabled').uncheck();
 const before=await pair(page);await page.locator('#project-name').fill('Reference restoration');
 const pending=page.waitForEvent('download');await page.locator('#project-save').click();const saved=await pending;
 const entries=unzipSync(new Uint8Array(await readFile((await saved.path())!)));
 const manifest=JSON.parse(strFromU8(entries['manifest.json'])) as {assets:{id:string;path:string;size:number}[];
  state:{soundReference:{asset:string;strength:number;enabled:boolean}}};
 expect(Object.keys(manifest.state.soundReference).sort()).toEqual(['asset','enabled','strength']);
 expect(manifest.state.soundReference.strength).toBe(.35);expect(manifest.state.soundReference.enabled).toBe(false);
 await page.reload();await page.locator('#project-open').setInputFiles((await saved.path())!);
 await expect(page.locator('#project-status')).toContainText('プロジェクトを復元しました');
 await reveal(page,'#reference-input');
 await expect(page.locator('#reference-name')).toContainText('stored-reference.wav');await expect(page.locator('#reference-strength')).toHaveValue('0.35');
 await expect(page.locator('#reference-enabled')).not.toBeChecked();expect(await pair(page)).toEqual(before);
 expect(await referenceCalls(page)).toContain('stored-reference.wav');

 // A different live reference must survive a valid ZIP whose stored reference is no longer usable music.
 await page.locator('#reference-input').setInputFiles(music('current-reference.wav'));
 await expect(page.locator('#reference-name')).toContainText('current-reference.wav');await expect(page.locator('#processing-overlay')).toBeHidden();
 await page.locator('#reference-strength').selectOption('1');await page.locator('#reference-enabled').check();
 const source=manifest.assets.find(asset=>asset.id===manifest.state.soundReference.asset)!;
 const silent=wav({sampleRate:24000,channels:[new Float32Array(96000),new Float32Array(96000)]},32,true);
 expect(silent.byteLength).toBe(source.size);entries[source.path]=new Uint8Array(silent);
 entries['manifest.json']=strToU8(JSON.stringify(manifest));
 await page.evaluate(()=>{(window as unknown as {__savedReferenceCalls:string[]}).__savedReferenceCalls.length=0;});
 await page.locator('#project-open').setInputFiles({name:'invalid-reference.musicsync.zip',mimeType:'application/zip',buffer:Buffer.from(zipSync(entries,{level:0}))});
 await expect(page.locator('#processing-overlay')).toBeHidden();await expect(page.locator('#project-status')).toContainText('プロジェクトを開けませんでした');
 await expect(page.locator('#project-status')).toContainText('保持しています');expect(await referenceCalls(page)).toContain('stored-reference.wav');
 await expect(page.locator('#reference-name')).toContainText('current-reference.wav');await expect(page.locator('#reference-strength')).toHaveValue('1');await expect(page.locator('#reference-enabled')).toBeChecked();
 expect(await pair(page)).toEqual(before);await expect(page.locator('#select-b')).toBeEnabled();
});
