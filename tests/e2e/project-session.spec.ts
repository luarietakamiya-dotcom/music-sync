import {expect,test,type Page} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {strFromU8,strToU8,unzipSync,zipSync} from 'fflate';
import {tone,wav} from '../helpers/audio';

const cover=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=','base64');
const file=(name:string,frequency=440)=>({name,mimeType:'audio/wav',buffer:Buffer.from(wav(tone({sampleRate:16000,seconds:3,amplitude:0.08,frequency,stereo:true}),32,true))});
async function reveal(page:Page,selector:string){await page.locator(selector).evaluate(element=>{for(let parent=element.parentElement;parent;parent=parent.parentElement)if(parent instanceof HTMLDetailsElement)parent.open=true;});}
async function finish(page:Page){await expect(page.locator('#mode-AUTO')).toBeEnabled();await page.locator('#mode-AUTO').click();await expect(page.locator('#finish-explanation')).toContainText('候補を用意しました');}
async function save(page:Page){const event=page.waitForEvent('download');await page.locator('#project-save').click();const download=await event;expect(download.suggestedFilename()).toMatch(/\.musicsync\.zip$/);return (await download.path())!;}

test('portable project restores A/B, pending STEM edits, finishing settings, MP3 tags and artwork after reload',async({page})=>{
 const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto('/');await page.locator('#stem-mode').selectOption('vocal-instrumental');
 await page.locator('#stem-file-input').setInputFiles([file('project-vocals.wav'),file('project-instrumental.wav',1600)]);
 await expect(page.locator('#stem-status')).toContainText('2素材を読み込み');await finish(page);
 const a=await page.locator('#a-lufs').innerText(),b=await page.locator('#b-lufs').innerText();
 await page.getByRole('combobox',{name:'project-vocals.wav の音量'}).selectOption('3');
 await page.locator('#output-profile').selectOption('youtube');await page.locator('#grain-mode').selectOption('strong');
 await reveal(page,'#audio-export-format');await page.locator('#audio-export-format').selectOption('mp3');await page.locator('#audio-export-bitrate').selectOption('320');
 await page.locator('#audio-tag-title').fill('復元する曲🎵');await page.locator('#audio-tag-artist').fill('MusicSync作者');
 await page.locator('#audio-export-artwork').setInputFiles({name:'project-jacket.png',mimeType:'image/png',buffer:cover});await expect(page.locator('#audio-export-cover')).toBeVisible();
 await page.locator('#project-name').fill('保存と再開');const saved=await save(page);
 await page.reload();await page.locator('#project-open').setInputFiles(saved);
 await expect(page.locator('#project-status')).toContainText('プロジェクトを復元しました');
 await expect(page.locator('#a-lufs')).toHaveText(a);await expect(page.locator('#b-lufs')).toHaveText(b);await expect(page.locator('#select-b')).toBeEnabled();
 await expect(page.locator('#stem-track-list .stem-track')).toHaveCount(2);await expect(page.getByRole('combobox',{name:'project-vocals.wav の音量'})).toHaveValue('3');
 await expect(page.locator('#output-profile')).toHaveValue('youtube');await expect(page.locator('#grain-mode')).toHaveValue('strong');await expect(page.locator('#project-name')).toHaveValue('保存と再開');
 await reveal(page,'#audio-export-format');await expect(page.locator('#audio-export-format')).toHaveValue('mp3');await expect(page.locator('#audio-export-bitrate')).toHaveValue('320');
 await expect(page.locator('#audio-tag-title')).toHaveValue('復元する曲🎵');await expect(page.locator('#audio-tag-artist')).toHaveValue('MusicSync作者');await expect(page.locator('#audio-export-cover')).toBeVisible();
 await page.locator('#select-a').click();await expect(page.locator('#select-a')).toHaveAttribute('aria-pressed','true');await page.locator('#select-b').click();
 await page.getByRole('combobox',{name:'project-vocals.wav の音量'}).selectOption('0');await page.locator('#stem-render').click();
 await expect(page.locator('#stem-status')).toContainText('2素材を読み込み');await expect(page.locator('#select-b')).toBeDisabled();expect(errors).toEqual([]);
});

