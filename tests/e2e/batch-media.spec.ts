import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { strFromU8, unzipSync } from 'fflate';
import { perceptualFixture } from '../fixtures/perceptual';
import { wav } from '../helpers/audio';

const jacket = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');
function completed(name: string, gain = 1) {
  const audio = perceptualFixture('balanced');
  for (const channel of audio.channels) for (let n = 0; n < channel.length; n++) channel[n] *= gain;
  return { name, mimeType: 'audio/wav', buffer: Buffer.from(wav(audio, 32, true)) };
}
async function reveal(page: Page, selector: string) {
  await page.locator(selector).evaluate(element => {
    for (let parent = element.parentElement; parent; parent = parent.parentElement)
      if (parent instanceof HTMLDetailsElement) parent.open = true;
  });
}
async function finishBatch(page: Page) {
  await reveal(page, '#batch-run');
  await page.locator('#batch-run').click();
  await expect(page.locator('#processing-overlay')).toBeHidden();
  await expect(page.locator('#batch-list [data-state="ready"]')).toHaveCount(2);
  await expect(page.locator('#batch-status')).toContainText('2/2');
}
function frames(bytes: Buffer) {
  expect(bytes.toString('ascii', 0, 3)).toBe('ID3'); expect(bytes[3]).toBe(3);
  const end = 10 + (bytes[6] << 21) + (bytes[7] << 14) + (bytes[8] << 7) + bytes[9];
  expect(end).toBeLessThan(bytes.length);
  const result = new Map<string, Buffer>();
  for (let offset = 10; offset < end;) {
    const name = bytes.toString('ascii', offset, offset + 4), size = bytes.readUInt32BE(offset + 4);
    expect(size).toBeGreaterThan(0); expect(offset + 10 + size).toBeLessThanOrEqual(end);
    result.set(name, bytes.subarray(offset + 10, offset + 10 + size)); offset += 10 + size;
  }
  expect(bytes[end]).toBe(255); expect(bytes[end + 1] & 224).toBe(224);
  return result;
}

test('native FLAC batch input keeps its original file and normalized A/B after the list is cleared', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const flac = Buffer.from((await readFile('tests/fixtures/tone.flac.base64', 'utf8')).trim(), 'base64');
  await page.goto('/');
  await page.locator('#batch-input').setInputFiles([
    { name: 'original-tone.flac', mimeType: 'audio/flac', buffer: flac }, completed('companion.wav', .6),
  ]);
  await finishBatch(page);
  await page.locator('.batch-track').first().getByRole('button', { name: '原音と仕上がりを聴く' }).click();
  await expect(page.locator('#a-name')).toHaveText('original-tone.flac');
  await expect(page.locator('#b-name')).toHaveText('original-tone-finished.wav');
  await expect(page.locator('#track-meta')).toContainText('44.1 kHz');
  await expect(page.locator('#track-meta')).toContainText('MONO');
  await expect(page.locator('#duration')).toHaveText('0:01.0'); await expect(page.locator('#match-toggle')).toBeChecked();
  const report = JSON.parse((await page.locator('#finish-details').textContent())!);
  expect(report.before.sampleRate).toBe(44100); expect(report.before.frames).toBe(44100); expect(report.before.channels).toBe(1);
  expect(report.after.frames).toBe(44100); expect(report.after.sampleRate).toBe(44100);
  const levels = await Promise.all(['a-lufs', 'b-lufs'].map(id => page.locator('#' + id).innerText()));
  await page.locator('#batch-clear').click(); await expect(page.locator('.batch-track')).toHaveCount(0);
  await expect(page.locator('#a-lufs')).toHaveText(levels[0]); await expect(page.locator('#b-lufs')).toHaveText(levels[1]);
  await page.locator('#select-a').click(); await page.locator('#play-button').click();
  await expect(page.locator('#play-button')).toHaveAttribute('aria-label', '一時停止');
  await page.locator('#select-b').click(); await expect(page.locator('#play-button')).toHaveAttribute('aria-label', '一時停止');
  await page.locator('#stop-button').click();
  const download = page.waitForEvent('download'); await page.locator('#project-save').click();
  const saved = await download; expect(saved.suggestedFilename()).toMatch(/\.musicsync\.zip$/);
  const entries = unzipSync(new Uint8Array(await readFile((await saved.path())!)));
  const manifest = JSON.parse(strFromU8(entries['manifest.json'])) as {
    assets: { id: string; path: string; name: string; mimeType: string }[];
    state: { sources: { a: { original: string; data: { kind: string; asset: string } } } };
  };
  const source = manifest.assets.find(asset => asset.id === manifest.state.sources.a.original)!;
  expect(source.name).toBe('original-tone.flac'); expect(source.mimeType).toBe('audio/flac');
  expect(Buffer.from(entries[source.path])).toEqual(flac);
  const normalized = manifest.assets.find(asset => asset.id === manifest.state.sources.a.data.asset)!;
  expect(manifest.state.sources.a.data.kind).toBe('file'); expect(normalized.mimeType).toBe('audio/wav');
  const normalizedBytes = Buffer.from(entries[normalized.path]);
  expect(normalizedBytes.toString('ascii', 8, 12)).toBe('WAVE'); expect(normalizedBytes.readUInt16LE(20)).toBe(3);
  expect(normalizedBytes.readUInt32LE(24)).toBe(44100); expect(normalizedBytes.readUInt32LE(44)).toBe(44100);
  expect(normalizedBytes.length).toBe(56 + 44100 * 4); expect(errors).toEqual([]);
});

