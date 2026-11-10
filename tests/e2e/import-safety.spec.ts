import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { tone, wav } from '../helpers/audio';
const file = (name: string) => ({ name, mimeType: 'audio/wav', buffer: Buffer.from(wav(tone({ sampleRate: 48000, seconds: 1, amplitude: 0.05 }), 32, true)) });
const idle = async (page: Page) => expect(page.locator('#cancel-button')).toBeHidden();
const drop = async (page: Page, name: string) => {
  await page.locator('#stem-dropzone').evaluate((element, data) => {
    const dt = new DataTransfer(); dt.items.add(new File([Uint8Array.from(atob(data.base64), c => c.charCodeAt(0))], data.name));
    element.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true }));
  }, { name, base64: file(name).buffer.toString('base64') });
};
const report = async (page: Page) => {
  await page.locator('#advanced-settings').evaluate((el: HTMLDetailsElement) => { el.open = true; });
  const promise = page.waitForEvent('download'); await page.locator('#finish-report-button').click();
  const download = await promise;
  return { name: download.suggestedFilename(), text: await readFile((await download.path())!, 'utf8') };
};
test('failed and cancelled single imports retain committed A/B, matched selection, STEM list and finishing report', async ({ page }) => {
  await page.goto('/'); await page.locator('#stem-file-input').setInputFiles([file('voice.wav'), file('music.wav')]); await idle(page);
  await page.locator('#mode-AUTO').click(); await expect(page.locator('#finish-explanation')).toContainText('候補を用意しました');
  const a = await page.locator('#a-name').innerText(), b = await page.locator('#b-name').innerText();
  const originalReport = (await report(page)).text;
  const preserved = async () => {
    await expect(page.locator('#a-name')).toHaveText(a); await expect(page.locator('#b-name')).toHaveText(b);
    await expect(page.locator('#select-b')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#match-toggle')).toBeChecked(); await expect(page.locator('.stem-track')).toHaveCount(2);
    expect((await report(page)).text).toBe(originalReport);
  };
  for (const slot of ['#file-input', '#file-input-b']) {
    for (const name of ['bad.wav', 'bad.flac', 'bad.mp3']) {
      await page.locator(slot).setInputFiles({ name, mimeType: 'audio/wav', buffer: Buffer.from('broken') });
      await expect(page.locator('#error')).toBeVisible(); await idle(page); await preserved();
    }
  }
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/workers.json', async route => { await gate; await route.continue(); });
  await page.locator('#file-input').setInputFiles(file('replacement.wav'));
  await page.locator('#cancel-button').click(); release(); await idle(page); await preserved();
  await page.unroute('**/workers.json');
  await page.locator('#file-input').setInputFiles(file('replacement.wav')); await idle(page);
  await expect(page.locator('#a-name')).toHaveText('replacement.wav'); await expect(page.locator('#select-b')).toBeDisabled();
});
test('paired filenames and failed roles remain editable; dedicated role inputs override guesses', async ({ page }) => {
  await page.goto('/'); await page.locator('#stem-mode').selectOption('vocal-instrumental');
  await page.locator('#stem-file-input').setInputFiles([file('vocals.wav'), file('no_vocals.wav')]); await idle(page);
  await expect(page.locator('#a-name')).toContainText('Vocal + Instrumental');
  await page.locator('#stem-clear').click();
  await page.locator('#stem-file-input').setInputFiles([file('drums.wav'), file('bass.wav')]); await idle(page);
  await expect(page.locator('#error')).toContainText('役割'); await expect(page.locator('.stem-track')).toHaveCount(2);
  await page.getByRole('combobox', { name: 'drums.wav の役割' }).selectOption('vocal');
  await page.getByRole('combobox', { name: 'bass.wav の役割' }).selectOption('instrumental');
  await page.locator('#stem-render').click(); await idle(page); await expect(page.locator('#error')).toBeHidden();
  await page.locator('#stem-clear').click();
  await page.locator('#stem-vocal-input').setInputFiles(file('take-01.wav'));
  await page.locator('#stem-instrumental-input').setInputFiles(file('take-02.wav')); await idle(page);
  await expect(page.getByRole('combobox', { name: 'take-01.wav の役割' })).toHaveValue('vocal');
  await expect(page.getByRole('combobox', { name: 'take-02.wav の役割' })).toHaveValue('instrumental');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.locator('#stem-settings').screenshot({ path: 'test-results/import-safety-pair.png' });
});
test('rapid drops queue every accepted file and commit only the complete group', async ({ page }) => {
  await page.goto('/'); await page.locator('#stem-file-input').setInputFiles([file('first.wav'), file('second.wav')]); await idle(page);
  const a = await page.locator('#a-name').innerText();
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/workers.json', async route => { await gate; await route.continue(); });
  await drop(page, 'third.wav'); await drop(page, 'fourth.wav');
  await expect(page.locator('#stem-status')).toContainText('処理待ち'); await expect(page.locator('#a-name')).toHaveText(a);
  release(); await idle(page); await page.unroute('**/workers.json');
  await expect(page.locator('#a-name')).toContainText('4 tracks');
  // Repair badges are appended inside <strong>; compare the filename text itself, in arrival order.
  expect(await page.locator('.stem-track strong').evaluateAll(names => names.map(name => name.firstChild?.textContent ?? '')))
    .toEqual(['first.wav', 'second.wav', 'third.wav', 'fourth.wav']);
  // Cancellation stops the queued job but retains all editable staged files.
  let releaseAgain!: () => void; const again = new Promise<void>(resolve => { releaseAgain = resolve; });
  await page.route('**/workers.json', async route => { await again; await route.continue(); });
  await drop(page, 'fifth.wav'); await drop(page, 'sixth.wav'); await page.locator('#cancel-button').click(); releaseAgain(); await idle(page);
  await expect(page.locator('#a-name')).toContainText('4 tracks'); await expect(page.locator('.stem-track')).toHaveCount(6);
  await page.unroute('**/workers.json'); await page.locator('#stem-render').click(); await idle(page);
  await expect(page.locator('#a-name')).toContainText('6 tracks');
});
for (const studioEnabled of [true, false]) {
test(`preflight explains the actual length limit without decoding oversized PCM (${studioEnabled ? 'default studio' : 'raw opt-out'})`, async ({ page }) => {
  await page.addInitScript(() => {
    const state = window as unknown as { preflightDecodeCalls: number }; state.preflightDecodeCalls = 0;
    const decode = OfflineAudioContext.prototype.decodeAudioData;
    OfflineAudioContext.prototype.decodeAudioData = function (...args: unknown[]) {
      state.preflightDecodeCalls++; return Reflect.apply(decode, this, args);
    };
  });
  await page.goto('/');
  if (studioEnabled) {
    await expect(page.locator('#studio-restore')).toBeChecked(); await expect(page.locator('#guitar-double')).toBeChecked();
  } else {
    await page.locator('#studio-restore').uncheck(); await page.locator('#guitar-double').uncheck();
  }
  const header = await readFile('tests/fixtures/tone.flac');
  header.writeBigUInt64BE((48000n << 44n) | (1n << 41n) | (15n << 36n) | 14400000n, 18);
  await page.locator('#stem-file-input').setInputFiles([
    { name: 'five-minute.flac', mimeType: 'audio/flac', buffer: header }, file('other.wav'),
  ]); await idle(page);
  await expect(page.locator('#stem-capacity')).toContainText('長さ 5:00.0 / 合成上限 4:22.1');
  await expect(page.locator('#error')).toContainText('262秒'); await expect(page.locator('.stem-track')).toHaveCount(2);
  expect(await page.evaluate(() => (window as unknown as { preflightDecodeCalls: number }).preflightDecodeCalls)).toBe(0);
});
}
test('anonymous report defaults hide material names; opt-in detailed report preserves them', async ({ page }) => {
  await page.goto('/'); await page.locator('#stem-file-input').setInputFiles([file('private-vocal.wav'), file('private-music.wav')]); await idle(page);
  await page.locator('#mode-AUTO').click(); await expect(page.locator('#finish-explanation')).toContainText('候補を用意しました');
  const anonymous = await report(page);
  expect(anonymous.name).toContain('anonymous'); expect(anonymous.text).not.toContain('private-');
  const parsed = JSON.parse(anonymous.text); expect(parsed.status).toBe('accepted'); expect(parsed.sourceMix.tracks).toHaveLength(2);
  expect(parsed.sourceMix.tracks[0].descriptor.id).toBe(parsed.sourceMix.plan.tracks[0].id);
  await page.locator('#report-anonymous').uncheck(); const detailed = await report(page);
  expect(detailed.name).toBe('music-sync-finishing-report.json'); expect(detailed.text).toContain('private-vocal.wav');
  expect(JSON.parse(detailed.text).finalAfter.integratedLufs).toBe(parsed.finalAfter.integratedLufs);
  expect(JSON.parse(detailed.text).finalAfter.clippedSamples).toBe(parsed.finalAfter.clippedSamples);
});
