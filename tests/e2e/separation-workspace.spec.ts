import { expect, test, type Page } from '@playwright/test';
import { tone, wav } from '../helpers/audio';

const fixture = (name: string) => ({ name, mimeType: 'audio/wav',
  buffer: Buffer.from(wav(tone({ sampleRate: 24000, seconds: 1, stereo: true }), 16)) });
async function pair(page: Page) {
  return Promise.all(['a-name', 'b-name', 'a-lufs', 'b-lufs'].map(id => page.locator('#' + id).innerText()));
}
async function importPair(page: Page) {
  await page.locator('#file-input').setInputFiles(fixture('original.wav'));
  await expect(page.getByRole('status', { name: '処理状況', exact: true })).toContainText('解析完了');
  await page.locator('#file-input-b').setInputFiles(fixture('comparison.wav'));
  await expect(page.locator('#b-name')).toContainText('comparison.wav');
  await expect(page.locator('#select-b')).toBeEnabled();
}
function observeModelRequests(page: Page) {
  const requests: string[] = [];
  page.on('request', request => { if (/\.onnx(?:\?|$)|ort-wasm/.test(request.url())) requests.push(request.url()); });
  return requests;
}

test('PC separation selection is explicit and never replaces the existing Original / Processed pair', async ({ page }) => {
  const models = observeModelRequests(page);
  await page.goto('/');
  await expect(page.locator('#separation-panel')).toHaveJSProperty('open', false);
  await importPair(page);
  const before = await pair(page);
  await page.locator('#separation-panel > summary').click();
  await expect(page.locator('#separation-heading')).toContainText('PC専用');
  await expect(page.locator('#separation-run')).toBeEnabled();
  await page.locator('#separation-input').setInputFiles(fixture('<img src=x onerror=alert(1)>.wav'));
  await expect(page.locator('#separation-source-name')).toContainText('<img src=x onerror=alert(1)>.wav');
  await expect(page.locator('#separation-source-name img')).toHaveCount(0);
  await page.locator('#separation-mode').selectOption('two');
  await expect(page.locator('#separation-stage')).toBeDisabled();
  await expect(page.locator('#separation-results audio')).toHaveCount(0);
  expect(await pair(page)).toEqual(before);
  await page.locator('#separation-clear').click();
  await expect(page.locator('#separation-source-name')).toContainText('現在のOriginal');
  await expect(page.locator('#separation-run')).toBeEnabled();
  expect(await pair(page)).toEqual(before); expect(models).toEqual([]);
});

test('cancelling separation startup releases the shared job slot and preserves A/B without loading the model', async ({ page }) => {
  const models = observeModelRequests(page);
  await page.goto('/');
  await importPair(page);
  const before = await pair(page);
  await page.locator('#separation-panel > summary').click();
  // Hold the real deployment lookup, before a separation Worker or model starts.
  let entered = false, release!: () => void, complete!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const completed = new Promise<void>(resolve => { complete = resolve; });
  await page.route('**/workers.json', async route => {
    entered = true; await gate;
    try { await route.continue(); } finally { complete(); }
  });
  try {
    await page.locator('#separation-run').click();
    await expect.poll(() => entered).toBe(true);
    await expect(page.locator('#processing-overlay')).toBeVisible();
    await expect(page.locator('#separation-input')).toBeDisabled();
    await expect(page.locator('#separation-mode')).toBeDisabled();
    await page.locator('#cancel-button').click();
    release(); await completed;
    await expect(page.locator('#processing-overlay')).toBeHidden();
    await expect(page.locator('#separation-status')).toContainText('キャンセル');
    await expect(page.locator('#separation-run')).toBeEnabled();
    await expect(page.locator('#file-input')).toBeEnabled();
    await expect(page.locator('#select-b')).toBeEnabled();
    expect(await pair(page)).toEqual(before); expect(models).toEqual([]);
  } finally {
    release(); if (entered) await completed; await page.unroute('**/workers.json');
  }
});

test.describe('phone separation guard', () => {
  test.use({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1',
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  test('only AI separation is unavailable; ordinary import and STEM controls remain usable', async ({ page }) => {
    const models = observeModelRequests(page);
    await page.goto('/'); await page.locator('#separation-panel > summary').click();
    await expect(page.locator('#separation-status')).toContainText('PCでご利用ください');
    for (const id of ['separation-input', 'separation-run', 'separation-mode', 'separation-use-source'])
      await expect(page.locator('#' + id)).toBeDisabled();
    await expect(page.locator('#file-input')).toBeEnabled();
    await expect(page.locator('#stem-file-input')).toBeEnabled();
    await page.locator('#file-input').setInputFiles(fixture('phone-original.wav'));
    await expect(page.getByRole('status', { name: '処理状況', exact: true })).toContainText('解析完了');
    await expect(page.locator('#track-name')).toHaveText('phone-original.wav');
    await expect(page.locator('#separation-run')).toBeDisabled();
    await expect(page.locator('#stem-file-input')).toBeEnabled();
    expect(models).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });
});
