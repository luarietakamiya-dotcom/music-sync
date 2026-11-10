import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { tone, wav } from '../helpers/audio';

const file = (name: string, frequency = 440, seconds = 10, sampleRate = 16000) => ({ name, mimeType: 'audio/wav',
  buffer: Buffer.from(wav(tone({ sampleRate, seconds, frequency, amplitude: 0.1 }), 32, true)) });
async function position(page: Page, selector: string, seconds: number) {
  await page.locator(selector).evaluate((input: HTMLInputElement, value) => { input.value = String(value); input.dispatchEvent(new Event('input', { bubbles: true })); }, seconds);
}
async function observeMedia(page: Page) {
  await page.addInitScript(() => {
    const media: HTMLMediaElement[] = [], urls = new Set<string>(), blobs = new Map<string, Blob>();
    Object.defineProperty(window, '__soloTestMedia', { value: media });
    Object.defineProperty(window, '__soloTestUrls', { value: urls });
    Object.defineProperty(window, '__soloTestBlobs', { value: blobs });
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      if (!media.includes(this)) media.push(this);
      return play.call(this);
    };
    const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = value => { const url = create(value); urls.add(url); if (value instanceof Blob) blobs.set(url,value); return url; };
    URL.revokeObjectURL = value => { urls.delete(value); blobs.delete(value); revoke(value); };
  });
}
async function noPreviewResources(page: Page) {
  await expect.poll(() => page.evaluate(() => {
    const state = window as unknown as { __soloTestMedia: HTMLMediaElement[]; __soloTestUrls: Set<string> };
    return { active: state.__soloTestMedia.filter(media => !media.paused).length, urls: state.__soloTestUrls.size };
  })).toEqual({ active: 0, urls: 0 });
}

