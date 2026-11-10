import { test, expect } from '@playwright/test';
import { open, stat } from 'node:fs/promises';

test('drop a five-minute vocal pair, balance, finish, audition and save the complete stereo WAV', async ({ page }) => {
  test.setTimeout(360000);
  await page.goto('/');
  // Keep this capacity benchmark isolated; default-on repairs have their own tests.
  await page.locator('#studio-restore').uncheck(); await page.locator('#guitar-double').uncheck();
  await page.locator('#stem-dropzone').evaluate(zone => {
    const rate = 48000, transfer = new DataTransfer();
    for (const [name, amp, seconds] of [['vocals.wav', 0.02, 312], ['instrumental.wav', 0.22, 315]] as const) {
      const header = new DataView(new ArrayBuffer(44));
      function tag(at: number, value: string) { [...value].forEach((v, i) => header.setUint8(at + i, v.charCodeAt(0))); }
      tag(0, 'RIFF'); tag(8, 'WAVE'); tag(12, 'fmt '); tag(36, 'data');
      header.setUint32(4, 36 + rate * seconds * 2, true); header.setUint32(16, 16, true);
      header.setUint16(20, 1, true); header.setUint16(22, 1, true); header.setUint32(24, rate, true);
      header.setUint32(28, rate * 2, true); header.setUint16(32, 2, true); header.setUint16(34, 16, true);
      header.setUint32(40, rate * seconds * 2, true);
      const pcm = new Int16Array(rate);
      for (let i = 0; i < rate; i++) pcm[i] = 32767 * amp * [320, 910, 1850, 3300, 6100].reduce((sum, f) => sum + Math.sin(2 * Math.PI * f * i / rate), 0) / 5;
      transfer.items.add(new File([header.buffer, ...Array(seconds).fill(pcm)], name, { type: 'audio/wav' }));
    }
    zone.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: transfer }));
  });
  await expect(page.locator('#stem-mode')).toHaveValue('vocal-instrumental');
  await expect(page.locator('#stem-status')).toContainText('2素材を読み込み', { timeout: 170000 });
  await expect(page.locator('#stem-status')).toContainText('声の素材だけ');
  await expect(page.locator('#stem-status')).toContainText('短い素材');
  await expect(page.locator('#duration')).toContainText('5:15');
  await page.locator('#mode-AUTO').click();
  await expect(page.locator('#b-name')).toContainText('AUTO', { timeout: 150000 });
  await expect(page.locator('#match-toggle')).toBeChecked();
  await page.getByRole('button', { name: '再生', exact: true }).click();
  await page.locator('#select-a').click();
  await expect(page.getByRole('button', { name: '一時停止', exact: true })).toBeVisible();
  await page.locator('#select-b').click();
  await page.getByRole('button', { name: '停止', exact: true }).click();
  const download = page.waitForEvent('download');
  await page.locator('#wav-button').click();
  const path = (await (await download).path())!;
  expect((await stat(path)).size).toBe(56 + 48000 * 315 * 8);
  const saved = await open(path, 'r');
  try {
    const header = Buffer.alloc(56);
    await saved.read(header, 0, 56, 0);
    expect(header.readUInt16LE(20)).toBe(3);
    expect(header.readUInt16LE(22)).toBe(2);
    expect(header.readUInt32LE(24)).toBe(48000);
  } finally { await saved.close(); }
  await page.locator('#stem-render').click();
  await page.locator('#cancel-button').click();
  await expect(page.locator('#select-b')).toBeEnabled();
  await page.locator('#undo-finish').click();
  await expect(page.locator('#select-a')).toBeEnabled();
});
