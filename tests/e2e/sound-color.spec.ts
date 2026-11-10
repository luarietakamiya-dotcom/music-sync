import { test, expect } from '@playwright/test';
import { wav } from '../helpers/audio';
import { perceptualFixture } from '../fixtures/perceptual';

test('sound choices, intensity, matched A/B, original protection, report and WAV export', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/');
  await expect(page.locator('#sound-color-preset option')).toHaveCount(10);
  await expect(page.locator('#sound-color-apply')).toBeDisabled();
  const input = perceptualFixture('balanced');
  await page.locator('#file-input').setInputFiles({ name: 'song.wav', mimeType: 'audio/wav', buffer: Buffer.from(wav(input, 32, true)) });
  await expect(page.locator('#sound-color-apply')).toBeEnabled();
  const a = await page.locator('#a-lufs').innerText();
  await page.locator('#sound-color-preset').selectOption('old-record');
  await page.locator('#sound-color-intensity').selectOption('vivid');
  await expect(page.locator('#sound-color-description')).toContainText('針');
  await page.locator('#sound-color-apply').click();
  await expect(page.locator('#sound-color-result')).toContainText('適用済み：古いレコード（はっきり）');
  await expect(page.locator('#match-toggle')).toBeChecked(); await expect(page.locator('#a-lufs')).toHaveText(a);
  await page.locator('#select-a').click(); await page.locator('#select-b').click();
  const firstB = await page.locator('#b-lufs').innerText();
  await page.locator('#sound-color-preset').selectOption('telephone');
  await expect(page.locator('#b-lufs')).toHaveText(firstB); // selection does not overwrite B
  await page.locator('#sound-color-apply').click();
  await expect(page.locator('#sound-color-result')).toContainText('適用済み：電話の向こう');
  await expect(page.locator('#a-lufs')).toHaveText(a);
  await page.locator('section[aria-labelledby="auto-heading"]').screenshot({ path: 'test-results/sound-color-presets.png' });
  await page.locator('#advanced-settings').evaluate((el: HTMLDetailsElement) => { el.open = true; });
  const report = page.waitForEvent('download'); await page.locator('#finish-report-button').click();
  expect((await report).suggestedFilename()).toContain('report-anonymous.json');
  const saved = page.waitForEvent('download'); await page.locator('#wav-button').click();
  expect((await saved).suggestedFilename()).toMatch(/\.wav$/i);
  await page.locator('#undo-finish').click(); await expect(page.locator('#select-b')).toBeDisabled();
  expect(errors).toEqual([]);
});

test('AUTO respects the selected sound colour, and cancellation preserves prior B', async ({ page }) => {
  await page.goto('/');
  const input = perceptualFixture('balanced');
  await page.locator('#file-input').setInputFiles({ name: 'song.wav', mimeType: 'audio/wav', buffer: Buffer.from(wav(input, 32, true)) });
  await expect(page.locator('#sound-color-apply')).toBeEnabled();
  await page.locator('#sound-color-preset').selectOption('am-radio'); await page.locator('#mode-AUTO').click();
  await expect(page.locator('#finish-explanation')).toContainText('AUTOの候補を用意しました');
  await expect(page.locator('#sound-color-result')).toContainText('適用済み：AMラジオ');
  await expect(page.locator('#match-toggle')).toBeChecked();
  const b = await page.locator('#b-lufs').innerText();
  await page.locator('#sound-color-preset').selectOption('cassette'); await page.locator('#sound-color-apply').click();
  await page.locator('#cancel-button').click();
  await expect(page.locator('#status')).toContainText('キャンセル'); await expect(page.locator('#b-lufs')).toHaveText(b);
  await expect(page.locator('#sound-color-apply')).toBeEnabled();
});

test('sound-colour controls fit a mobile viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/');
  await page.locator('#sound-color-preset').selectOption('cassette');
  await expect(page.locator('#sound-color-description')).toContainText('テープ');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.locator('#sound-color-heading').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/sound-color-mobile.png', fullPage: true });
});
