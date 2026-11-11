import {expect,test,type Page} from '@playwright/test';
import {tone,wav} from '../helpers/audio';

const fixture=(name:string,frequency:number)=>({name,mimeType:'audio/wav',
  buffer:Buffer.from(wav(tone({sampleRate:44100,seconds:1,stereo:true,frequency,amplitude:.1}),32,true))});
async function pair(page:Page){return Promise.all(['a-name','b-name','a-lufs','b-lufs'].map(id=>page.locator('#'+id).innerText()));}
async function stems(page:Page){return page.locator('#stem-track-list .stem-track').evaluateAll(rows=>rows.map(row=>({
  id:row.getAttribute('data-track-id'),name:row.querySelector('strong')?.firstChild?.textContent,
  selections:Array.from(row.querySelectorAll('select'),select=>select.value),
  included:Array.from(row.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),input=>input.checked),
})));}
async function candidates(page:Page){return page.evaluate(async()=>{
  const root=await navigator.storage.getDirectory();let directory:FileSystemDirectoryHandle;
  try{directory=await root.getDirectoryHandle('music-sync-candidates');}
  catch(error){if(error instanceof DOMException&&error.name==='NotFoundError')return [];throw error;}
  const names:string[]=[];
  for await(const name of (directory as FileSystemDirectoryHandle&{keys():AsyncIterable<string>}).keys())names.push(name);
  return names.sort();
});}

test('REAL inference cancellation removes provisional candidates while preserving A/B and staged STEM edits',async({page})=>{
  // Real SCNet loading/session initialization precedes this cancellation point.
  // Headless CI uses CPU/WASM; no Worker, inference, model or network mock is used.
  test.setTimeout(90000);
  const errors:string[]=[],modelRequests:string[]=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('request',request=>{if(/\/models\/scnet-small\/.*\.onnx(?:\?|$)/.test(request.url()))modelRequests.push(request.url());});
  await page.goto('/');
  await page.locator('#file-input').setInputFiles(fixture('cancel-original.wav',337));
  await expect(page.getByRole('status',{name:'処理状況',exact:true})).toContainText('解析完了');
  await page.locator('#file-input-b').setInputFiles(fixture('cancel-comparison.wav',443));
  await expect(page.locator('#b-name')).toContainText('cancel-comparison.wav');
  await expect(page.locator('#select-b')).toBeEnabled();

  // One waiting material does not start a mix or replace A/B. Preserve actual
  // pending role/gain/include edits rather than checking an empty STEM list.
  await page.locator('#stem-file-input').setInputFiles(fixture('waiting-material.wav',659));
  const waiting=page.locator('#stem-track-list .stem-track');await expect(waiting).toHaveCount(1);
  await waiting.getByRole('combobox',{name:'waiting-material.wav の役割',exact:true}).selectOption('bass');
  await waiting.getByRole('combobox',{name:'waiting-material.wav の音量',exact:true}).selectOption('-3');
  await waiting.getByRole('checkbox').uncheck();
  const beforePair=await pair(page),beforeStems=await stems(page),baseline=await candidates(page);
  await page.locator('#separation-panel > summary').click();
  await expect(page.locator('#separation-source-name')).toHaveText('現在のOriginalを分離：cancel-original.wav');
  await page.locator('#separation-mode').selectOption('four');
  await page.locator('#separation-run').click();
  await expect.poll(async()=>(await candidates(page)).filter(name=>!baseline.includes(name)).length,{timeout:10000}).toBe(5);

  // separation.worker commits all output headers BEFORE initializing
  // the real model and reaching Core's first inference progress message.
  await expect(page.locator('#status')).toContainText(/1\/1区間を分離しています/,{timeout:60000});
  await expect(page.locator('#processing-overlay')).toBeVisible();
  await page.locator('#cancel-button').click();
  await expect(page.locator('#processing-overlay')).toBeHidden();
  await expect(page.locator('#separation-status')).toContainText('キャンセル');

  // Real OPFS removal must complete after terminating actual inference. Writer
  // handles must not stay open across ONNX. Do not delete entries in the test.
  await expect.poll(()=>candidates(page),{timeout:10000}).toEqual(baseline);
  expect(modelRequests.length).toBeGreaterThan(0);
  expect(await pair(page)).toEqual(beforePair);expect(await stems(page)).toEqual(beforeStems);
  await expect(page.locator('#separation-results .separation-track')).toHaveCount(0);
  await expect(page.locator('#separation-stage')).toBeDisabled();
  for(const id of ['file-input','stem-file-input','select-b','separation-run'])await expect(page.locator('#'+id)).toBeEnabled();
  await page.locator('#separation-mode').selectOption('two');
  await expect(page.locator('#separation-mode')).toHaveValue('two');
  expect(await pair(page)).toEqual(beforePair);expect(await stems(page)).toEqual(beforeStems);
  await expect(page.locator('#error')).toBeHidden();expect(errors).toEqual([]);
});
