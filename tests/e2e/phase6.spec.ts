import { test, expect } from '@playwright/test';
import { tone, wav } from '../helpers/audio';

test('beginner workflow: one-click finish, matched A/B, export, undo, Advanced stays closed', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/'); await expect(page.locator('#advanced-settings')).not.toHaveAttribute('open', '');
  await page.locator('#demo-button').click(); await expect(page.locator('#mode-AUTO')).toBeEnabled();
  const original = await page.locator('#a-lufs').innerText();
  await page.locator('#mode-AUTO').click();
  await expect(page.locator('#finish-explanation')).toContainText('候補を用意しました');
  await expect(page.locator('#match-toggle')).toBeChecked(); await expect(page.locator('#match-mode')).toHaveText('LOUDNESS MATCHED');
  await page.locator('#select-a').click(); await page.locator('#select-b').click();
  await expect(page.locator('#a-lufs')).toHaveText(original);
  const download = page.waitForEvent('download'); await page.locator('#wav-button').click(); expect((await download).suggestedFilename()).toContain('.wav');
  await expect(page.locator('#undo-finish')).toBeEnabled();
  await page.screenshot({ path: 'test-results/phase6-desktop.png', fullPage: true });
  await page.locator('#undo-finish').click(); await expect(page.locator('#select-b')).toBeDisabled(); await expect(page.locator('#a-lufs')).toHaveText(original);
  await expect(page.locator('#advanced-settings')).not.toHaveAttribute('open', ''); expect(errors).toEqual([]);
});

test('cancel and mode switching do not publish stale candidates; rejected import retains Original', async ({ page }) => {
  await page.goto('/'); await page.locator('#demo-button').click(); await expect(page.locator('#mode-LIVE')).toBeEnabled();
  await page.evaluate(() => { document.getElementById('mode-LIVE')!.click(); document.getElementById('mode-IMPACT')!.click(); });
  await expect(page.locator('#finish-explanation')).toContainText('IMPACTの候補を用意しました');
  await expect(page.locator('#b-name')).toContainText('IMPACT'); const b = await page.locator('#b-lufs').innerText();
  await page.evaluate(() => { document.getElementById('mode-LIVE')!.click(); document.getElementById('cancel-button')!.click(); });
  await expect(page.getByRole('status')).toContainText('キャンセル'); await expect(page.locator('#b-lufs')).toHaveText(b);
  await page.locator('#file-input').setInputFiles({ name: 'clipped.wav', mimeType: 'audio/wav', buffer: Buffer.from(wav(tone({ amplitude: 1.2 }), 32, true)) });
  await expect(page.locator('#mode-AUTO')).toBeEnabled(); await page.locator('#mode-AUTO').click();
  await expect(page.locator('#finish-explanation')).toContainText('候補を採用しませんでした');
  await expect(page.locator('#select-a')).toBeEnabled(); await expect(page.locator('#select-b')).toBeDisabled();
});

test('LIVE works on mobile and exposes the actual plan in Advanced', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/'); await page.locator('#demo-button').click();
  await expect(page.locator('#mode-LIVE')).toBeEnabled(); await page.locator('#mode-LIVE').click();
  await expect(page.locator('#finish-explanation')).toContainText('LIVEの候補を用意しました');
  await expect(page.locator('#match-toggle')).toBeChecked();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/phase6-mobile.png', fullPage: true });
  await page.getByText('Advanced Settings', { exact: true }).click();
  await expect(page.locator('#finish-details')).toContainText('concert-hall');
  const report = page.waitForEvent('download'); await page.locator('#finish-report-button').click(); expect((await report).suggestedFilename()).toBe('music-sync-finishing-report-anonymous.json');
});
