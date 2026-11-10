import { test, expect } from '@playwright/test';
import { tone, wav } from '../helpers/audio';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

test('demo, waveform, analysis JSON and preview work without external requests', async ({ page }) => {
  const external: string[] = [], errors: string[] = [];
  page.on('request', request => { if (!request.url().startsWith('http://127.0.0.1:4173') && !request.url().startsWith('blob:')) external.push(request.url()); });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await page.getByRole('button', { name: 'デモ音源を解析' }).click();
  await expect(page.getByRole('status')).toContainText('解析完了');
  await expect(page.locator('#lufs')).not.toHaveText('—');
  await expect(page.locator('#correlation')).not.toHaveText('—');
  await expect(page.locator('#wave-placeholder')).toBeHidden();
  const drawn = await page.locator('canvas').evaluate(canvas => {
    const context = (canvas as HTMLCanvasElement).getContext('2d')!;
    return context.getImageData(0, 0, (canvas as HTMLCanvasElement).width, (canvas as HTMLCanvasElement).height).data.some((v, i) => i % 4 === 3 && v > 0);
  });
  expect(drawn).toBe(true);
  await page.getByRole('button', { name: '再生', exact: true }).click();
  await expect(page.getByRole('button', { name: '一時停止', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '停止', exact: true }).click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '解析JSONを書き出す' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('music-sync-analysis.json');
  const report = JSON.parse(readFileSync((await download.path())!, 'utf8'));
  expect(report.schemaVersion).toBe(1); expect(report.channels).toBe(2);
  expect(external).toEqual([]); expect(errors).toEqual([]);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: 'test-results/phase1-desktop.png', fullPage: true });
});

test('actual file input, malicious filename, malformed file and replacement', async ({ page }) => {
  await page.goto('/');
  const fileInput = page.locator('#file-input');
  const buffer = Buffer.from(wav(tone({ sampleRate: 44100, seconds: 1, stereo: true }), 24));
  await fileInput.setInputFiles({ name: '<img src=x onerror=alert(1)>.wav', mimeType: 'audio/wav', buffer });
  await expect(page.getByRole('status')).toContainText('解析完了');
  await expect(page.locator('#track-name')).toHaveText('<img src=x onerror=alert(1)>.wav');
  await expect(page.locator('#track-name img')).toHaveCount(0);
  await expect(page.locator('#track-meta')).toContainText('44.1 kHz');
  await fileInput.setInputFiles({ name: 'broken.wav', mimeType: 'audio/wav', buffer: Buffer.from('not audio') });
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.locator('#lufs')).not.toHaveText('—');
  await expect(page.locator('#track-name')).toHaveText('<img src=x onerror=alert(1)>.wav');
  await expect(page.getByRole('button', { name: '再生', exact: true })).toBeEnabled();
  await fileInput.setInputFiles({ name: 'valid.wav', mimeType: 'audio/wav', buffer });
  await expect(page.getByRole('status')).toContainText('解析完了');
  await expect(page.getByRole('alert')).toBeHidden();
});

test('drag and drop and cancelled job do not publish stale results', async ({ page }) => {
  await page.goto('/');
  const bytes = Array.from(new Uint8Array(wav(tone({ seconds: 0.1 }))));
  await page.locator('#dropzone').evaluate((target, values) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(values)], 'dropped.wav', { type: 'audio/wav' }));
    target.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true }));
  }, bytes);
  await expect(page.getByRole('status')).toContainText('解析完了');
  await expect(page.locator('#track-name')).toHaveText('dropped.wav');
  await expect(page.locator('#lufs')).toHaveText('—');
  // Dispatch start and cancel in one event turn to make the race deterministic.
  await page.evaluate(() => { document.getElementById('demo-button')!.click(); document.getElementById('cancel-button')!.click(); });
  await expect(page.getByRole('status')).toContainText('キャンセル');
  await expect(page.locator('#lufs')).toHaveText('—');
  await page.getByRole('button', { name: 'デモ音源を解析' }).click();
  await expect(page.getByRole('status')).toContainText('解析完了');
});

test('FLAC file decodes at its source rate', async ({ page }) => {
  await page.goto('/');
  await page.locator('#file-input').setInputFiles(resolve('tests/fixtures/tone.flac'));
  await expect(page.getByRole('status')).toContainText('解析完了');
  await expect(page.locator('#track-meta')).toContainText('44.1 kHz');
  await expect(page.locator('#lufs')).not.toHaveText('—');
});

test('mobile viewport has no horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: 'デモ音源を解析' }).click();
  await expect(page.getByRole('status')).toContainText('解析完了');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/phase1-mobile.png', fullPage: true });
});
