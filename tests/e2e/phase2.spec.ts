import { test, expect } from '@playwright/test';
import { tone, wav } from '../helpers/audio';

test('A/B demo, matching, shared seek/pause and source measurements', async ({ page }) => {
  const errors: string[] = [], external: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (!request.url().startsWith('http://127.0.0.1:4173') && !request.url().startsWith('blob:')) external.push(request.url()); });
  await page.goto('/');
  await page.getByRole('button', { name: '音量差デモを試す' }).click();
  await expect(page.locator('#select-b')).toBeEnabled();
  await expect(page.locator('#b-lufs')).not.toHaveText('—');
  await expect(page.locator('#match-mode')).toHaveText('RAW');
  const bLufs = await page.locator('#lufs').innerText();
  await page.getByLabel('ラウドネスマッチ', { exact: true }).check();
  await expect(page.locator('#match-mode')).toHaveText('LOUDNESS MATCHED');
  await expect(page.locator('#b-gain')).toHaveText('-6.0 dB');
  await expect(page.locator('#a-gain')).toHaveText('0.0 dB');
  await expect(page.locator('#lufs')).toHaveText(bLufs);
  await page.locator('#seek').evaluate(input => { (input as HTMLInputElement).value = '2'; input.dispatchEvent(new Event('input', { bubbles: true })); });
  await expect(page.locator('#play-time')).toContainText('0:02.0');
  await page.getByRole('button', { name: '再生', exact: true }).click();
  await page.waitForFunction(() => Number((document.getElementById('seek') as HTMLInputElement).value) > 2.15);
  const before = Number(await page.locator('#seek').inputValue());
  await page.getByRole('button', { name: 'A / Beforeを聴く' }).click();
  await expect(page.locator('#select-a')).toHaveAttribute('aria-pressed', 'true');
  const after = Number(await page.locator('#seek').inputValue());
  expect(after).toBeGreaterThanOrEqual(before - 0.03); expect(after - before).toBeLessThan(0.5);
  await page.getByRole('button', { name: '一時停止', exact: true }).click();
  const paused = await page.locator('#seek').inputValue();
  await page.getByRole('button', { name: 'B / Afterを聴く' }).click();
  await expect(page.locator('#seek')).toHaveValue(paused);
  await page.getByLabel('ラウドネスマッチ', { exact: true }).uncheck();
  await expect(page.locator('#b-gain')).toHaveText('0.0 dB');
  await page.getByRole('button', { name: '停止', exact: true }).click();
  await expect(page.locator('#seek')).toHaveValue('0');
  expect(errors).toEqual([]); expect(external).toEqual([]);
  await page.getByLabel('ラウドネスマッチ', { exact: true }).check();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: 'test-results/phase2-desktop.png', fullPage: true });
});

test('shorter/silent B uses the common interval and disables undefined matching', async ({ page }) => {
  await page.goto('/');
  await page.locator('#file-input').setInputFiles({ name: 'before.wav', mimeType: 'audio/wav', buffer: Buffer.from(wav(tone({ seconds: 2 }))) });
  await expect(page.locator('#select-a')).toBeEnabled();
  await page.locator('#file-input-b').setInputFiles({ name: 'silence.wav', mimeType: 'audio/wav', buffer: Buffer.from(wav(tone({ amplitude: 0, seconds: 1 }))) });
  await expect(page.locator('#select-b')).toBeEnabled();
  await expect(page.locator('#comparison-status')).toContainText('短い方の末尾まで');
  await expect(page.locator('#comparison-status')).toContainText('LUFSを測定できない');
  await expect(page.locator('#match-toggle')).toBeDisabled();
  await expect(page.locator('#seek')).toHaveAttribute('max', '1');
  await page.getByRole('button', { name: 'A / Beforeを聴く' }).click();
  await page.getByRole('button', { name: '再生', exact: true }).click();
  await expect(page.getByRole('button', { name: '一時停止', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '再生', exact: true })).toBeVisible({ timeout: 5000 });
  await expect(page.locator('#seek')).toHaveValue('0');
  await page.getByRole('button', { name: 'Bを解除', exact: true }).click();
  await expect(page.locator('#seek')).toHaveAttribute('max', '2');
});

test('mismatched rate, malformed and cancelled B leave A available; replacing A clears B', async ({ page }) => {
  await page.goto('/');
  await page.locator('#file-input').setInputFiles({ name: 'before.wav', mimeType: 'audio/wav', buffer: Buffer.from(wav(tone())) });
  await expect(page.locator('#select-a')).toBeEnabled();
  await page.locator('#file-input-b').setInputFiles({ name: 'wrong-rate.wav', mimeType: 'audio/wav', buffer: Buffer.from(wav(tone({ sampleRate: 44100 }))) });
  await expect(page.getByRole('alert')).toContainText('同じサンプルレート');
  await expect(page.locator('#select-b')).toBeDisabled();
  await expect(page.locator('#track-name')).toHaveText('before.wav');
  await page.locator('#file-input-b').setInputFiles({ name: 'bad.wav', mimeType: 'audio/wav', buffer: Buffer.from('broken') });
  await expect(page.getByRole('alert')).toContainText('RIFF');
  const bytes = Array.from(new Uint8Array(wav(tone({ seconds: 0.1 }))));
  await page.locator('#card-b').evaluate((target, data) => {
    const transfer = new DataTransfer(); transfer.items.add(new File([new Uint8Array(data)], 'cancel.wav'));
    target.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true }));
    document.getElementById('cancel-button')!.click();
  }, bytes);
  await expect(page.getByRole('status', { name: '処理状況' })).toContainText('キャンセル');
  await expect(page.locator('#select-a')).toBeEnabled();
  await expect(page.locator('#select-b')).toBeDisabled();
  await page.locator('#file-input-b').setInputFiles({ name: 'valid-b.wav', mimeType: 'audio/wav', buffer: Buffer.from(wav(tone({ amplitude: 0.2 }))) });
  await expect(page.locator('#select-b')).toBeEnabled();
  await page.locator('#file-input').setInputFiles({ name: 'new-a.wav', mimeType: 'audio/wav', buffer: Buffer.from(wav(tone())) });
  await expect(page.locator('#track-name')).toHaveText('new-a.wav');
  await expect(page.locator('#select-b')).toBeDisabled();
  await expect(page.locator('#match-toggle')).not.toBeChecked();
});

test('comparison controls remain accessible on a mobile viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: '音量差デモを試す' }).click();
  await expect(page.locator('#select-b')).toBeEnabled();
  await page.getByLabel('ラウドネスマッチ', { exact: true }).check();
  await page.getByRole('button', { name: 'A / Beforeを聴く' }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: 'test-results/phase2-mobile.png', fullPage: true });
});
