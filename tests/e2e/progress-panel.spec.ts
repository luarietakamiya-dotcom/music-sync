import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { tone, wav } from '../helpers/audio';

const audioFile = () => ({
  name: 'progress-fixture.wav',
  mimeType: 'audio/wav',
  buffer: Buffer.from(wav(tone({ sampleRate: 16000, seconds: 2, amplitude: 0.08 }))),
});

test('central loading panel stays in the viewport and cancellation preserves the committed comparison', async ({ page }) => {
  await page.goto('/');
  await page.locator('#compare-demo-button').click();
  await expect(page.locator('#select-b')).toBeEnabled();
  const a = await page.locator('#a-name').innerText();
  const b = await page.locator('#b-name').innerText();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/workers.json', async route => {
    await held;
    await route.continue();
  });
  try {
    await page.locator('#file-input').setInputFiles(audioFile());
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await expect(page.locator('#processing-overlay')).toBeVisible();
    await expect(page.locator('#processing-task')).toContainText('読み込み');
    await expect(page.locator('#processing-percent')).toContainText('準備中');
    await expect(page.locator('#progress')).not.toHaveAttribute('value');
    const box = await page.locator('#processing-card').boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y).toBeGreaterThan(0);
    expect(box!.y + box!.height).toBeLessThan(page.viewportSize()!.height);
    await page.locator('#cancel-button').click();
    await expect(page.locator('#processing-overlay')).toBeHidden();
    await expect(page.locator('#a-name')).toHaveText(a);
    await expect(page.locator('#b-name')).toHaveText(b);
    await expect(page.locator('#select-b')).toBeEnabled();
  } finally { release(); }
});

test('mocked analysis progress shows its actual percentage and a later failure closes the central panel', async ({ page }) => {
  const manifest = JSON.parse(await readFile('apps/web/dist/workers.json', 'utf8'));
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/progress-test-release', async route => {
    await held;
    await route.fulfill({ contentType: 'text/plain', body: 'release' });
  });
  // The mock exercises the existing progress/error protocol without depending on CPU speed.
  const mock = `self.onmessage = async () => {
    self.postMessage({ type: 'progress', fraction: 0.42 });
    await fetch('/progress-test-release');
    self.postMessage({ type: 'error', message: 'Progress fixture failed' });
  };`;
  await page.route('**/assets/progress-analysis-fixture.js', route => route.fulfill({
    contentType: 'text/javascript', body: mock,
  }));
  await page.route('**/workers.json', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ ...manifest, analysis: 'assets/progress-analysis-fixture.js' }),
  }));
  await page.goto('/');
  try {
    await page.locator('#file-input').setInputFiles(audioFile());
    await expect(page.locator('#processing-overlay')).toBeVisible();
    await expect(page.locator('#processing-percent')).toHaveText('42%');
    await expect(page.locator('#progress')).toHaveAttribute('value', '0.42');
    await expect(page.locator('#processing-task')).toContainText('音響解析');
    release();
    await expect(page.locator('#error')).toContainText('Progress fixture failed');
    await expect(page.locator('#processing-overlay')).toBeHidden();
    await expect(page.locator('#cancel-button')).toBeHidden();
  } finally { release(); }
});

test('mobile processing panel is centered, fits the screen and closes after successful completion', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.locator('#demo-button').click();
  await expect(page.locator('#mode-AUTO')).toBeEnabled();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/workers.json', async route => {
    await held;
    await route.continue();
  });
  try {
    await page.locator('#mode-AUTO').click();
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await expect(page.locator('#processing-overlay')).toBeVisible();
    await expect(page.locator('#cancel-button')).toBeEnabled();
    const box = await page.locator('#processing-card').boundingBox();
    expect(box).not.toBeNull();
    expect(Math.abs(box!.x + box!.width / 2 - 195)).toBeLessThan(4);
    expect(Math.abs(box!.y + box!.height / 2 - 422)).toBeLessThan(4);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await page.screenshot({ path: 'test-results/processing-panel-mobile.png' });
    release();
    await expect(page.locator('#finish-explanation')).toContainText('候補を用意しました');
    await expect(page.locator('#processing-overlay')).toBeHidden();
    await expect(page.locator('#select-b')).toBeEnabled();
  } finally { release(); }
});
