import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { tone, wav } from '../helpers/audio';

test('multi-STEM import identifies lead/chorus, measures local corrections, auditions and rebuilds transactionally', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const rate=16000, frames=rate*4;
  const sine=(n:number,hz:number)=>Math.sin(2*Math.PI*hz*n/rate);
  const file=(name:string, sample:(n:number)=>number)=>({name,mimeType:'audio/wav',buffer:Buffer.from(wav({
    sampleRate:rate,channels:[Float32Array.from({length:frames},(_,n)=>sample(n))],
  },32,true))});
  await page.goto('/');
  // Isolate clarity: its rejection should leave no independent repair/doubling audition.
  // Default-on studio behavior is covered separately in stem-defaults.spec.ts.
  await page.locator('#studio-restore').uncheck();
  await page.locator('#guitar-double').uncheck();
  await expect(page.locator('#stem-multitrack-auto')).toBeChecked();
  await page.locator('#stem-file-input').setInputFiles([
    file('0 Lead Vocals.wav',n=>n>=rate&&n<rate*3 ? .03*sine(n,2300)+.01*sine(n,700):0),
    file('1 Backing Vocals.wav',n=>n>=rate*1.5&&n<rate*2.5 ? .05*sine(n,2700):0),
    file('2 Guitar.wav',n=>.23*sine(n,2600)+.03*sine(n,330)),
    file('3 Bass.wav',n=>.08*sine(n,100)),
  ]);
  await expect(page.locator('#stem-status')).toContainText('4素材を読み込み');
  await expect(page.getByRole('combobox',{name:'0 Lead Vocals.wav の役割'})).toHaveValue('vocal-lead');
  await expect(page.getByRole('combobox',{name:'1 Backing Vocals.wav の役割'})).toHaveValue('vocal-backing');
  await expect(page.locator('#stem-status')).toContainText('重なる伴奏の帯域を控えめに整理しました');
  await expect(page.locator('#stem-status')).toContainText('歌声の音量を保ちました');
  await expect(page.locator('#stem-track-list')).toContainText('歌の重なりを整理');
  await expect(page.locator('#clipped')).toHaveText('0');
  await page.locator('#stem-settings').screenshot({path:'test-results/adaptive-stem-clarity.png'});
  await page.locator('#blind-stem').click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.locator('#audition-x').click(); await expect(page.locator('#audition-x')).toHaveAttribute('aria-pressed','true');
  await page.locator('#audition-y').click(); await expect(page.locator('#audition-y')).toHaveAttribute('aria-pressed','true');
  await page.locator('#audition-reveal').click(); await expect(page.locator('#audition-result')).toContainText('STEM調整前');
  await page.locator('#audition-close').click();
  await page.locator('#mode-AUTO').click(); await expect(page.locator('#finish-explanation')).toContainText('候補を用意しました');
  await expect(page.locator('#match-toggle')).toBeChecked();
  await page.locator('#advanced-settings').evaluate((el:HTMLDetailsElement)=>{el.open=true;});
  const download=page.waitForEvent('download'); await page.locator('#finish-report-button').click();
  const report=JSON.parse(await readFile((await (await download).path())!,'utf8'));
  expect(report.sourceMix.clarity.status).toBe('applied'); expect(report.sourceMix.clarity.evaluation.accepted).toBe(true);
  expect(report.sourceMix.clarity.leadId).toBe(report.sourceMix.plan.tracks[0].id);
  expect(report.sourceMix.tracks[0].descriptor.vocalRole).toBe('lead');
  const a=await page.locator('#a-lufs').innerText(),b=await page.locator('#b-lufs').innerText();
  await page.getByRole('combobox',{name:'1 Backing Vocals.wav の役割'}).selectOption('vocal-lead');
  await expect(page.locator('#a-lufs')).toHaveText(a); await expect(page.locator('#b-lufs')).toHaveText(b);
  await page.locator('#stem-render').click(); await expect(page.locator('#stem-status')).toContainText('メインボーカルを1素材に指定');
  await expect(page.locator('#blind-stem')).toBeHidden(); await expect(page.locator('#select-b')).toBeDisabled();
  await page.locator('#stem-multitrack-auto').uncheck();
  await page.locator('#stem-render').click(); await expect(page.locator('#stem-status')).toContainText('4素材を読み込み');
  await expect(page.locator('#stem-status')).not.toContainText('メインボーカルを1素材に指定');
  await expect(page.locator('#stem-track-list')).not.toContainText('歌の重なりを整理');
  expect(errors).toEqual([]);
});

