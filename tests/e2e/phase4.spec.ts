import { test, expect } from '@playwright/test';
import { tone, wav } from '../helpers/audio';

test('shows proposal, masters to target, supports matched comparison and export', async ({ page }) => {
  const errors: string[] = [], external: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { if (!r.url().startsWith('http://127.0.0.1:4173') && !r.url().startsWith('blob:')) external.push(r.url()); });
  await page.goto('/'); await page.getByText('Advanced Settings', { exact: true }).click(); await page.locator('#demo-button').click();
  await expect(page.locator('#master-button')).toBeEnabled();
  await expect(page.locator('#master-plan')).toContainText('補正案');
  const a = await page.locator('#a-lufs').innerText();
  await page.locator('#master-button').click();
  await expect(page.locator('#master-outcome')).toContainText('採用：');
  await expect(page.locator('#wav-button')).toBeEnabled();
  expect(Math.abs(parseFloat(await page.locator('#b-lufs').innerText()) + 14)).toBeLessThanOrEqual(0.5);
  await expect(page.locator('#a-lufs')).toHaveText(a);
  await page.locator('#match-toggle').check();
  await page.locator('#select-a').click(); await page.locator('#select-b').click();
  const download = page.waitForEvent('download'); await page.locator('#wav-button').click();
  expect((await download).suggestedFilename()).toContain('.wav');
  await expect(page.locator('#master-button')).toBeEnabled();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: 'test-results/phase4-desktop.png', fullPage: true });
  expect(errors).toEqual([]); expect(external).toEqual([]);
});

test('rejected candidate, cancelled job and invalid settings preserve existing B', async ({ page }) => {
  await page.goto('/'); await page.getByText('Advanced Settings', { exact: true }).click();
  const source = tone({ amplitude: 0.2, seconds: 0.5, frequency: 100 });
  await page.locator('#file-input').setInputFiles({ name: 'a.wav', mimeType: 'audio/wav', buffer: Buffer.from(wav(source)) });
  await expect(page.locator('#process-button')).toBeEnabled();
  await page.locator('#process-button').click(); await expect(page.locator('#wav-button')).toBeEnabled();
  const bName = await page.locator('#b-name').innerText(), bLufs = await page.locator('#b-lufs').innerText();
  await page.locator('#master-target').fill('-9'); await page.locator('#master-ceiling').fill('-6');
  await page.locator('#master-button').click(); await expect(page.locator('#master-outcome')).toContainText('保留：');
  await expect(page.locator('#master-outcome')).toContainText('Aと既存Bは変更していません');
  await expect(page.locator('#b-name')).toHaveText(bName); await expect(page.locator('#b-lufs')).toHaveText(bLufs);
  await expect(page.locator('#wav-button')).toBeEnabled();
  await page.locator('#master-target').fill('-30'); await expect(page.locator('#master-button')).toBeDisabled();
  await page.locator('#master-target').fill('-14'); await page.locator('#master-ceiling').fill('-1');
  await page.evaluate(() => { document.getElementById('master-button')!.click(); document.getElementById('cancel-button')!.click(); });
  await expect(page.getByRole('status')).toContainText('キャンセル');
  await expect(page.locator('#b-name')).toHaveText(bName); await expect(page.locator('#b-lufs')).toHaveText(bLufs);
  await page.locator('#file-input').setInputFiles({ name: 'silence.wav', mimeType: 'audio/wav', buffer: Buffer.from(wav(tone({ amplitude: 0, seconds: 0.5 }))) });
  await expect(page.locator('#select-a')).toBeEnabled();
  await expect(page.locator('#master-button')).toBeDisabled(); await expect(page.locator('#master-plan')).toContainText('LUFSを測定できない');
  await expect(page.locator('#master-outcome')).toBeEmpty();
});

test('mobile mastering controls stay within viewport and no-op is explained', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/'); await page.getByText('Advanced Settings', { exact: true }).click(); await page.locator('#demo-button').click();
  await expect(page.locator('#master-button')).toBeEnabled();
  await page.locator('#master-target').fill(parseFloat(await page.locator('#a-lufs').innerText()).toString());
  await expect(page.locator('#master-plan')).toContainText('変更なし');
  await page.locator('#master-button').click(); await expect(page.locator('#master-outcome')).toContainText('変更なし（バイパス）');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: 'test-results/phase4-mobile.png', fullPage: true });
});
