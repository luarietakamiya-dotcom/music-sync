import { expect, test } from '@playwright/test';

test('optional workspaces start collapsed and native summaries toggle with the keyboard', async ({ page }) => {
  await page.goto('/');
  const reference = page.locator('#reference-panel'), batch = page.locator('#batch-panel');
  await expect(reference).toHaveJSProperty('open', false); await expect(batch).toHaveJSProperty('open', false);
  await expect(page.locator('#reference-input')).toBeHidden(); await expect(page.locator('#batch-input')).toBeHidden();
  const referenceSummary = page.locator('#reference-panel > summary'), batchSummary = page.locator('#batch-panel > summary');
  await referenceSummary.focus(); await referenceSummary.press('Enter');
  await expect(reference).toHaveJSProperty('open', true); await expect(page.locator('#reference-input')).toBeVisible();
  await expect(batch).toHaveJSProperty('open', false);
  await referenceSummary.press('Space'); await expect(reference).toHaveJSProperty('open', false);
  await batchSummary.focus(); await batchSummary.press('Enter');
  await expect(batch).toHaveJSProperty('open', true); await expect(page.locator('#batch-input')).toBeVisible();
  await expect(reference).toHaveJSProperty('open', false);
  await batchSummary.press('Space'); await expect(batch).toHaveJSProperty('open', false);
  await expect(page.locator('#processing-overlay')).toBeHidden();
});

test('workspace links and explicit deep links open their target without changing the default collapsed view', async ({ page }) => {
  await page.goto('/');
  const reference = page.locator('#reference-panel'), batch = page.locator('#batch-panel');
  const referenceLink = page.locator('.easy-links a[href="#reference-heading"]');
  await referenceLink.click(); await expect(reference).toHaveJSProperty('open', true);
  await expect(page.locator('#reference-input')).toBeVisible(); await expect(batch).toHaveJSProperty('open', false);
  await page.locator('#reference-panel > summary').click(); await expect(reference).toHaveJSProperty('open', false);
  await referenceLink.click(); await expect(reference).toHaveJSProperty('open', true);
  await page.locator('.easy-links a[href="#batch-heading"]').click();
  await expect(batch).toHaveJSProperty('open', true); await expect(page.locator('#batch-input')).toBeVisible();
  await page.goto('/?panels=reference#reference-heading');
  await expect(reference).toHaveJSProperty('open', true); await expect(batch).toHaveJSProperty('open', false);
  await page.reload(); await expect(reference).toHaveJSProperty('open', true);
  await page.goto('/?panels=batch#batch-heading');
  await expect(batch).toHaveJSProperty('open', true); await expect(reference).toHaveJSProperty('open', false);
  await page.goto('/?panels=default');
  await expect(reference).toHaveJSProperty('open', false); await expect(batch).toHaveJSProperty('open', false);
});

test('desktop notification volume is visible above import, spans zero to full and persists locally', async ({ page }) => {
  await page.goto('/');
  const settings = page.locator('#notification-settings'), volume = page.locator('#se-volume');
  await expect(settings).toBeVisible(); await expect(volume).toBeVisible(); await expect(volume).toBeEnabled();
  await expect(page.locator('#se-enabled')).toBeChecked(); await expect(volume).toHaveValue('25');
  await expect(volume).toHaveAttribute('min', '0'); await expect(volume).toHaveAttribute('max', '100');
  expect(await page.locator('#se-volume-value').evaluate(element => element.tagName)).toBe('SPAN');
  await expect(page.locator('.topbar a[href="#notification-settings"]')).toHaveText('SE音量');
  const position = await settings.boundingBox(), drop = await page.locator('#dropzone').boundingBox();
  expect(position!.y).toBeGreaterThanOrEqual(0); expect(position!.y + position!.height).toBeLessThanOrEqual(drop!.y);
  await volume.focus(); await volume.press('Home');
  await expect(volume).toHaveValue('0'); await expect(page.locator('#se-volume-value')).toHaveText('0%');
  await volume.press('End'); await expect(volume).toHaveValue('100'); await expect(page.locator('#se-volume-value')).toHaveText('100%');
  await page.locator('#se-enabled').uncheck(); await page.reload();
  await expect(page.locator('#se-enabled')).not.toBeChecked(); await expect(volume).toHaveValue('100');
  await expect(page.locator('#se-volume-value')).toHaveText('100%'); await expect(settings).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
});

test('mobile keeps SE controls in view and optional panels usable without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/');
  const settings = page.locator('#notification-settings'), volume = page.locator('#se-volume');
  await expect(page.locator('#reference-panel')).toHaveJSProperty('open', false);
  await expect(page.locator('#batch-panel')).toHaveJSProperty('open', false);
  await expect(volume).toBeVisible(); await expect(page.locator('#se-enabled')).toBeChecked();
  const box = await settings.boundingBox(), slider = await volume.boundingBox();
  expect(box!.y).toBeGreaterThanOrEqual(0); expect(box!.y + box!.height).toBeLessThanOrEqual(844);
  expect(slider!.x).toBeGreaterThanOrEqual(0); expect(slider!.x + slider!.width).toBeLessThanOrEqual(390);
  await volume.focus(); await volume.press('Home'); await volume.press('ArrowRight');
  await expect(volume).toHaveValue('1'); await expect(page.locator('#se-volume-value')).toHaveText('1%');
  await page.reload(); await expect(volume).toHaveValue('1');
  for (const id of ['reference-panel', 'batch-panel']) {
    await page.locator('#' + id + ' > summary').click();
    await expect(page.locator('#' + id)).toHaveJSProperty('open', true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  }
  await page.locator('#notification-settings').scrollIntoViewIfNeeded(); await expect(volume).toBeVisible();
  await page.screenshot({ path: 'test-results/workspace-panels-mobile.png' });
});
