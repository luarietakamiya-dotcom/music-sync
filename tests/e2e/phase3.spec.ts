import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { tone, wav } from '../helpers/audio';
import { decodeWav } from '../../apps/web/src/decode';

test('DSP renders B, compares and downloads unscaled Float32 audio; repeated processing uses A', async ({ page }) => {
  const errors: string[] = [], external: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { if (!r.url().startsWith('http://127.0.0.1:4173') && !r.url().startsWith('blob:')) external.push(r.url()); });
  await page.goto('/'); await page.getByText('Advanced Settings', { exact: true }).click();
  await page.locator('#demo-button').click(); await expect(page.locator('#process-button')).toBeEnabled();
  const a = await page.locator('#a-lufs').innerText();
  await page.locator('#dsp-gain').fill('6'); await page.locator('#process-button').click();
  await expect(page.locator('#wav-button')).toBeEnabled();
  const b = await page.locator('#b-lufs').innerText();
  expect(parseFloat(b) - parseFloat(a)).toBeCloseTo(6, 1);
  await expect(page.locator('#processing-result')).toContainText('ゲイン 6.0');
  await page.locator('#match-toggle').check();
  await page.locator('#volume').fill('0');
  const getWav = async () => {
    const download = page.waitForEvent('download'); await page.locator('#wav-button').click();
    const saved = await download; const bytes = await readFile((await saved.path())!);
    await expect(page.locator('#wav-button')).toBeEnabled();
    return bytes;
  };
  const bytes = await getWav(), decoded = decodeWav(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  expect(decoded.channels).toHaveLength(2); expect(decoded.sampleRate).toBe(48000);
  expect(decoded.channels[0].some(x => Math.abs(x) > 0.1)).toBe(true);
  // Browser-native decoder independently accepts the generated Float32/fact layout.
  const native = await page.evaluate(async bytes => {
    const c = new OfflineAudioContext(2, 1, 48000);
    const a = await c.decodeAudioData(Uint8Array.from(bytes).buffer);
    return { rate: a.sampleRate, frames: a.length, channels: a.numberOfChannels };
  }, Array.from(bytes));
  expect(native).toEqual({ rate: 48000, frames: 288000, channels: 2 });
  await page.locator('#process-button').click(); await expect(page.locator('#wav-button')).toBeEnabled();
  expect(await getWav()).toEqual(bytes); await expect(page.locator('#a-lufs')).toHaveText(a);
  await page.screenshot({ path: 'test-results/phase3-desktop.png', fullPage: true });
  expect(errors).toEqual([]); expect(external).toEqual([]);
});

test('bypass retains exact A and cancellation/invalid settings retain prior B', async ({ page }) => {
  await page.goto('/'); await page.getByText('Advanced Settings', { exact: true }).click(); const input = tone({ seconds: 0.5, amplitude: 0.1 });
  await page.locator('#file-input').setInputFiles({ name: 'a.wav', mimeType: 'audio/wav', buffer: Buffer.from(wav(input, 32, true)) });
  await expect(page.locator('#process-button')).toBeEnabled();
  await page.locator('#dsp-bypass').check(); await page.locator('#dsp-gain').fill('12');
  await page.locator('#process-button').click(); await expect(page.locator('#wav-button')).toBeEnabled();
  await expect(page.locator('#processing-result')).toContainText('全体バイパス');
  const download = page.waitForEvent('download'); await page.locator('#wav-button').click();
  const bytes = await readFile((await (await download).path())!);
  expect(decodeWav(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)).toEqual(input);
  await expect(page.locator('#process-button')).toBeEnabled();
  await page.locator('#dsp-gain').fill('13'); await page.locator('#process-button').click();
  await expect(page.locator('#error')).toBeVisible(); await expect(page.locator('#wav-button')).toBeEnabled();
  await page.locator('#dsp-gain').fill('0');
  await page.evaluate(() => { document.getElementById('process-button')!.click(); document.getElementById('cancel-button')!.click(); });
  await expect(page.getByRole('status')).toContainText('キャンセル'); await expect(page.locator('#wav-button')).toBeEnabled();
  await page.locator('#clear-b').click(); await expect(page.locator('#wav-button')).toBeDisabled();
});

test('EQ/limiter result and mobile layout', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/'); await page.getByText('Advanced Settings', { exact: true }).click();
  await page.locator('#file-input').setInputFiles({ name: 'hot.wav', mimeType: 'audio/wav', buffer: Buffer.from(wav(tone({ amplitude: 0.8 }), 32, true)) });
  await expect(page.locator('#process-button')).toBeEnabled();
  await page.locator('#dsp-gain').fill('12'); await page.locator('#eq-enabled').check(); await page.locator('#eq-gain').fill('6');
  await page.locator('#process-button').click(); await expect(page.locator('#wav-button')).toBeEnabled();
  expect(Number(await page.locator('#true-peak').innerText())).toBeLessThanOrEqual(-1);
  await expect(page.locator('#processing-result')).toContainText('EQ 1000 Hz / 6 dB');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/phase3-mobile.png', fullPage: true });
});
