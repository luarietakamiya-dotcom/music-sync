import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { tone, wav } from '../helpers/audio';

async function reveal(page: Page, selector: string) {
  await page.locator(selector).evaluate(element => {
    for (let parent = element.parentElement; parent; parent = parent.parentElement)
      if (parent instanceof HTMLDetailsElement) parent.open = true;
  });
}
async function loadDemoCandidate(page: Page) {
  await page.locator('#demo-button').click();
  await expect(page.locator('#mode-AUTO')).toBeEnabled();
  await page.locator('#mode-AUTO').click();
  await expect(page.locator('#finish-explanation')).toContainText('候補を用意しました');
}

test('one click uses AUTO defaults, retains the chosen destination and downloads a new measured WAV', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.locator('#easy-finish-download')).toBeDisabled();
  await expect(page.locator('#output-profile')).toHaveCount(1);
  const rate = 16000, seconds = 3;
  await page.locator('#file-input').setInputFiles({ name: 'easy-original.wav', mimeType: 'audio/wav',
    buffer: Buffer.from(wav(tone({ sampleRate: rate, seconds, frequency: 440, amplitude: 0.08 }), 32, true)) });
  await expect(page.locator('#easy-finish-download')).toBeEnabled();
  const original = await page.locator('#a-lufs').innerText();
  await reveal(page, '#output-profile'); await page.locator('#output-profile').selectOption('youtube');
  await reveal(page, '#sound-color-preset'); await page.locator('#sound-color-preset').selectOption('cassette');
  await reveal(page, '#finish-vocal'); await page.locator('#finish-vocal').selectOption('3');
  const downloaded = page.waitForEvent('download');
  await page.locator('#easy-finish-download').click();
  const saved = await downloaded;
  expect(saved.suggestedFilename()).toMatch(/\.wav$/i);
  const bytes = await readFile((await saved.path())!);
  expect(bytes.toString('ascii', 0, 4)).toBe('RIFF');
  expect(bytes.readUInt16LE(20)).toBe(3); expect(bytes.readUInt16LE(22)).toBe(1);
  expect(bytes.readUInt32LE(24)).toBe(rate);
  expect(bytes.length).toBe(56 + rate * seconds * 4);
  let peak = 0, finite = true;
  for (let offset = 56; offset < bytes.length; offset += 4) {
    const value = bytes.readFloatLE(offset); finite &&= Number.isFinite(value); peak = Math.max(peak, Math.abs(value));
  }
  expect(finite).toBe(true); expect(peak).toBeLessThan(1);
  await expect(page.locator('#a-lufs')).toHaveText(original);
  await expect(page.locator('#b-name')).toContainText('AUTO');
  await expect(page.locator('#match-toggle')).toBeChecked();
  await expect(page.locator('#mode-AUTO')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#sound-color-preset')).toHaveValue('none');
  await expect(page.locator('#finish-vocal')).toHaveValue('0');
  await expect(page.locator('#treble-repair')).toHaveValue('auto');
  await expect(page.locator('#output-profile')).toHaveValue('youtube');
  await expect(page.locator('#preferences-result')).toContainText('YouTube');
  await expect(page.locator('#easy-finish-status')).toContainText(/保存|ダウンロード/);
  await expect(page.locator('#wav-button')).toBeEnabled();
  expect(errors).toEqual([]);
});

