import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { tone, wav } from '../helpers/audio';

type SoundCall = { event: 'play' | 'pause'; name: string; loop: boolean; volume: number };
type SoundWindow = Window & {
  __seCalls: SoundCall[];
  __seVoices: HTMLMediaElement[];
  __sePlaying: Set<HTMLMediaElement>;
  __seGraphLinks: number;
};

// Only UI sound media calls are mocked. Audio import, Workers and WAV export stay real.
async function instrumentSounds(page: Page) {
  await page.addInitScript(() => {
    const state = window as unknown as SoundWindow;
    state.__seCalls = []; state.__seVoices = []; state.__sePlaying = new Set(); state.__seGraphLinks = 0;
    const isSound = (audio: HTMLMediaElement) => /\/sfx\/(processing_loop|success|error)\.wav(?:$|\?)/.test(audio.src);
    const name = (audio: HTMLMediaElement) => new URL(audio.src).pathname.split('/').pop()!;
    const play = HTMLMediaElement.prototype.play, pause = HTMLMediaElement.prototype.pause;
    HTMLMediaElement.prototype.play = function () {
      if (!isSound(this)) return play.call(this);
      if (!state.__seVoices.includes(this)) state.__seVoices.push(this);
      state.__sePlaying.add(this);
      state.__seCalls.push({ event: 'play', name: name(this), loop: this.loop, volume: this.volume });
      return Promise.resolve();
    };
    HTMLMediaElement.prototype.pause = function () {
      if (!isSound(this)) return pause.call(this);
      state.__sePlaying.delete(this);
      state.__seCalls.push({ event: 'pause', name: name(this), loop: this.loop, volume: this.volume });
    };
    const connect = AudioContext.prototype.createMediaElementSource;
    AudioContext.prototype.createMediaElementSource = function (audio: HTMLMediaElement) {
      if (isSound(audio)) state.__seGraphLinks++;
      return connect.call(this, audio);
    };
  });
}
async function sounds(page: Page) {
  return page.evaluate(() => {
    const state = window as unknown as SoundWindow;
    return { calls: state.__seCalls, graphLinks: state.__seGraphLinks,
      voices: state.__seVoices.map(audio => ({ name: new URL(audio.src).pathname.split('/').pop(),
        volume: audio.volume, loop: audio.loop, playing: state.__sePlaying.has(audio) })) };
  });
}
async function reveal(page: Page, selector: string) {
  await page.locator(selector).evaluate(element => {
    for (let parent = element.parentElement; parent; parent = parent.parentElement)
      if (parent instanceof HTMLDetailsElement) parent.open = true;
  });
}
async function slider(page: Page, selector: string, value: number) {
  await page.locator(selector).evaluate((element, next) => {
    (element as HTMLInputElement).value = String(next); element.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}
const inputFile = (name = 'se-fixture.wav') => ({ name, mimeType: 'audio/wav',
  buffer: Buffer.from(wav(tone({ sampleRate: 16000, seconds: 2, amplitude: .08 }), 32, true)) });

test('busy playback loops once, completion stops it, and SE volume persists independently of music', async ({ page }) => {
  await instrumentSounds(page); await page.goto('/'); await reveal(page, '#se-volume');
  await expect(page.locator('#se-enabled')).toBeChecked(); await expect(page.locator('#se-volume')).toHaveValue('25');
  expect((await sounds(page)).calls).toEqual([]);
  await slider(page, '#volume', .42); await slider(page, '#se-volume', 37);
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/workers.json', async route => { await gate; await route.continue(); });
  try {
    await page.locator('#file-input').setInputFiles(inputFile());
    await expect(page.locator('#processing-overlay')).toBeVisible();
    await expect.poll(async () => (await sounds(page)).voices.some(voice => voice.loop && voice.playing)).toBe(true);
    expect((await sounds(page)).calls.filter(call => call.event === 'play' && call.name === 'processing_loop.wav')).toHaveLength(1);
    await slider(page, '#se-volume', 61);
    expect((await sounds(page)).voices.find(voice => voice.loop)?.volume).toBe(.61);
    await expect(page.locator('#volume')).toHaveValue('0.42');
    release(); await expect(page.locator('#mode-AUTO')).toBeEnabled();
    await expect.poll(async () => (await sounds(page)).calls.filter(call => call.event === 'play' && call.name === 'success.wav').length).toBe(1);
    expect((await sounds(page)).voices.find(voice => voice.loop)?.playing).toBe(false);
    expect((await sounds(page)).calls.some(call => call.name === 'error.wav')).toBe(false);
  } finally { release(); }
  await page.reload(); await reveal(page, '#se-volume');
  await expect(page.locator('#se-volume')).toHaveValue('61'); await expect(page.locator('#se-volume-value')).toHaveText('61%');
  expect((await sounds(page)).calls).toEqual([]);
  await page.locator('#se-test-error').click();
  expect((await sounds(page)).voices.some(voice => voice.name === 'error.wav' && voice.playing && voice.volume === .61)).toBe(true);
  await page.locator('#se-enabled').uncheck();
  expect((await sounds(page)).voices.every(voice => !voice.playing)).toBe(true);
  const plays = (await sounds(page)).calls.filter(call => call.event === 'play').length;
  await page.locator('#se-test-success').click();
  expect((await sounds(page)).calls.filter(call => call.event === 'play')).toHaveLength(plays);
  await page.reload(); await reveal(page, '#se-enabled'); await expect(page.locator('#se-enabled')).not.toBeChecked();
});

test('a real import error stops the loop and sounds one error without success', async ({ page }) => {
  await instrumentSounds(page); await page.goto('/');
  await page.locator('#file-input').setInputFiles({ name: 'invalid.wav', mimeType: 'audio/wav', buffer: Buffer.from('invalid WAV') });
  await expect(page.locator('#error')).toBeVisible(); await expect(page.locator('#processing-overlay')).toBeHidden();
  await expect.poll(async () => (await sounds(page)).calls.filter(call => call.event === 'play' && call.name === 'error.wav').length).toBe(1);
  const current = await sounds(page);
  expect(current.calls.some(call => call.event === 'play' && call.name === 'processing_loop.wav')).toBe(true);
  expect(current.calls.some(call => call.event === 'play' && call.name === 'success.wav')).toBe(false);
  expect(current.voices.find(voice => voice.loop)?.playing).toBe(false);
});

test('cancellation and page hide stop SE without a completion chime or stale result', async ({ page }) => {
  await instrumentSounds(page); await page.goto('/');
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void, continued!: () => void;
  const routed = new Promise<void>(resolve => { entered = resolve; });
  const handled = new Promise<void>(resolve => { continued = resolve; });
  await page.route('**/workers.json', async route => {
    entered(); await gate; await route.continue(); continued();
  });
  try {
    await page.locator('#file-input').setInputFiles(inputFile());
    await expect(page.locator('#processing-overlay')).toBeVisible();
    await routed;
    await page.locator('#cancel-button').click();
    await expect(page.locator('#status')).toContainText('キャンセル');
    expect((await sounds(page)).voices.every(voice => !voice.playing)).toBe(true);
    // Finish the held handler before unroute: otherwise Playwright may continue it twice.
    release(); await handled; await page.unroute('**/workers.json');
    await expect(page.locator('#mode-AUTO')).toBeDisabled();
    expect((await sounds(page)).calls.filter(call => call.event === 'play').map(call => call.name)).toEqual(['processing_loop.wav']);
    await reveal(page, '#se-test-success'); await page.locator('#se-test-success').click();
    expect((await sounds(page)).voices.some(voice => voice.playing)).toBe(true);
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
    expect((await sounds(page)).voices.every(voice => !voice.playing)).toBe(true);
  } finally { release(); }
});

test('SE and monitoring gain never enter a Float32 WAV export of the current B', async ({ page }) => {
  await instrumentSounds(page); await page.goto('/');
  await page.locator('#file-input').setInputFiles(inputFile('original.wav')); await expect(page.locator('#mode-AUTO')).toBeEnabled();
  // A manually loaded comparison B is intentionally not an exportable processed candidate.
  await page.locator('#mode-AUTO').click();
  await expect(page.locator('#finish-explanation')).toContainText('候補を用意しました');
  await reveal(page, '#audio-export-format'); await page.locator('#audio-export-format').selectOption('wav-f32');
  await reveal(page, '#se-volume'); await page.locator('#se-enabled').uncheck();
  const save = async () => {
    await expect(page.locator('#wav-button')).toBeEnabled();
    const pending = page.waitForEvent('download'); await page.locator('#wav-button').click();
    const result = await pending; const bytes = await readFile((await result.path())!);
    await expect(page.locator('#wav-button')).toBeEnabled(); return bytes;
  };
  const muted = await save();
  await page.locator('#se-enabled').check(); await slider(page, '#se-volume', 100); await slider(page, '#volume', .13);
  await page.locator('#se-test-error').click(); const audible = await save();
  expect(audible).toEqual(muted);
  expect(audible.readUInt16LE(20)).toBe(3); expect(audible.readUInt32LE(24)).toBe(16000);
  const current = await sounds(page);
  expect(current.calls.some(call => call.event === 'play' && call.name === 'processing_loop.wav' && call.volume === 1)).toBe(true);
  expect(current.graphLinks).toBe(0);
});