test('invalid project and cancelled restore preserve the current A/B and do not commit partial settings',async({page})=>{
 await page.goto('/');await page.locator('#file-input').setInputFiles(file('current-original.wav'));await finish(page);
 await page.locator('#project-name').fill('キャンセル保護');const saved=await save(page);
 const a=await page.locator('#a-lufs').innerText(),b=await page.locator('#b-lufs').innerText();
 await page.locator('#project-open').setInputFiles({name:'broken.musicsync.zip',mimeType:'application/zip',buffer:Buffer.from('not a project ZIP')});
 await expect(page.locator('#project-status')).toContainText('保持しています');await expect(page.locator('#a-lufs')).toHaveText(a);await expect(page.locator('#b-lufs')).toHaveText(b);
 let release!:()=>void,entered!:()=>void,handled!:()=>void;
 const gate=new Promise<void>(resolve=>{release=resolve;}),arrived=new Promise<void>(resolve=>{entered=resolve;}),completed=new Promise<void>(resolve=>{handled=resolve;});
 await page.route('**/workers.json',async route=>{entered();await gate;try{await route.continue();}finally{handled();}});
 try{
  await page.locator('#project-open').setInputFiles(saved);await arrived;await expect(page.locator('#processing-overlay')).toBeVisible();
  await page.locator('#cancel-button').click();release();await completed;await expect(page.locator('#processing-overlay')).toBeHidden();
  await expect(page.locator('#a-lufs')).toHaveText(a);await expect(page.locator('#b-lufs')).toHaveText(b);await expect(page.locator('#project-name')).toHaveValue('キャンセル保護');await expect(page.locator('#select-b')).toBeEnabled();
 }finally{release();await completed;await page.unroute('**/workers.json');}
});

test('restored STUDIO_RESTORE refreshes original-material evidence before automatic finishing',async({page})=>{
 await page.addInitScript(()=>{
  const calls:string[]=[];Object.defineProperty(window,'__projectWorkerKinds',{value:calls});
  const post=Worker.prototype.postMessage;
  Worker.prototype.postMessage=function(message:unknown,options?:Transferable[]|StructuredSerializeOptions){
   const kind=(message as {kind?:string}).kind;if(kind)calls.push(kind);Reflect.apply(post,this,options===undefined?[message]:[message,options]);
  };
 });
 await page.goto('/');await reveal(page,'#studio-restore');await page.locator('#studio-restore').check();await page.locator('#treble-repair').selectOption('off');
 await page.locator('#stem-file-input').setInputFiles([220,120].map((frequency,index)=>({name:index?'Bass.wav':'Synth.wav',mimeType:'audio/wav',
  buffer:Buffer.from(wav(tone({sampleRate:48000,seconds:3,frequency,amplitude:0.05,stereo:true}),32,true))})));
 await expect(page.locator('#stem-status')).toContainText('2素材を読み込み');await finish(page);const saved=await save(page);
 await page.reload();await page.locator('#project-open').setInputFiles(saved);await expect(page.locator('#project-status')).toContainText('プロジェクトを復元しました');
 await page.evaluate(()=>{(window as unknown as {__projectWorkerKinds:string[]}).__projectWorkerKinds.length=0;});
 await page.locator('#mode-AUTO').click();
 await expect.poll(()=>page.evaluate(()=>(window as unknown as {__projectWorkerKinds:string[]}).__projectWorkerKinds)).toContain('auto');
 await expect(page.locator('#processing-overlay')).toBeHidden();await expect(page.locator('#finish-explanation')).toContainText('候補を用意しました');
 const kinds=await page.evaluate(()=>(window as unknown as {__projectWorkerKinds:string[]}).__projectWorkerKinds);
 expect(kinds.indexOf('file-stems')).toBeGreaterThanOrEqual(0);expect(kinds.indexOf('file-stems')).toBeLessThan(kinds.indexOf('auto'));
});

test('valid ZIPs with HTML-invalid or missing controls reject atomically without changing current A/B or volume',async({page})=>{
 await page.goto('/');await page.locator('#file-input').setInputFiles(file('protected-original.wav'));await finish(page);
 const saved=await save(page),original=unzipSync(new Uint8Array(await readFile(saved)));
 const a=await page.locator('#a-lufs').innerText(),b=await page.locator('#b-lufs').innerText(),volume=await page.locator('#volume').inputValue();
 for(const variant of ['invalid-number','missing-control'] as const){
  const entries=Object.fromEntries(Object.entries(original).map(([name,data])=>[name,data.slice()]));
  const manifest=JSON.parse(strFromU8(entries['manifest.json'])) as {state:{settings:{controls:Record<string,string|boolean>}}};
  if(variant==='invalid-number')manifest.state.settings.controls.volume='0x1'; // Number accepts 1, but HTML range syntax does not.
  else delete manifest.state.settings.controls['output-profile'];
  entries['manifest.json']=strToU8(JSON.stringify(manifest));
  await page.locator('#project-open').setInputFiles({name:variant+'.musicsync.zip',mimeType:'application/zip',buffer:Buffer.from(zipSync(entries,{level:0}))});
  await expect(page.locator('#processing-overlay')).toBeHidden();await expect(page.locator('#project-status')).toContainText('プロジェクトを開けませんでした');
  await expect(page.locator('#project-status')).toContainText('保持しています');await expect(page.locator('#a-lufs')).toHaveText(a);await expect(page.locator('#b-lufs')).toHaveText(b);
  await expect(page.locator('#error')).toContainText(variant==='invalid-number'?'設定が範囲外':'設定が不足');
  await expect(page.locator('#volume')).toHaveValue(volume);await expect(page.locator('#select-b')).toBeEnabled();
 }
});
