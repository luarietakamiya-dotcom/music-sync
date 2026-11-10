import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { wav } from '../helpers/audio';

function file(name: string, amplitude: number) {
  const sampleRate = 16000, frames = sampleRate * 2;
  const channel = Float32Array.from({ length: frames }, (_, i) => {
    const t = i / sampleRate;
    return amplitude * (Math.sin(2 * Math.PI * 320 * t) + Math.sin(2 * Math.PI * 910 * t) +
      Math.sin(2 * Math.PI * 1850 * t) + Math.sin(2 * Math.PI * 3300 * t) + Math.sin(2 * Math.PI * 6100 * t)) / 5;
  });
  return { name, mimeType: 'audio/wav', buffer: Buffer.from(wav({ sampleRate, channels: [channel] }, 32, true)) };
}

test('paired import adjusts only when measured, exposes the decision, and can return to manual mix', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.locator('#stem-mode').selectOption('vocal-instrumental');
  await expect(page.locator('#stem-auto-balance')).toBeChecked();
  await page.locator('#stem-file-input').setInputFiles([file('voice.wav', 0.02), file('instrumental.wav', 0.22)]);
  await expect(page.locator('#stem-status')).toContainText('声の素材だけを少し前に出しました');
  await expect(page.locator('#stem-status')).toContainText('声と重なる伴奏の帯域を控えめに整理');
  await expect(page.locator('#stem-track-list .stem-track').first()).toContainText('現在のA: 自動 +3.0 dB');
  await expect(page.locator('#stem-track-list .stem-track').last()).toContainText('現在のA: 声と重なる帯域を控えめに整理');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.locator('#stem-settings').screenshot({ path: 'test-results/stem-auto-balance.png' });
  const automaticLevel = await page.locator('#a-lufs').innerText();
  await page.locator('#mode-AUTO').click();
  await expect(page.locator('#finish-explanation')).toContainText('候補を用意しました');
  await page.locator('#advanced-settings').evaluate((details: HTMLDetailsElement) => { details.open = true; });
  const download = page.waitForEvent('download');
  await page.locator('#finish-report-button').click();
  const report = JSON.parse(await readFile((await (await download).path())!, 'utf8'));
  expect(report.sourceMix.autoBalance.status).toBe('adjusted');
  expect(report.sourceMix.autoBalance.tracks[0].adjustmentDb).toBeGreaterThan(0);
  expect(report.sourceMix.autoBalance.tracks[1].adjustmentDb).toBe(0);
  expect(report.sourceMix.masking.status).toBe('applied');
  expect(report.sourceMix.masking.evaluation.accepted).toBe(true);
  expect(report.sourceMix.masking.evaluation.presenceReductionDb).toBeGreaterThan(0.15);
  await page.locator('#stem-auto-balance').uncheck();
  await expect(page.locator('#a-lufs')).toHaveText(automaticLevel);
  await page.locator('#stem-render').click();
  await expect(page.locator('#stem-status')).toContainText('2素材を読み込み');
  await expect(page.locator('#stem-status')).not.toContainText('声の素材だけ');
  await expect(page.locator('#stem-track-list .stem-applied')).toHaveCount(0);
  await expect(page.locator('#select-b')).toBeDisabled();
});
