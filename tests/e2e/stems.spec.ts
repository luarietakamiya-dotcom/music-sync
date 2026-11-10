import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { tone, wav } from '../helpers/audio';

const file = (name: string, options: Parameters<typeof tone>[0] = {}) => ({ name, mimeType: 'audio/wav', buffer: Buffer.from(wav(tone({ sampleRate: 16000, seconds: 2, ...options }), 32, true)) });
async function drop(page: Page, selector: string, files: ReturnType<typeof file>[]) {
  await page.locator(selector).evaluate((target, inputs) => {
    const transfer = new DataTransfer();
    for (const input of inputs) transfer.items.add(new File([Uint8Array.from(atob(input.base64), x => x.charCodeAt(0))], input.name, { type: 'audio/wav' }));
    target.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true }));
  }, files.map(f => ({ name: f.name, base64: f.buffer.toString('base64') })));
}

test('vocal and instrumental can be dropped separately, synchronized, finished, matched and reported', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/'); await page.locator('#stem-mode').selectOption('vocal-instrumental');
  await drop(page, '#stem-dropzone', [file('vocals.wav')]);
  await expect(page.locator('#stem-status')).toContainText('もう1つ'); await expect(page.locator('#stem-track-list .stem-track')).toHaveCount(1);
  await drop(page, '#stem-dropzone', [file('instrumental.wav', { seconds: 1, stereo: true, frequency: 1600, amplitude: 0.05 })]);
  await expect(page.locator('#stem-status')).toContainText('2素材を読み込み');
  await expect(page.locator('#stem-status')).toContainText('末尾を無音');
  await expect(page.locator('#track-name')).toHaveText('Vocal + Instrumental · 2 tracks.wav');
  await expect(page.locator('#track-meta')).toContainText('16.0 kHz');
  await page.locator('#output-profile').selectOption('youtube'); await page.locator('#mode-AUTO').click();
  await expect(page.locator('#finish-explanation')).toContainText('候補を用意しました'); await expect(page.locator('#match-toggle')).toBeChecked();
  await page.locator('#advanced-settings').evaluate((el: HTMLDetailsElement) => { el.open = true; });
  const saved = page.waitForEvent('download'); await page.locator('#finish-report-button').click();
  const report = JSON.parse(await readFile((await (await saved).path())!, 'utf8'));
  expect(report.sourceMix.plan.mode).toBe('vocal-instrumental'); expect(report.sourceMix.tracks).toHaveLength(2);
  expect(report.sourceMix.tracks.map((t: { descriptor: { role: string } }) => t.descriptor.role)).toEqual(['vocal', 'instrumental']);
  expect(report.finalAfter.clippedSamples).toBe(0);
  const exported = page.waitForEvent('download'); await page.locator('#wav-button').click(); expect((await exported).suggestedFilename()).toContain('.wav');
  const oldA = await page.locator('#a-lufs').innerText();
  await page.getByRole('combobox', { name: 'vocals.wav の音量' }).selectOption('3'); await expect(page.locator('#a-lufs')).toHaveText(oldA);
  await page.locator('#stem-render').click(); await expect(page.locator('#stem-status')).toContainText('2素材を読み込み');
  await expect(page.locator('#select-b')).toBeDisabled(); await expect(page.locator('#a-lufs')).not.toHaveText(oldA);
  await page.locator('#stem-settings').screenshot({ path: 'test-results/vocal-instrumental-input.png' });
  expect(errors).toEqual([]);
});

test('main dropzone accepts multiple STEMs and protects the summed peak while retaining mute/removal settings', async ({ page }) => {
  await page.goto('/');
  await drop(page, '#dropzone', [file('drums.wav', { amplitude: 0.7 }), file('bass.wav', { amplitude: 0.7 }), file('piano.wav', { amplitude: 0.7 })]);
  await expect(page.locator('#stem-status')).toContainText('3素材を読み込み');
  await expect(page.locator('#stem-status')).toContainText('合算ピークの保護');
  await expect(page.locator('#stem-track-list .stem-track')).toHaveCount(3);
  await expect(page.locator('#track-name')).toHaveText('STEM Mix · 3 tracks.wav');
  expect(Number(await page.locator('#true-peak').innerText())).toBeLessThanOrEqual(-3);
  await expect(page.locator('#clipped')).toHaveText('0');
  await page.getByRole('combobox', { name: 'bass.wav の役割' }).selectOption('guitar');
  const rows = page.locator('#stem-track-list .stem-track');
  await rows.filter({ hasText: 'piano.wav' }).getByRole('checkbox').uncheck();
  await page.locator('#stem-render').click(); await expect(page.locator('#stem-status')).toContainText('3素材を読み込み');
  await page.getByRole('button', { name: 'piano.wav を素材リストから外す' }).click();
  await expect(rows).toHaveCount(2); await page.locator('#stem-render').click();
  await expect(page.locator('#stem-status')).toContainText('2素材を読み込み');
  await page.locator('#stem-settings').screenshot({ path: 'test-results/stem-input.png' });
});