test('short weak vocal phrases receive bounded support and can be rebuilt without it', async ({ page }) => {
  const rate=16000,frames=rate*6;
  const sine=(n:number,hz:number)=>Math.sin(2*Math.PI*hz*n/rate);
  const file=(name:string,sample:(n:number)=>number)=>({name,mimeType:'audio/wav',buffer:Buffer.from(wav({
    sampleRate:rate,channels:[Float32Array.from({length:frames},(_,n)=>sample(n))],
  },32,true))});
  await page.goto('/');
  await page.locator('#stem-file-input').setInputFiles([
    file('Lead Vocals.wav',n=>n<rate*.5||n>=rate*5.5 ? 0 :
      (n>=rate*2.2&&n<rate*2.6 ? .5:1)*(.09*sine(n,700)+.025*sine(n,2300))),
    file('Guitar.wav',n=>.22*sine(n,2600)),
    file('Bass.wav',n=>.05*sine(n,100)),
  ]);
  await expect(page.locator('#stem-status')).toContainText('3素材を読み込み');
  await expect(page.locator('#stem-status')).toContainText('短く引っ込む歌声');
  const lead=page.locator('.stem-track').filter({has:page.getByRole('combobox',{name:'Lead Vocals.wav の役割'})});
  await expect(lead).toContainText('小さくなる歌声を補助');
  await page.locator('#stem-auto-options').evaluate(node => { (node as HTMLDetailsElement).open = true; });
  await expect(page.locator('#stem-vocal-support')).toBeChecked();
  const a=await page.locator('#a-lufs').innerText();
  await page.locator('#stem-vocal-support').uncheck();
  await expect(page.locator('#stem-status')).toContainText('ミックスを作り直す');
  await expect(page.locator('#a-lufs')).toHaveText(a);
  await expect(lead).toContainText('小さくなる歌声を補助');
  await page.locator('#stem-render').click(); await expect(page.locator('#stem-status')).toContainText('3素材を読み込み');
  await expect(lead).not.toContainText('小さくなる歌声を補助');
  await expect(page.locator('#stem-track-list')).toContainText('歌の重なりを整理');
  await expect(page.locator('#clipped')).toHaveText('0');
});

test('adaptive multitrack path preserves native FLAC decoding and capacity feedback', async ({ page }) => {
  await page.setViewportSize({width:390,height:844}); await page.goto('/');
  const rate=44100;
  const file=(name:string,frequency:number)=>({name,mimeType:'audio/wav',buffer:Buffer.from(wav(tone({sampleRate:rate,seconds:1,frequency}),32,true))});
  await page.locator('#stem-file-input').setInputFiles([
    file('Lead Vocals.wav',2300),
    {name:'Backing Vocals.flac',mimeType:'audio/flac',buffer:await readFile('tests/fixtures/tone.flac')},
    file('Guitar.wav',2600),
  ]);
  await expect(page.locator('#stem-status')).toContainText('3素材を読み込み');
  await expect(page.locator('#stem-capacity')).toContainText('3素材 / 44.1 kHz');
  await expect(page.getByRole('combobox',{name:'Backing Vocals.flac の役割'})).toHaveValue('vocal-backing');
  await expect(page.locator('#mode-AUTO')).toBeEnabled();
  await expect(page.locator('#clipped')).toHaveText('0');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
