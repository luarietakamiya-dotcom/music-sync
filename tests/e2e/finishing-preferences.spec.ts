import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { analyzeAudio } from '@music-sync/core';
import { perceptualFixture } from '../fixtures/perceptual';
import { tone, wav } from '../helpers/audio';

test('combined adjustments and destination are measured, matched and exported independently of monitoring', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/');
  await page.locator('#file-input').setInputFiles({ name: 'adjust.wav', mimeType: 'audio/wav', buffer: Buffer.from(wav(perceptualFixture('balanced'), 32, true)) });
  await expect(page.locator('#mode-AUTO')).toBeEnabled();
  const original = await page.locator('#a-lufs').innerText();
  await page.locator('#finish-vocal').selectOption('2'); await page.locator('#finish-bass').selectOption('2');
  await page.locator('#finish-punch').selectOption('1'); await page.locator('#finish-density').selectOption('1');
  await page.locator('#output-profile').selectOption('youtube');
  await page.locator('#finish-preferences-apply').click();
  await expect(page.locator('#preferences-result')).toContainText('適用済み：YouTube');
  await expect(page.locator('#preferences-result')).toContainText('ボーカルの存在感');
  await expect(page.locator('#match-toggle')).toBeChecked(); await expect(page.locator('#a-lufs')).toHaveText(original);
  await page.locator('#advanced-settings').evaluate((el: HTMLDetailsElement) => { el.open = true; });
  const downloaded = page.waitForEvent('download'); await page.locator('#finish-report-button').click();
  const report = JSON.parse(await readFile((await (await downloaded).path())!, 'utf8'));
  expect(report.preferences.selection.controls).toMatchObject({ vocal: 2, bass: 2, punch: 1, density: 1 });
  expect(report.preferences.requestedLufs).toBe(-14); expect(report.finalAfter.clippedSamples).toBe(0);
  await page.locator('#select-a').click(); await page.locator('#select-b').click();
  const exported = page.waitForEvent('download'); await page.locator('#wav-button').click();
  const bytes = await readFile((await (await exported).path())!);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect(view.getUint16(20, true)).toBe(3);
  const count = view.getUint16(22, true), sr = view.getUint32(24, true);
  let dataOffset = 0, dataBytes = 0;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const size = view.getUint32(offset + 4, true);
    if (bytes.toString('ascii', offset, offset + 4) === 'data') { dataOffset = offset + 8; dataBytes = size; break; }
    offset += 8 + size + (size & 1);
  }
  expect(dataOffset).toBeGreaterThan(0);
  const channels = Array.from({ length: count }, () => new Float32Array(dataBytes / 4 / count));
  for (let i = 0; i < channels[0].length; i++) for (let c = 0; c < count; c++) channels[c][i] = view.getFloat32(dataOffset + (i * count + c) * 4, true);
  expect(analyzeAudio({ sampleRate: sr, channels }).integratedLufs).toBeCloseTo(report.finalAfter.integratedLufs, 7);
  await page.locator('#finish-preferences').screenshot({ path: 'test-results/finishing-preferences.png' });
  expect(errors).toEqual([]);
});

test('profile switching, cancellation and reset retain prior B with mobile controls', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/');
  await page.locator('#file-input').setInputFiles({ name: 'output.wav', mimeType: 'audio/wav', buffer: Buffer.from(wav(tone({ amplitude: 0.2, seconds: 2 }), 32, true)) });
  await expect(page.locator('#mode-AUTO')).toBeEnabled();
  const original = await page.locator('#a-lufs').innerText();
  for (const [id, label, target] of [['youtube', 'YouTube', '-14.0'], ['cd', 'CD', '-12.0'], ['dynamic', '強弱を残す', '-18.0']]) {
    await page.locator('#output-profile').selectOption(id);
    await page.locator('#mode-AUTO').click();
    await expect(page.locator('#preferences-result')).toContainText(`適用済み：${label}`);
    await expect(page.locator('#preferences-result')).toContainText(`実測 ${target} LUFS`);
    await expect(page.locator('#a-lufs')).toHaveText(original); await expect(page.locator('#match-toggle')).toBeChecked();
  }
  const prior = await page.locator('#b-lufs').innerText();
  await page.locator('#output-profile').selectOption('cd'); await expect(page.locator('#b-lufs')).toHaveText(prior);
  await page.locator('#mode-AUTO').click(); await page.locator('#cancel-button').click();
  await expect(page.locator('#status')).toContainText('キャンセル'); await expect(page.locator('#b-lufs')).toHaveText(prior);
  await page.locator('#finish-bass').selectOption('3'); await page.locator('#finish-preferences-reset').click();
  await expect(page.locator('#finish-bass')).toHaveValue('0'); await expect(page.locator('#output-profile')).toHaveValue('auto');
  await expect(page.locator('#b-lufs')).toHaveText(prior);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test('quiet material reports limited target without claiming the CD goal was reached', async ({ page }) => {
  await page.goto('/');
  await page.locator('#file-input').setInputFiles({ name: 'quiet.wav', mimeType: 'audio/wav', buffer: Buffer.from(wav(tone({ amplitude: 0.025, seconds: 2 }), 32, true)) });
  await expect(page.locator('#mode-AUTO')).toBeEnabled(); await page.locator('#output-profile').selectOption('cd');
  await page.locator('#mode-AUTO').click();
  await expect(page.locator('#preferences-result')).toContainText('目標音量より控えめ');
  await expect(page.locator('#select-b')).toBeEnabled();
  await expect(page.locator('#match-toggle')).toBeChecked();
});
