import { test, expect } from '@playwright/test';
import { wav } from '../helpers/audio';

test('applies measured treble repair to a short song and can remake the candidate with repair off', async ({ page }) => {
  const sampleRate = 48000;
  let seed = 7, prev = 0;
  const pcm = Float32Array.from({ length: 3 * sampleRate }, (_, i) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const next = seed / 2 ** 32 - 0.5, hiss = (next - prev) * 0.15;
    prev = next;
    return 0.12 * Math.sin(2 * Math.PI * 440 * i / sampleRate) + hiss;
  });
  await page.goto('/');
  await page.locator('#file-input').setInputFiles({ name: 'repair.wav', mimeType: 'audio/wav', buffer: Buffer.from(wav({ sampleRate, channels: [pcm] })) });
  await expect(page.locator('#treble-repair')).toHaveValue('auto');
  await page.locator('#mode-AUTO').click();
  await expect(page.locator('#finish-explanation')).toContainText('秒で抑えました');
  await expect(page.locator('#match-toggle')).toBeChecked();
  await page.locator('#treble-repair').selectOption('off');
  await page.locator('#mode-AUTO').click();
  await expect(page.locator('#finish-explanation')).toContainText('高域補修はオフ');
  await expect(page.locator('#wav-button')).toBeEnabled();
});