test('a rejected automatic candidate never downloads the previously accepted B', async ({ page }) => {
  const downloads: string[] = []; page.on('download', download => downloads.push(download.suggestedFilename()));
  await page.goto('/'); await loadDemoCandidate(page);
  const a = await page.locator('#a-lufs').innerText(), b = await page.locator('#b-lufs').innerText();
  const name = await page.locator('#b-name').innerText();
  const manifest = JSON.parse(await readFile('apps/web/dist/workers.json', 'utf8'));
  const mock = `self.onmessage = ({data}) => {
    if (data.kind === 'export') {
      const buffer = new ArrayBuffer(60); self.postMessage({type:'wav',buffer},[buffer]); return;
    }
    self.postMessage({type:'rejected',finishing:{status:'rejected',mode:'AUTO',reasons:['quality fixture rejected'],attempts:[],before:{},explanations:[]}});
  };`;
  await page.route('**/assets/easy-rejected-fixture.js', route => route.fulfill({ contentType: 'text/javascript', body: mock }));
  await page.route('**/workers.json', route => route.fulfill({ contentType: 'application/json',
    body: JSON.stringify({ ...manifest, processing: 'assets/easy-rejected-fixture.js' }) }));
  await page.locator('#easy-finish-download').click();
  await expect(page.locator('#finish-explanation')).toContainText('quality fixture rejected');
  await expect(page.locator('#easy-finish-download')).toBeEnabled();
  await expect(page.locator('#a-lufs')).toHaveText(a); await expect(page.locator('#b-lufs')).toHaveText(b);
  await expect(page.locator('#b-name')).toHaveText(name); await expect(page.locator('#wav-button')).toBeEnabled();
  expect(downloads).toEqual([]);
});

test('mobile one-click processing can be cancelled without saving or replacing the previous B', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/'); await loadDemoCandidate(page);
  const a = await page.locator('#a-lufs').innerText(), b = await page.locator('#b-lufs').innerText();
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/workers.json', async route => { await gate; await route.continue(); });
  const downloads: string[] = []; page.on('download', download => downloads.push(download.suggestedFilename()));
  const releasedManifest = page.waitForResponse(response => response.url().endsWith('/workers.json'));
  try {
    await page.locator('#easy-finish-download').click();
    await expect(page.locator('#easy-finish-download')).toBeDisabled();
    await expect(page.locator('#processing-overlay')).toBeVisible();
    await page.locator('#cancel-button').click(); release(); await releasedManifest;
    await expect(page.locator('#status')).toContainText('キャンセル');
    await expect(page.locator('#easy-finish-download')).toBeEnabled();
    await expect(page.locator('#a-lufs')).toHaveText(a); await expect(page.locator('#b-lufs')).toHaveText(b);
    await expect(page.locator('#wav-button')).toBeEnabled(); expect(downloads).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await page.locator('.easy-finish-panel').screenshot({ path: 'test-results/easy-finish-mobile.png' });
  } finally { release(); }
});

test('one click commits a staged per-material repair OFF choice before finishing and saving', async ({ page }) => {
  await page.goto('/'); await reveal(page, '#studio-restore'); await page.locator('#studio-restore').check();
  const file = (name: string, frequency: number) => ({ name, mimeType: 'audio/wav',
    buffer: Buffer.from(wav(tone({ sampleRate: 16000, seconds: 3, frequency, amplitude: 0.08 }), 32, true)) });
  await page.locator('#stem-file-input').setInputFiles([file('Synth.wav', 330), file('Bass.wav', 110)]);
  await expect(page.locator('#stem-status')).toContainText('2素材を読み込み');
  const originalMix = await page.locator('#a-lufs').innerText();
  await page.getByRole('button', { name: 'Synth.wav だけを聴く', exact: true }).click();
  await expect(page.locator('#stem-solo-repair-use')).toBeChecked();
  await page.locator('#stem-solo-repair-use').uncheck(); await page.locator('#stem-solo-close').click();
  await expect(page.locator('#a-lufs')).toHaveText(originalMix);
  const downloaded = page.waitForEvent('download'); await page.locator('#easy-finish-download').click();
  expect((await downloaded).suggestedFilename()).toMatch(/\.wav$/i);
  await expect(page.locator('#stem-status')).toContainText('2素材を読み込み');
  await expect(page.locator('#b-name')).toContainText('AUTO');
  await reveal(page, '#finish-report-button');
  const reportDownload = page.waitForEvent('download'); await page.locator('#finish-report-button').click();
  const report = JSON.parse(await readFile((await (await reportDownload).path())!, 'utf8'));
  expect(report.status).toBe('accepted');
  expect(report.sourceMix.tracks[0].descriptor.restorationEnabled).toBe(false);
  expect(report.sourceMix.tracks[1].descriptor.restorationEnabled).not.toBe(false);
});