test('MP3 ZIP has per-song default titles, shared Japanese tags and jacket with real decodable audio', async ({ page }) => {
  const external: string[] = [], errors: string[] = [];
  page.on('request', request => { if (!request.url().startsWith('http://127.0.0.1:4173') && !request.url().startsWith('blob:')) external.push(request.url()); });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/'); await reveal(page, '#audio-export-format');
  await page.locator('#audio-export-format').selectOption('mp3'); await page.locator('#audio-export-bitrate').selectOption('192');
  await page.locator('#audio-tag-title').fill(''); await page.locator('#audio-tag-artist').fill('独立した音楽家');
  await page.locator('#audio-tag-album').fill('日本語アルバム'); await page.locator('#audio-tag-albumArtist').fill('Music Sync 作者');
  await page.locator('#audio-export-artwork').setInputFiles({ name: '共通ジャケット.png', mimeType: 'image/png', buffer: jacket });
  await expect(page.locator('#audio-export-cover')).toBeVisible();
  await page.locator('#batch-input').setInputFiles([completed('朝の曲.wav', .5), completed('夜の曲.wav', .9)]);
  await finishBatch(page);
  const download = page.waitForEvent('download'); await page.locator('#batch-download-all').click();
  const saved = await download; expect(saved.suggestedFilename()).toMatch(/\.zip$/);
  const entries = unzipSync(new Uint8Array(await readFile((await saved.path())!)));
  expect(Object.keys(entries)).toEqual(['01 朝の曲.mp3', '02 夜の曲.mp3']);
  for (const [index, encoded] of Object.values(entries).entries()) {
    const bytes = Buffer.from(encoded), tags = frames(bytes);
    expect(tags.get('TIT2')?.subarray(3).toString('utf16le')).toBe(index === 0 ? '朝の曲' : '夜の曲');
    expect(tags.get('TPE1')?.subarray(3).toString('utf16le')).toBe('独立した音楽家');
    expect(tags.get('TALB')?.subarray(3).toString('utf16le')).toBe('日本語アルバム');
    expect(tags.get('TPE2')?.subarray(3).toString('utf16le')).toBe('Music Sync 作者');
    expect(tags.get('APIC')?.[11]).toBe(3); expect(tags.get('APIC')?.subarray(13)).toEqual(jacket);
    const decoded = await page.evaluate(async base64 => {
      const context = new AudioContext();
      try {
        const buffer = Uint8Array.from(atob(base64), character => character.charCodeAt(0)).buffer;
        const audio = await context.decodeAudioData(buffer); let energy = 0, finite = true;
        for (let channel = 0; channel < audio.numberOfChannels; channel++) for (const sample of audio.getChannelData(channel)) {
          finite &&= Number.isFinite(sample); energy += sample * sample;
        }
        return { channels: audio.numberOfChannels, duration: audio.duration, finite, rms: Math.sqrt(energy / audio.length / audio.numberOfChannels) };
      } finally { await context.close(); }
    }, bytes.toString('base64'));
    expect(decoded.channels).toBe(2); expect(decoded.duration).toBeGreaterThanOrEqual(4); expect(decoded.duration).toBeLessThan(4.3);
    expect(decoded.finite).toBe(true); expect(decoded.rms).toBeGreaterThan(.001);
  }
  await expect(page.locator('#batch-download-all')).toBeEnabled();
  expect(external).toEqual([]); expect(errors).toEqual([]);
});
