import { test, expect } from '@playwright/test';
import { wav } from '../helpers/audio';

test('studio STEM import restores individual tracks, checks the reference, doubles guitar and finishes to a matched candidate', async ({ page }) => {
  const rate = 48000, frames = rate * 6;
  const guitar = new Float32Array(frames), bass = new Float32Array(frames), reference = new Float32Array(frames);
  let seed = 37;
  for (let i=0; i<frames; i++) {
    seed = (Math.imul(seed,1664525)+1013904223) >>> 0;
    guitar[i] = 0.1 * Math.sin(2*Math.PI*440*i/rate) + 0.16 * (seed / 2**32 - 0.5);
    bass[i] = 0.08 * Math.sin(2*Math.PI*120*i/rate);
    reference[i] = (guitar[i] + bass[i]) * (i >= rate*2 && i < rate*2.1 ? 1.15 : 1);
  }
  const file = (name: string, channel: Float32Array) => ({ name, mimeType: 'audio/wav',
    buffer: Buffer.from(wav({sampleRate:rate,channels:[channel]},32,true)) });
  await page.goto('/');
  await page.locator('#stem-studio-controls').evaluate(node => { (node as HTMLDetailsElement).open = true; });
  await page.locator('#studio-restore').check();
  await page.locator('#guitar-double').check();
  await page.locator('#stem-stabilize').check();
  await page.locator('#stem-reference').setInputFiles(file('reference.wav',reference));
  await page.locator('#stem-file-input').setInputFiles([file('guitar.wav',guitar), file('bass.wav',bass)]);
  await expect(page.locator('#stem-status')).toContainText('ギター1素材にHuman Double');
  await expect(page.locator('#stem-status')).toContainText('0.10秒');
  await expect(page.locator('#stem-status')).toContainText(/guitar\.wav：[^。]*秒で抑えました/);
  await expect(page.locator('#stem-track-list')).toContainText('ジャリつき補修');
  await page.locator('#studio-finish-controls summary').click();
  await page.locator('#master-aggression').fill('60');
  await page.locator('#grain-mode').selectOption('light');
  await page.locator('#mode-AUTO').click();
  await expect(page.locator('#finish-explanation')).toContainText('候補を用意しました');
  await expect(page.locator('#match-toggle')).toBeChecked();
  await expect(page.locator('#wav-button')).toBeEnabled();
  await expect(page.locator('#grain-repeat')).not.toBeChecked();
  await expect(page.locator('#finish-applied-summary')).toContainText('重ね掛けを見送り');
  await page.locator('#grain-repeat').check();
  await expect(page.locator('#finish-settings-status')).toBeVisible();
  await page.locator('#mode-AUTO').click();
  await expect(page.locator('#finish-explanation')).toContainText('候補を用意しました');
  await expect(page.locator('#finish-applied-summary')).not.toContainText('重ね掛けを見送り');
  await page.locator('#blind-stem').click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.locator('#audition-x').click();
  await expect(page.locator('#audition-x')).toHaveAttribute('aria-pressed','true');
  await page.locator('#audition-y').click();
  await expect(page.locator('#audition-y')).toHaveAttribute('aria-pressed','true');
  await page.locator('#audition-preference').selectOption('Y');
  await page.locator('#audition-reveal').click();
  await expect(page.locator('#audition-result')).toContainText('選んだのはSTEM調整');
  await page.locator('#audition-close').click();
  await expect(page.locator('#wav-button')).toBeEnabled();
  await page.locator('#stem-reference').setInputFiles(file('wrong-length.wav',reference.subarray(rate)));
  await page.locator('#stem-render').click();
  await expect(page.locator('#error')).toContainText('同じ長さ');
  await expect(page.locator('#blind-stem')).toBeVisible();
  await expect(page.locator('#wav-button')).toBeEnabled();
});

test('selects late guitar changes from a file-backed studio mix and clears its trial on source replacement', async ({ page }) => {
  test.setTimeout(120000);
  const rate=8000, seconds=601, frames=rate*seconds;
  const guitar=new Float32Array(frames), bass=new Float32Array(frames);
  for (let i=0; i<frames; i++) {
    bass[i]=0.08*Math.sin(2*Math.PI*140*i/rate);
    if (i>=rate*598) guitar[i]=0.14*Math.sin(2*Math.PI*440*i/rate);
  }
  const file=(name:string, channel:Float32Array)=>({name,mimeType:'audio/wav',buffer:Buffer.from(wav({sampleRate:rate,channels:[channel]}))});
  await page.goto('/');
  await page.locator('#stem-studio-controls').evaluate(node => { (node as HTMLDetailsElement).open = true; });
  await page.locator('#studio-restore').uncheck(); // Isolate long-file Human Double; default repairs have separate coverage.
  await page.locator('#guitar-double').check();
  await page.locator('#stem-file-input').setInputFiles([file('guitar.wav',guitar),file('bass.wav',bass)]);
  await expect(page.locator('#stem-status')).toContainText('Human Double',{timeout:100000});
  await expect(page.locator('#stem-capacity')).toContainText('長尺WAV');
  await expect(page.locator('#audition-range')).toContainText(/9:52|9:53/);
  await page.locator('#blind-stem').click();
  await page.locator('#audition-y').click();
  await expect(page.locator('#audition-y')).toHaveAttribute('aria-pressed','true');
  await page.locator('#audition-close').click();
  await page.locator('#demo-button').click();
  await expect(page.locator('#stem-audition')).toBeHidden();
});
