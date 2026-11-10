import {test,expect} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {wav} from '../helpers/audio';

test('an open page resolves the deployment worker instead of its stale bundled asset',async({page})=>{
  const manifest=JSON.parse(await readFile('apps/web/dist/workers.json','utf8'));
  const code=await readFile(`apps/web/dist/${manifest.processing}`,'utf8');
  await page.goto('/');await page.locator('#demo-button').click();await expect(page.locator('#mode-AUTO')).toBeEnabled();
  const original=await page.locator('#a-lufs').innerText();
  await page.route(`**/${manifest.processing}`,route=>route.fulfill({contentType:'text/html',body:'<!doctype html>missing asset'}));
  await page.route('**/assets/replacement-processing.js',route=>route.fulfill({contentType:'text/javascript',body:code}));
  await page.route('**/workers.json',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({...manifest,processing:'assets/replacement-processing.js'})}));
  await page.locator('#mode-AUTO').click();await expect(page.locator('#finish-explanation')).toContainText('候補を用意しました');
  await expect(page.locator('#a-lufs')).toHaveText(original);await expect(page.locator('#match-toggle')).toBeChecked();
});

test('HTML fallback and incompatible protocol leave Original and prior B available with a useful error',async({page})=>{
  const manifest=JSON.parse(await readFile('apps/web/dist/workers.json','utf8'));
  await page.goto('/');await page.locator('#demo-button').click();await expect(page.locator('#mode-AUTO')).toBeEnabled();
  await page.locator('#mode-AUTO').click();await expect(page.locator('#finish-explanation')).toContainText('候補を用意しました');
  const a=await page.locator('#a-lufs').innerText(),b=await page.locator('#b-lufs').innerText();
  await page.route(`**/${manifest.processing}`,route=>route.fulfill({contentType:'text/html',body:'<!doctype html>SPA fallback'}));
  await page.locator('#mode-LIVE').click();await expect(page.locator('#error')).toContainText('処理プログラムを読み込めませんでした');
  await expect(page.getByRole('status')).toContainText('原音と既存の仕上がりは保持');
  await expect(page.locator('#a-lufs')).toHaveText(a);await expect(page.locator('#b-lufs')).toHaveText(b);await expect(page.locator('#select-b')).toBeEnabled();
  await page.route('**/workers.json',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({...manifest,protocol:2})}));
  await page.locator('#mode-AUTO').click();await expect(page.locator('#error')).toContainText('バージョンが一致しません');
  await expect(page.locator('#b-lufs')).toHaveText(b);
});

test('cancelling while worker metadata is loading cannot publish a stale candidate',async({page})=>{
  await page.goto('/');await page.locator('#demo-button').click();await expect(page.locator('#mode-AUTO')).toBeEnabled();
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
  await page.route('**/workers.json',async route=>{await gate;await route.continue();});
  await page.locator('#mode-AUTO').click();await expect(page.locator('#cancel-button')).toBeEnabled();await page.locator('#cancel-button').click();release();
  await expect(page.getByRole('status')).toContainText('キャンセル');await expect(page.locator('#select-a')).toBeEnabled();await expect(page.locator('#select-b')).toBeDisabled();
});

test('the compatibility entry queues PCM until the current worker is loaded',async({page})=>{
  await page.goto('/');
  const result=await page.evaluate(()=>new Promise<{type:string;status:string}>((resolve,reject)=>{
    const worker=new Worker('./assets/processing.worker-DTrVFXyp.js',{type:'module'});
    worker.onerror=e=>{worker.terminate();reject(new Error(e.message));};
    worker.onmessage=e=>{if(e.data.type==='processed'||e.data.type==='rejected'){worker.terminate();resolve({type:e.data.type,status:e.data.finishing.status});}else if(e.data.type==='error'){worker.terminate();reject(new Error(e.data.message));}};
    const sampleRate=16000,channels=[Float32Array.from({length:16000},(_,i)=>0.1*Math.sin(2*Math.PI*1000*i/sampleRate))];
    worker.postMessage({kind:'auto',mode:'AUTO',audio:{sampleRate,channels}});
  }));
  expect(result).toEqual({type:'processed',status:'accepted'});
});

test('analysis startup failure does not misdiagnose a different audio file as the remedy',async({page})=>{
  await page.goto('/');
  await page.route('**/workers.json',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({protocol:2})}));
  await page.locator('#demo-button').click();await expect(page.locator('#error')).toContainText('バージョンが一致しません');
  await expect(page.getByRole('status')).toContainText('処理を完了できませんでした');
  await expect(page.getByRole('status')).not.toContainText('別のファイル');await expect(page.locator('#demo-button')).toBeEnabled();
});

test('a staged pair retries after a temporary Worker outage without selecting files again',async({page})=>{
  const makeFile=(name:string, amplitude:number)=>{
    const sampleRate=16000,channels=[Float32Array.from({length:sampleRate*2},(_,i)=>
      amplitude*Math.sin(2*Math.PI*440*i/sampleRate))];
    return {name,mimeType:'audio/wav',buffer:Buffer.from(wav({sampleRate,channels},32,true))};
  };
  await page.goto('/');
  await page.locator('#stem-mode').selectOption('vocal-instrumental');
  await page.route('**/workers.json',route=>route.abort());
  await page.locator('#stem-file-input').setInputFiles([makeFile('voice.wav',0.04),makeFile('instrumental.wav',0.08)]);
  await expect(page.locator('#stem-status')).toContainText('処理プログラムを読み込めませんでした');
  await expect(page.locator('#stem-track-list .stem-track')).toHaveCount(2);
  await expect(page.locator('#stem-render')).toBeEnabled();
  await page.unroute('**/workers.json');
  await page.locator('#stem-render').click();
  await expect(page.locator('#stem-status')).toContainText('2素材を読み込み');
  await expect(page.locator('#a-lufs')).not.toHaveText('—');
  await expect(page.locator('#stem-track-list .stem-track')).toHaveCount(2);
});
