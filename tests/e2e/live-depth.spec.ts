import { test, expect } from '@playwright/test';
import { perceptualFixture } from '../fixtures/perceptual';
import { wav } from '../helpers/audio';

test('clearer LIVE selects a concert hall and keeps matched comparison, Original and export', async ({ page }) => {
  const input = perceptualFixture('balanced'), errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await page.locator('#file-input').setInputFiles({ name: 'dry-arrangement.wav', mimeType: 'audio/wav', buffer: Buffer.from(wav(input, 32, true)) });
  await expect(page.locator('#mode-LIVE')).toBeEnabled();
  const a = await page.locator('#a-lufs').innerText();
  await page.locator('#mode-LIVE').click();
  await expect(page.locator('#finish-explanation')).toContainText('LIVEの候補を用意しました');
  await expect(page.locator('#finish-explanation')).toContainText('ホール');
  await expect(page.locator('#match-toggle')).toBeChecked();
  await expect(page.locator('#a-lufs')).toHaveText(a);
  const venue = await page.locator('#finish-details').evaluate(el => {
    const report = JSON.parse(el.textContent!.split('Complete report / all attempts\n\n')[1]);
    return report.attempts.at(-1).mix.stages.find((s: { kind: string }) => s.kind === 'live').parameters.venue;
  });
  expect(venue).toBe('concert-hall');
  await page.locator('#select-a').click(); await page.locator('#select-b').click();
  const saved = page.waitForEvent('download'); await page.locator('#wav-button').click();
  expect((await saved).suggestedFilename()).toMatch(/\.wav$/i);
  await page.screenshot({ path: 'test-results/live-small-hall.png', fullPage: true });
  expect(errors).toEqual([]);
});
