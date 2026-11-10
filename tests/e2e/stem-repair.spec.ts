import { test, expect, type Page } from '@playwright/test';
import { applyGrainRestoration, analyzeAudio, createComparisonPlan } from '@music-sync/core';
import { wav, tone } from '../helpers/audio';
const rate=48000, frames=rate*3;
function material(){
  let seed=31,low=0;
  const audio={sampleRate:rate,channels:[Float32Array.from({length:frames},(_,i)=>{
    seed=(Math.imul(seed,1664525)+1013904223)>>>0;const noise=(seed/2**32-.5)*.16;
    low+=.28*(noise-low);const t=i/rate,e=.35+.65*Math.abs(Math.sin(2*Math.PI*3*t));
    return e*(.11*Math.sin(2*Math.PI*220*t)+.04*Math.sin(2*Math.PI*3300*t)+.024*Math.sin(2*Math.PI*4400*t)+noise-low);
  })]};
  return audio;
}
async function imported(page:Page){
  await page.goto('/');await page.locator('#stem-studio-controls').evaluate(node => { (node as HTMLDetailsElement).open = true; });
  await page.locator('#studio-restore').check();await page.locator('#treble-repair').selectOption('off');
  await page.locator('#stem-file-input').setInputFiles([
    {name:'Synth.wav',mimeType:'audio/wav',buffer:Buffer.from(wav(material(),32,true))},
    {name:'Bass.wav',mimeType:'audio/wav',buffer:Buffer.from(wav(tone({sampleRate:rate,seconds:3,frequency:120,amplitude:.03}),32,true))},
  ]);
  await expect(page.locator('#stem-status')).toContainText('2素材を読み込み');
  await expect(page.locator('#stem-track-list')).toContainText('ジャリつき補修');
}
async function mediaVolume(page:Page){
  return page.evaluate(()=>{
    const state=window as unknown as {__repairMedia:HTMLMediaElement[]};
    return state.__repairMedia.slice().reverse().find(audio=>!audio.paused)?.volume ?? -1;
  });
}
test('compares exact committed repair with matched monitoring and commits OFF only after successful rebuild',async({page})=>{
  const original=material(),processed=applyGrainRestoration(original,{grain:'strong',amount:100});
  expect(processed.report.status).toBe('applied');
  const comparison=createComparisonPlan(analyzeAudio(original),analyzeAudio(processed.audio));
  await page.addInitScript(()=>{
    const media:HTMLMediaElement[]=[];Object.defineProperty(window,'__repairMedia',{value:media});
    const play=HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play=function(){media.push(this);return play.call(this);};
  });
  await imported(page);
  // These pending finishing settings must not change the committed material preview.
  await page.locator('#grain-mode').selectOption('off');
  await page.locator('#studio-finish-controls summary').click();await page.locator('#grain-amount').fill('0');
  await page.locator('#mode-AUTO').click();await expect(page.locator('#finish-explanation')).toContainText('候補を用意しました');
  const a=await page.locator('#a-lufs').innerText(),b=await page.locator('#b-lufs').innerText();
  await page.getByRole('button',{name:'Synth.wav だけを聴く',exact:true}).click();
  await page.locator('#stem-solo-after').click();
  await expect(page.locator('#stem-solo-after')).toHaveAttribute('aria-pressed','true');
  await expect(page.locator('#stem-solo-match')).toBeEnabled({timeout:30000});
  await expect(page.locator('#stem-solo-match')).toBeChecked();
  await expect(page.locator('#stem-solo-play')).toHaveText('一時停止');
  await expect(page.locator('#stem-solo-repair-state')).toContainText('音量をそろえて');
  await expect.poll(()=>mediaVolume(page)).toBeCloseTo(.5*10**(comparison.match.gainsDb.b/20),5);
  await page.locator('#stem-solo-before').click();
  await expect(page.locator('#stem-solo-play')).toHaveText('一時停止');
  await expect.poll(()=>mediaVolume(page)).toBeCloseTo(.5*10**(comparison.match.gainsDb.a/20),5);
  await page.locator('#stem-solo-repair-use').uncheck();
  await expect(page.locator('#stem-solo-repair-state')).toContainText('まだA/Bに反映していません');
  await expect(page.locator('#a-lufs')).toHaveText(a);await expect(page.locator('#b-lufs')).toHaveText(b);
  await page.locator('#stem-solo-rebuild').click();
  await expect(page.locator('#stem-solo-dialog')).toBeHidden();
  await expect(page.locator('#stem-status')).toContainText('この素材の補修をOFFにしました');
  await expect(page.locator('#select-b')).toBeDisabled();
  await expect(page.locator('.stem-track').filter({hasText:'Synth.wav'})).toContainText('この素材の補修OFF');
  await page.getByRole('button',{name:'Synth.wav だけを聴く',exact:true}).click();
  await expect(page.locator('#stem-solo-repair-use')).not.toBeChecked();
  await expect(page.locator('#stem-solo-repair-state')).toContainText('現在のA：この素材の補修OFF');
  await page.locator('#stem-solo-close').click();
});
test('can cancel repair preparation without replacing audio or publishing a late candidate',async({page})=>{
  await imported(page);
  const a=await page.locator('#a-lufs').innerText();
  await page.getByRole('button',{name:'Synth.wav だけを聴く',exact:true}).click();
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
  await page.route('**/workers.json',async route=>{await gate;await route.continue();});
  await page.locator('#stem-solo-after').click();
  await expect(page.locator('#stem-solo-repair-cancel')).toBeVisible();
  await page.locator('#stem-solo-repair-cancel').click();release();
  await expect(page.locator('#stem-solo-status')).toContainText('キャンセルしました');
  await expect(page.locator('#stem-solo-before')).toHaveAttribute('aria-pressed','true');
  await expect(page.locator('#a-lufs')).toHaveText(a);
  await page.keyboard.press('Escape');await expect(page.locator('#stem-solo-dialog')).toBeHidden();
});
