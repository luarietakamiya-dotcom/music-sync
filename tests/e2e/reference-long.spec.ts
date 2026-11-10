import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { perceptualFixture } from '../fixtures/perceptual';
import { wav } from '../helpers/audio';

async function reveal(page: Page, selector: string) {
  await page.locator(selector).evaluate(element => {
    for (let parent = element.parentElement; parent; parent = parent.parentElement)
      if (parent instanceof HTMLDetailsElement) parent.open = true;
  });
}

test('file-backed reference finishing evaluates real scratch audio and exports only the declared frames', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const source = perceptualFixture('bass-heavy'), frames = source.channels[0].length;
  const original = Buffer.from(wav(source, 32, true));
  await page.goto('/');
  // Valid trailing metadata triggers the >100 MiB adapter without eleven minutes of DSP.
  // Reusing a 1 MiB Blob keeps fixture creation independent of full-size JS PCM arrays.
  const size = await page.evaluate(base64 => {
    const content = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
    const junkBytes = 101 * 1024 ** 2, chunk = new Uint8Array(8), header = new DataView(chunk.buffer);
    chunk.set([74, 85, 78, 75]); header.setUint32(4, junkBytes, true);
    new DataView(content.buffer).setUint32(4, content.length + junkBytes, true);
    const zero = new Blob([new Uint8Array(1024 ** 2)]), padding = Array.from({ length: 101 }, () => zero);
    const file = new File([content, chunk, ...padding], 'file-backed-reference-source.wav', { type: 'audio/wav' });
    const dataTransfer = new DataTransfer(); dataTransfer.items.add(file);
    document.getElementById('dropzone')!.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
    return file.size;
  }, original.toString('base64'));
  expect(size).toBeGreaterThan(100 * 1024 ** 2);
  await expect(page.locator('#status')).toContainText('分割解析が完了');
  await expect(page.locator('#duration')).toHaveText('0:04.0');
  await expect(page.locator('#file-input-b')).toBeDisabled();
  const before = await page.locator('#a-lufs').innerText();
  await reveal(page, '#reference-input');
  await page.locator('#reference-input').setInputFiles({ name: 'balanced-reference.wav', mimeType: 'audio/wav',
    buffer: Buffer.from(wav(perceptualFixture('balanced'), 32, true)) });
  await expect(page.locator('#reference-status')).toContainText('解析が完了');
  await page.locator('#reference-strength').selectOption('1');
  await page.locator('#mode-AUTO').click();
  await expect(page.locator('#status')).toContainText('長尺WAVの仕上げが完了');
  await expect(page.locator('#reference-result')).toContainText('お手本');
  const details = JSON.parse((await page.locator('#finish-details').textContent())!);
  expect(details.reference.status).toBe('accepted');
  const accepted = details.reference.attempts.at(-1);
  expect(accepted.reasons).toEqual([]); expect(accepted.distanceAfter).toBeLessThan(accepted.distanceBefore);
  await expect(page.locator('#a-lufs')).toHaveText(before); await expect(page.locator('#match-toggle')).toBeChecked();
  await expect(page.locator('#file-input-b')).toBeDisabled();
  expect(Number(await page.locator('#true-peak').innerText())).toBeLessThanOrEqual(-.9);
  const pending = page.waitForEvent('download'); await page.locator('#wav-button').click();
  const downloaded = await pending, bytes = await readFile((await downloaded.path())!);
  expect(bytes.length).toBe(56 + frames * source.channels.length * 4);
  expect(bytes.readUInt16LE(20)).toBe(3); expect(bytes.readUInt32LE(24)).toBe(24000);
  expect(bytes.readUInt16LE(22)).toBe(2); expect(bytes.readUInt32LE(44)).toBe(frames);
  expect(bytes.readUInt32LE(52)).toBe(frames * 2 * 4);
  let finite = true, peak = 0;
  for (let offset = 56; offset < bytes.length; offset += 4) {
    const sample = bytes.readFloatLE(offset); finite &&= Number.isFinite(sample); peak = Math.max(peak, Math.abs(sample));
  }
  expect(finite).toBe(true); expect(peak).toBeLessThan(1); expect(peak).toBeGreaterThan(.001);
  await expect(page.locator('#a-lufs')).toHaveText(before); expect(errors).toEqual([]);
});
