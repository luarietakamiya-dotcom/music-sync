import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { perceptualFixture } from '../fixtures/perceptual';
import { wav } from '../helpers/audio';

test('venue and intensity selection creates fresh matched candidates, reports the actual setting and exports', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/');
  await expect(page.locator('#live-venue')).toHaveValue('concert-hall');
  await expect(page.locator('#live-intensity')).toHaveValue('vivid');
  await page.locator('#file-input').setInputFiles({ name: 'stage.wav', mimeType: 'audio/wav', buffer: Buffer.from(wav(perceptualFixture('balanced'), 32, true)) });
  await expect(page.locator('#mode-LIVE')).toBeEnabled();
  const a = await page.locator('#a-lufs').innerText();
  for (const [venue, label] of [['live-house', 'ライブハウス'], ['concert-hall', 'ホール'], ['arena', 'アリーナ']]) {
    await page.locator('#live-venue').selectOption(venue);
    await page.locator('#live-intensity').selectOption('standard');
    await page.locator('#mode-LIVE').click();
    await expect(page.locator('#live-result')).toContainText(`適用済み：${label}（標準）`);
    await expect(page.locator('#finish-explanation')).toContainText('LIVEの候補を用意しました');
    await expect(page.locator('#match-toggle')).toBeChecked(); await expect(page.locator('#a-lufs')).toHaveText(a);
  }
  const b = await page.locator('#b-lufs').innerText();
  await page.locator('#live-intensity').selectOption('vivid'); await expect(page.locator('#b-lufs')).toHaveText(b);
  await page.locator('#mode-LIVE').click(); await expect(page.locator('#live-result')).toContainText('アリーナ（はっきり）');
  await page.locator('#select-a').click(); await page.locator('#select-b').click();
  await page.locator('#advanced-settings').evaluate((el: HTMLDetailsElement) => { el.open = true; });
  const event = page.waitForEvent('download'); await page.locator('#finish-report-button').click();
  const report = JSON.parse(await readFile((await (await event).path())!, 'utf8'));
  const last = report.attempts.at(-1);
  expect(last.mix.liveSelection).toEqual({ venue: 'arena', intensity: 'vivid' });
  expect(last.after.clippedSamples).toBe(0); expect(last.quality.accepted).toBe(true);
  const saved = page.waitForEvent('download'); await page.locator('#wav-button').click(); expect((await saved).suggestedFilename()).toContain('.wav');
  await page.locator('#live-settings').screenshot({ path: 'test-results/live-venue-controls.png' });
  expect(errors).toEqual([]);
});

test('new LIVE supports cancellation and mobile controls without replacing prior B', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/');
  await page.locator('#demo-button').click(); await expect(page.locator('#mode-AUTO')).toBeEnabled();
  await page.locator('#mode-AUTO').click(); await expect(page.locator('#finish-explanation')).toContainText('候補を用意しました');
  const b = await page.locator('#b-lufs').innerText();
  await page.locator('#live-venue').selectOption('arena');
  await page.locator('#mode-LIVE').click(); await page.locator('#cancel-button').click();
  await expect(page.locator('#status')).toContainText('キャンセル'); await expect(page.locator('#b-lufs')).toHaveText(b);
  await page.locator('#live-venue').selectOption('live-house'); await page.locator('#mode-LIVE').click();
  await expect(page.locator('#live-result')).toContainText('ライブハウス'); await expect(page.locator('#match-toggle')).toBeChecked();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