test('one click rebuilds changed STEM workspace options before saving',async({page})=>{
  await page.goto('/');
  await page.locator('#guitar-double').uncheck(); // The later check must remain a staged change.
  const file=(name:string,frequency:number)=>({name,mimeType:'audio/wav',
    buffer:Buffer.from(wav(tone({sampleRate:16000,seconds:2,frequency,amplitude:.06}),32,true))});
  await page.locator('#stem-file-input').setInputFiles([file('Guitar.wav',440),file('Bass.wav',110)]);
  await expect(page.locator('#stem-status')).toContainText('2素材を読み込み');
  await reveal(page,'#guitar-double');await page.locator('#guitar-double').check();
  const downloaded=page.waitForEvent('download');await page.locator('#easy-finish-download').click();
  expect((await downloaded).suggestedFilename()).toMatch(/\.wav$/i);
  await expect(page.locator('#stem-status')).toContainText('ギター1素材にHuman Double');
});

test('an invalid staged STEM rebuild never continues to mastering or downloads the old B', async ({ page }) => {
  await page.goto('/');
  const file = (name: string, frequency: number) => ({ name, mimeType: 'audio/wav',
    buffer: Buffer.from(wav(tone({ sampleRate: 16000, seconds: 2, frequency, amplitude: 0.08 }), 32, true)) });
  await page.locator('#stem-file-input').setInputFiles([file('Synth.wav', 330), file('Bass.wav', 110)]);
  await expect(page.locator('#stem-status')).toContainText('2素材を読み込み');
  await page.locator('#mode-AUTO').click(); await expect(page.locator('#finish-explanation')).toContainText('候補を用意しました');
  const a = await page.locator('#a-lufs').innerText(), b = await page.locator('#b-lufs').innerText();
  const downloads: string[] = []; page.on('download', download => downloads.push(download.suggestedFilename()));
  await page.locator('#stem-mode').selectOption('vocal-instrumental');
  await page.locator('#easy-finish-download').click();
  await expect(page.locator('#error')).toContainText('役割');
  await expect(page.locator('#easy-finish-download')).toBeEnabled();
  await expect(page.locator('#a-lufs')).toHaveText(a); await expect(page.locator('#b-lufs')).toHaveText(b);
  expect(downloads).toEqual([]);
});

test('the beginner button finishes and downloads the complete file-backed eleven-minute WAV', async ({ page }) => {
  test.setTimeout(120000);
  const sampleRate = 8000, frames = sampleRate * 11 * 60;
  const samples = Float32Array.from({ length: frames }, (_, n) => n % 40 < 20 ? 0.1 : -0.1);
  await page.goto('/');
  await page.locator('#file-input').setInputFiles({ name: 'easy-long.wav', mimeType: 'audio/wav',
    buffer: Buffer.from(wav({ sampleRate, channels: [samples] })) });
  await expect(page.locator('#easy-finish-download')).toBeEnabled({ timeout: 100000 });
  const original = await page.locator('#a-lufs').innerText();
  const downloaded = page.waitForEvent('download', { timeout: 90000 });
  await page.locator('#easy-finish-download').click();
  const saved = await downloaded;
  expect(saved.suggestedFilename()).toContain('AUTO');
  const bytes = await readFile((await saved.path())!);
  expect(bytes.length).toBe(56 + frames * 4); expect(bytes.readUInt16LE(20)).toBe(3);
  expect(bytes.readUInt16LE(22)).toBe(1); expect(bytes.readUInt32LE(24)).toBe(sampleRate);
  expect(Number.isFinite(bytes.readFloatLE(56 + (frames - 1) * 4))).toBe(true);
  await expect(page.locator('#a-lufs')).toHaveText(original);
  await expect(page.locator('#b-name')).toContainText('AUTO'); await expect(page.locator('#match-toggle')).toBeChecked();
  await expect(page.locator('#wav-button')).toBeEnabled(); await expect(page.locator('#easy-finish-status')).toContainText(/保存|ダウンロード/);
});