test('mixed WAV/FLAC input uses native FLAC decoding and fits a mobile viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/');
  await page.locator('#stem-file-input').setInputFiles([
    file('vocal.wav', { sampleRate: 44100, seconds: 1 }),
    { name: 'music.flac', mimeType: 'audio/flac', buffer: await readFile('tests/fixtures/tone.flac') },
  ]);
  await expect(page.locator('#stem-status')).toContainText('2素材を読み込み');
  await expect(page.locator('#track-meta')).toContainText('44.1 kHz');
  await expect(page.locator('#stem-track-list .stem-track')).toHaveCount(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.locator('#stem-settings').screenshot({ path: 'test-results/stem-mobile.png' });
});

test('malformed/mismatched input and cancellation preserve prior audio, candidate and project list', async ({ page }) => {
  await page.goto('/'); await page.locator('#demo-button').click(); await expect(page.locator('#mode-AUTO')).toBeEnabled();
  await page.locator('#mode-AUTO').click(); await expect(page.locator('#finish-explanation')).toContainText('候補を用意しました');
  const a = await page.locator('#a-lufs').innerText(), b = await page.locator('#b-lufs').innerText();
  await page.locator('#stem-file-input').setInputFiles([file('good.wav'), { name: 'broken.wav', mimeType: 'audio/wav', buffer: Buffer.from('bad') }]);
  await expect(page.locator('#stem-status')).toContainText('読み込めませんでした');
  await expect(page.locator('#a-lufs')).toHaveText(a); await expect(page.locator('#b-lufs')).toHaveText(b); await expect(page.locator('#stem-track-list .stem-track')).toHaveCount(2);
  await page.locator('#stem-clear').click();
  await page.locator('#stem-file-input').setInputFiles([file('one.wav'), file('two.wav', { sampleRate: 48000 })]);
  await expect(page.locator('#error')).toContainText('サンプルレート'); await expect(page.locator('#a-lufs')).toHaveText(a); await expect(page.locator('#b-lufs')).toHaveText(b);
  await page.locator('#stem-clear').click();
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/workers.json', async route => { await gate; await route.continue(); });
  await page.locator('#stem-file-input').setInputFiles([file('one.wav'), file('two.wav')]);
  await page.locator('#cancel-button').click(); release(); await expect(page.locator('#stem-status')).toContainText('キャンセル');
  await expect(page.locator('#a-lufs')).toHaveText(a); await expect(page.locator('#b-lufs')).toHaveText(b);
  await expect(page.locator('#stem-track-list .stem-track')).toHaveCount(2);
  await page.locator('#stem-clear').click();
  await page.unroute('**/workers.json');
  await page.locator('#stem-file-input').setInputFiles([file('one.wav'), file('two.wav')]);
  await expect(page.locator('#stem-status')).toContainText('2素材を読み込み'); await expect(page.locator('#select-b')).toBeDisabled();
});

test('source clipping remains visible and does not become an automatically accepted master after summing', async ({ page }) => {
  await page.goto('/');
  await page.locator('#file-input').setInputFiles([file('clipped.wav', { amplitude: 1.1 }), file('instrumental.wav')]);
  await expect(page.locator('#stem-status')).toContainText('元の素材にクリッピング'); await expect(page.locator('#clipped')).toHaveText('0');
  await page.locator('#mode-AUTO').click(); await expect(page.locator('#error')).toContainText('元のSTEMにクリッピング');
  await expect(page.locator('#select-b')).toBeDisabled();
});

test('heavy WAV analysis can be cancelled from the responsive UI while preserving A and B', async ({ page }) => {
  await page.goto('/'); await page.locator('#demo-button').click(); await expect(page.locator('#mode-AUTO')).toBeEnabled();
  await page.locator('#mode-AUTO').click(); await expect(page.locator('#finish-explanation')).toContainText('候補を用意しました');
  const a = await page.locator('#a-lufs').innerText(), b = await page.locator('#b-lufs').innerText();
  await page.locator('#stem-file-input').setInputFiles([file('long-voice.wav', { sampleRate: 48000, seconds: 45 }), file('long-music.wav', { sampleRate: 48000, seconds: 45 })]);
  await expect(page.locator('#status')).toContainText('読み込み・解析');
  await page.locator('#cancel-button').click();
  await expect(page.locator('#stem-status')).toContainText('キャンセル');
  await expect(page.locator('#a-lufs')).toHaveText(a); await expect(page.locator('#b-lufs')).toHaveText(b);
  await expect(page.locator('#stem-track-list .stem-track')).toHaveCount(2);
});