test('solo identifies the raw material despite staged role/gain/mute, switches at one position, and preserves finished A/B', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await observeMedia(page); await page.goto('/');
  await page.locator('#stem-file-input').setInputFiles([file('Synth.wav', 330), file('Bass.wav', 110)]);
  await expect(page.locator('#stem-status')).toContainText('2素材を読み込み');
  await page.locator('#mode-AUTO').click(); await expect(page.locator('#finish-explanation')).toContainText('候補を用意しました');
  await page.locator('#match-toggle').uncheck(); await page.locator('#select-b').click();
  await position(page, '#volume', 0.2);
  const row = page.locator('.stem-track').filter({ has: page.getByRole('combobox', { name: 'Synth.wav の役割' }) });
  await row.getByRole('checkbox').uncheck();
  await page.getByRole('combobox', { name: 'Synth.wav の音量' }).selectOption('-6');
  await page.getByRole('combobox', { name: 'Synth.wav の役割' }).selectOption('guitar');
  await position(page, '#seek', 2);
  const a = await page.locator('#a-lufs').innerText(), b = await page.locator('#b-lufs').innerText();
  const explanation = await page.locator('#finish-explanation').innerText();
  await page.getByRole('button', { name: 'Synth.wav だけを聴く', exact: true }).click();
  await expect(page.locator('#stem-solo-dialog')).toBeVisible();
  await expect(page.locator('#stem-solo-description')).toContainText(/元の素材|補修前/);
  await expect(page.locator('#stem-solo-isolate')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#stem-solo-play')).toHaveText('一時停止');
  await expect.poll(async () => Number(await page.locator('#stem-solo-seek').inputValue())).toBeGreaterThan(2);
  const raw = await page.evaluate(async () => {
    const state = window as unknown as { __soloTestMedia: HTMLMediaElement[]; __soloTestBlobs: Map<string,Blob> };
    const source = state.__soloTestMedia.slice().reverse().find(media => media.src.startsWith('blob:'))!;
    const data = new DataView(await state.__soloTestBlobs.get(source.src)!.arrayBuffer());
    return { volume: source.volume, format: data.getUint16(20, true), samples: Array.from({ length: 16 }, (_, i) => data.getFloat32(44 + i * 4, true)) };
  });
  expect(raw.volume).toBeCloseTo(0.2, 5); expect(raw.format).toBe(3);
  expect(raw.samples).toEqual(Array.from(tone({ sampleRate: 16000, seconds: 0.001, frequency: 330, amplitude: 0.1 }).channels[0]));
  await position(page, '#stem-solo-volume', 0.35);
  await expect.poll(() => page.evaluate(() => {
    const state = window as unknown as { __soloTestMedia: HTMLMediaElement[] };
    return state.__soloTestMedia.slice().reverse().find(media => media.src.startsWith('blob:'))!.volume;
  })).toBeCloseTo(0.35, 5);
  await expect(page.locator('#volume')).toHaveValue('0.2');
  await page.locator('#stem-solo-play').click();
  await position(page, '#stem-solo-seek', 3);
  await page.locator('#stem-solo-mix').click();
  await expect(page.locator('#stem-solo-mix')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#stem-solo-time')).toContainText('0:03');
  await position(page, '#stem-solo-seek', 9.8);
  await expect(page.locator('#stem-solo-play')).toHaveText('再生');
  await position(page, '#stem-solo-seek', 0);
  await expect(page.locator('#stem-solo-time')).toContainText('0:00');
  await page.locator('#stem-solo-play').click();
  await expect(page.locator('#stem-solo-play')).toHaveText('一時停止');
  await page.locator('#stem-solo-play').click();
  await position(page, '#stem-solo-seek', 3);
  await page.locator('#stem-solo-isolate').click();
  const bassId = await page.locator('#stem-solo-track option').filter({ hasText: 'Bass.wav' }).getAttribute('value');
  await page.locator('#stem-solo-track').selectOption(bassId!);
  await expect(page.locator('#stem-solo-time')).toContainText('0:03');
  await page.locator('#stem-solo-close').click();
  await expect(page.locator('#stem-solo-dialog')).toBeHidden(); await noPreviewResources(page);
  await expect(page.locator('#select-b')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#match-toggle')).not.toBeChecked(); await expect(page.locator('#volume')).toHaveValue('0.2');
  await expect(page.locator('#play-time')).toContainText('0:02');
  await expect(page.locator('#a-lufs')).toHaveText(a); await expect(page.locator('#b-lufs')).toHaveText(b);
  await expect(page.locator('#finish-explanation')).toHaveText(explanation);
  await expect(row.getByRole('checkbox')).not.toBeChecked();
  await expect(page.getByRole('combobox', { name: 'Synth.wav の役割' })).toHaveValue('guitar');
  await expect(page.getByRole('combobox', { name: 'Synth.wav の音量' })).toHaveValue('-6');
  expect(errors).toEqual([]);
});

test('native FLAC and Float32 WAV solo previews fit mobile and show filenames as text', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await observeMedia(page); await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/');
  const name = '<img src=x onerror=alert(1)> Synth.wav';
  await page.locator('#stem-file-input').setInputFiles([
    file(name, 440, 2, 44100),
    { name: 'Material.flac', mimeType: 'audio/flac', buffer: await readFile('tests/fixtures/tone.flac') },
  ]);
  await expect(page.locator('#stem-status')).toContainText('2素材を読み込み');
  await page.getByRole('button', { name: name + ' だけを聴く', exact: true }).click();
  await expect(page.locator('#stem-solo-play')).toHaveText('一時停止');
  await expect(page.locator('#stem-solo-dialog img')).toHaveCount(0);
  await expect(page.locator('#stem-solo-track option:checked')).toContainText(name);
  const flacId = await page.locator('#stem-solo-track option').filter({ hasText: 'Material.flac' }).getAttribute('value');
  await page.locator('#stem-solo-track').selectOption(flacId!);
  await page.locator('#stem-solo-stop').click();
  if (await page.locator('#stem-solo-play').innerText() === '再生') await page.locator('#stem-solo-play').click();
  await expect(page.locator('#stem-solo-play')).toHaveText('一時停止');
  await expect.poll(() => page.evaluate(() => {
    const state = window as unknown as { __soloTestMedia: HTMLMediaElement[] };
    return state.__soloTestMedia.some(media => !media.paused && media.currentTime > 0.02);
  })).toBe(true);
  const bounds = await page.locator('#stem-solo-dialog').boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.locator('#stem-solo-dialog').screenshot({ path: 'test-results/stem-solo-mobile.png' });
  await expect(page.locator('#stem-solo-dismiss')).toBeVisible();
  await page.locator('#stem-solo-dismiss').click(); await expect(page.locator('#stem-solo-dialog')).toBeHidden();
  await noPreviewResources(page); expect(errors).toEqual([]);
});

test('Escape cancels pending solo media and a failed addition cannot preview uncommitted audio', async ({ page }) => {
  await observeMedia(page); await page.goto('/');
  await page.locator('#stem-file-input').setInputFiles([file('Synth.wav'), file('Bass.wav', 110)]);
  await expect(page.locator('#stem-status')).toContainText('2素材を読み込み');
  const name = await page.locator('#track-name').innerText();
  await page.getByRole('button', { name: 'Synth.wav だけを聴く', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(page.locator('#stem-solo-dialog')).toBeHidden(); await noPreviewResources(page);
  await page.locator('#stem-file-input').setInputFiles({ name: 'broken.wav', mimeType: 'audio/wav', buffer: Buffer.from('bad') });
  await expect(page.locator('#stem-status')).toContainText('読み込めませんでした');
  await expect(page.getByRole('button', { name: 'broken.wav だけを聴く', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Synth.wav だけを聴く', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Synth.wav だけを聴く', exact: true }).click();
  await expect(page.locator('#stem-solo-play')).toHaveText('一時停止');
  await page.locator('#stem-solo-close').click(); await noPreviewResources(page);
  await page.locator('#stem-clear').click();
  await expect(page.locator('#stem-track-list .stem-track')).toHaveCount(0);
  await expect(page.locator('#track-name')).toHaveText(name);
  await expect(page.locator('#mode-AUTO')).toBeEnabled();
});

test('long WAV solo starts at the current song position and releases only its own media resources', async ({ page }) => {
  test.setTimeout(120000);
  await observeMedia(page); await page.goto('/');
  await page.locator('#stem-mode').selectOption('stems');
  await page.locator('#stem-dropzone').evaluate(zone => {
    const rate = 8000, seconds = 601, transfer = new DataTransfer();
    for (const [name, frequency] of [['Synth.wav', 330], ['Bass.wav', 110]] as const) {
      const header = new DataView(new ArrayBuffer(44));
      const tag = (offset: number, value: string) => [...value].forEach((character, i) => header.setUint8(offset + i, character.charCodeAt(0)));
      tag(0, 'RIFF'); tag(8, 'WAVE'); tag(12, 'fmt '); tag(36, 'data');
      header.setUint32(4, 36 + rate * seconds * 2, true); header.setUint32(16, 16, true);
      header.setUint16(20, 1, true); header.setUint16(22, 1, true); header.setUint32(24, rate, true);
      header.setUint32(28, rate * 2, true); header.setUint16(32, 2, true); header.setUint16(34, 16, true);
      header.setUint32(40, rate * seconds * 2, true);
      const pcm = Int16Array.from({ length: rate }, (_, i) => Math.round(32767 * 0.1 * Math.sin(2 * Math.PI * frequency * i / rate)));
      transfer.items.add(new File([header.buffer, ...Array(seconds).fill(pcm)], name, { type: 'audio/wav' }));
    }
    zone.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: transfer }));
  });
  await expect(page.locator('#stem-status')).toContainText('2素材を読み込み', { timeout: 90000 });
  await expect(page.locator('#duration')).toContainText('10:01');
  await page.locator('#play-button').click(); await expect(page.locator('#play-button')).toHaveAttribute('aria-label', '一時停止');
  await page.locator('#play-button').click(); await position(page, '#seek', 590);
  await expect(page.locator('#play-time')).toContainText('9:50');
  const baselineUrls = await page.evaluate(() => (window as unknown as { __soloTestUrls: Set<string> }).__soloTestUrls.size);
  await page.getByRole('button', { name: 'Synth.wav だけを聴く', exact: true }).click();
  await expect(page.locator('#stem-solo-play')).toHaveText('一時停止');
  await expect.poll(async () => Number(await page.locator('#stem-solo-seek').inputValue())).toBeGreaterThan(590);
  await page.keyboard.press('Escape'); await expect(page.locator('#stem-solo-dialog')).toBeHidden();
  await expect.poll(() => page.evaluate(() => {
    const state = window as unknown as { __soloTestMedia: HTMLMediaElement[]; __soloTestUrls: Set<string> };
    return { active: state.__soloTestMedia.filter(media => !media.paused).length, urls: state.__soloTestUrls.size };
  })).toEqual({ active: 0, urls: baselineUrls });
  await expect(page.locator('#play-time')).toContainText('9:50');
  await expect(page.locator('#mode-AUTO')).toBeEnabled();
});
