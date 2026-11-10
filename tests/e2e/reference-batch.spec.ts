import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { unzipSync } from 'fflate';
import { wav } from '../helpers/audio';
import { perceptualFixture, type FixtureName } from '../fixtures/perceptual';

function music(name: string, fixture: FixtureName = 'balanced', gain = 1) {
  const audio = perceptualFixture(fixture);
  if (gain !== 1) for (const channel of audio.channels) for (let n = 0; n < channel.length; n++) channel[n] *= gain;
  return { name, mimeType: 'audio/wav', buffer: Buffer.from(wav(audio, 32, true)) };
}
async function reveal(page: Page, selector: string) {
  await page.locator(selector).evaluate(element => {
    for (let parent = element.parentElement; parent; parent = parent.parentElement)
      if (parent instanceof HTMLDetailsElement) parent.open = true;
  });
}
async function loadMainCandidate(page: Page) {
  await page.goto('/'); await page.locator('#file-input').setInputFiles(music('main-original.wav', 'bass-heavy'));
  await expect(page.locator('#mode-AUTO')).toBeEnabled(); await page.locator('#mode-AUTO').click();
  await expect(page.locator('#finish-explanation')).toContainText('候補を用意しました');
}
async function mainPair(page: Page) {
  return Promise.all(['a-name', 'b-name', 'a-lufs', 'b-lufs'].map(id => page.locator('#' + id).innerText()));
}
async function awaitBatch(page: Page, count: number) {
  await expect(page.locator('#processing-overlay')).toBeHidden();
  await expect(page.locator('#batch-list [data-state="ready"]')).toHaveCount(count);
  await expect(page.locator('#batch-status')).toContainText(`${count}/`);
}

test('reference import preserves A/B, guides a new candidate and can be removed independently', async ({ page }) => {
  await loadMainCandidate(page); const previous = await mainPair(page);
  await reveal(page, '#reference-input');
  await page.locator('#reference-input').setInputFiles(music('reference-balanced.wav'));
  await expect(page.locator('#reference-status')).toContainText('解析が完了');
  expect(await mainPair(page)).toEqual(previous);
  await expect(page.locator('#reference-enabled')).toBeChecked(); await page.locator('#reference-strength').selectOption('1');
  await page.locator('#output-profile').selectOption('youtube'); await page.locator('#reference-finish').click();
  await expect(page.locator('#finish-explanation')).toContainText('候補を用意しました');
  await expect(page.locator('#reference-result')).not.toHaveText('');
  await expect(page.locator('#preferences-result')).toContainText('YouTube');
  await expect(page.locator('#match-toggle')).toBeChecked();
  expect(Number(await page.locator('#true-peak').innerText())).toBeLessThanOrEqual(-.9);
  const guided = await mainPair(page); expect(guided[0]).toBe(previous[0]); expect(guided[2]).toBe(previous[2]);
  await page.locator('#reference-clear').click();
  await expect(page.locator('#reference-name')).toContainText('未選択'); expect(await mainPair(page)).toEqual(guided);
});

test('invalid low-confidence reference does not replace the saved reference or main audio', async ({ page }) => {
  await loadMainCandidate(page); await reveal(page, '#reference-input'); await page.locator('#reference-input').setInputFiles(music('good-reference.wav'));
  await expect(page.locator('#reference-status')).toContainText('解析が完了'); const before = await mainPair(page);
  const silent = { sampleRate: 24000, channels: [new Float32Array(72000)] };
  await page.locator('#reference-input').setInputFiles({ name: 'silent.wav', mimeType: 'audio/wav', buffer: Buffer.from(wav(silent, 32, true)) });
  await expect(page.locator('#error')).toBeVisible(); await expect(page.locator('#processing-overlay')).toBeHidden();
  await expect(page.locator('#reference-name')).toContainText('good-reference.wav');
  await expect(page.locator('#reference-finish')).toBeEnabled(); expect(await mainPair(page)).toEqual(before);
});

test('two finished songs get a measured common level, ordered PCM24 ZIP and independent aligned preview', async ({ page }) => {
  const external: string[] = [];
  page.on('request', request => { if (!request.url().startsWith('http://127.0.0.1:4173') && !request.url().startsWith('blob:')) external.push(request.url()); });
  await loadMainCandidate(page); const before = await mainPair(page);
  await reveal(page, '#reference-input');
  await page.locator('#reference-input').setInputFiles(music('batch-reference.wav'));
  await expect(page.locator('#reference-status')).toContainText('解析が完了');
  await page.locator('#reference-strength').selectOption('0.35');
  await page.evaluate(() => {
    const state = window as unknown as Window & { batchReferenceStrengths: (number | undefined)[] };
    state.batchReferenceStrengths = [];
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message: unknown, options?: Transferable[] | StructuredSerializeOptions) {
      const request = message as { kind?: string; reference?: { strength?: number } };
      if (request?.kind === 'batch-finish') state.batchReferenceStrengths.push(request.reference?.strength);
      Reflect.apply(post, this, [message, options]);
    };
  });
  await reveal(page, '#audio-export-format'); await page.locator('#audio-export-format').selectOption('wav-24');
  await page.locator('#audio-export-dither').uncheck();
  await reveal(page, '#batch-input');
  await page.locator('#batch-input').setInputFiles([music('Quiet.wav', 'balanced', .45), music('Loud.wav', 'balanced', .9)]);
  await page.locator('#batch-run').click(); await awaitBatch(page, 2);
  expect(await page.evaluate(() => (window as unknown as Window & { batchReferenceStrengths: number[] }).batchReferenceStrengths)).toEqual([.35, .35]);
  await expect(page.locator('.batch-track-reference').first()).toBeVisible();
  await expect(page.locator('.batch-track-reference').first()).toContainText(/お手本|参考|リファレンス/);
  await page.locator('.batch-track').first().getByText('この曲に行ったこと', { exact: true }).click();
  await expect(page.locator('.batch-track').first().locator('details li').first()).toBeVisible();
  expect(await mainPair(page)).toEqual(before); await expect(page.locator('#batch-target')).toContainText('LUFS');
  const levels = await page.locator('.batch-track-status').allTextContents();
  const lufs = levels.map(value => Number(/完了：(-?[\d.]+) LUFS/.exec(value)?.[1]));
  expect(lufs.every(Number.isFinite)).toBe(true); expect(Math.abs(lufs[0] - lufs[1])).toBeLessThanOrEqual(.11);
  const pending = page.waitForEvent('download'); await page.locator('#batch-download-all').click();
  const download = await pending; expect(download.suggestedFilename()).toMatch(/\.zip$/);
  const entries = unzipSync(new Uint8Array(await readFile((await download.path())!)));
  expect(Object.keys(entries)).toEqual(['01 Quiet.wav', '02 Loud.wav']);
  for (const bytes of Object.values(entries)) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getUint16(20, true)).toBe(1); expect(view.getUint16(34, true)).toBe(24);
    expect(view.getUint32(24, true)).toBe(24000); expect(view.getUint32(40, true)).toBe(24000 * 4 * 2 * 3);
  }
  await expect(page.locator('#batch-download-all')).toBeEnabled();
  await page.locator('.batch-track').first().getByRole('button', { name: '原音と仕上がりを聴く' }).click();
  await expect(page.locator('#a-name')).toContainText('Quiet.wav'); await expect(page.locator('#select-b')).toBeEnabled();
  await expect(page.locator('#match-toggle')).toBeChecked(); const selected = await mainPair(page);
  await page.locator('#batch-clear').click(); await expect(page.locator('.batch-track')).toHaveCount(0);
  expect(await mainPair(page)).toEqual(selected); await expect(page.locator('#play-button')).toBeEnabled();
  await page.locator('#play-button').click(); await expect(page.locator('#play-button')).toHaveAttribute('aria-label', '一時停止');
  expect(external).toEqual([]);
});

test('a corrupt song is isolated while valid songs finish and current A/B stays unchanged', async ({ page }) => {
  await loadMainCandidate(page); const previous = await mainPair(page);
  await reveal(page, '#batch-input');
  await page.locator('#batch-input').setInputFiles([
    { name: 'broken.wav', mimeType: 'audio/wav', buffer: Buffer.from('not a WAV') }, music('valid.wav'),
  ]);
  await page.locator('#batch-run').click(); await awaitBatch(page, 1);
  await expect(page.locator('.batch-track').first()).toHaveAttribute('data-state', 'error');
  await expect(page.locator('.batch-track').last()).toHaveAttribute('data-state', 'ready');
  expect(await mainPair(page)).toEqual(previous); await expect(page.locator('#batch-download-all')).toBeEnabled();
});

test('cancelled batch cannot publish late candidates and main jobs block batch additions', async ({ page }) => {
  await loadMainCandidate(page); const previous = await mainPair(page);
  await reveal(page, '#batch-input');
  await page.locator('#batch-input').setInputFiles([music('queued-one.wav'), music('queued-two.wav')]);
  let release!: () => void, entered!: () => void, continued!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  const handled = new Promise<void>(resolve => { continued = resolve; });
  await page.route('**/workers.json', async route => { entered(); await gate; await route.continue(); continued(); });
  try {
    await page.locator('#batch-run').click(); await started;
    await expect(page.locator('#batch-input')).toBeDisabled(); await expect(page.locator('#processing-overlay')).toBeVisible();
    await page.locator('#cancel-button').click(); release(); await handled; await page.unroute('**/workers.json');
    await expect(page.locator('#processing-overlay')).toBeHidden(); await expect(page.locator('#batch-status')).toContainText('キャンセル');
    await expect(page.locator('#batch-download-all')).toBeDisabled(); expect(await mainPair(page)).toEqual(previous);
    await page.evaluate(() => {
      document.getElementById('demo-button')!.click();
      const dataTransfer = new DataTransfer(); dataTransfer.items.add(new File(['ignored'], 'ignored.wav'));
      document.getElementById('batch-dropzone')!.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
      document.getElementById('cancel-button')!.click();
    });
    await expect(page.locator('.batch-track')).toHaveCount(2); expect(await mainPair(page)).toEqual(previous);
  } finally { release(); }
});

test('a failed rerun retains the previous preview but excludes its old album target from ZIP', async ({ page }) => {
  await page.goto('/'); await reveal(page, '#batch-input'); await page.locator('#batch-input').setInputFiles(music('kept.wav'));
  await page.locator('#batch-run').click(); await awaitBatch(page, 1);
  const manifest = JSON.parse(await readFile('apps/web/dist/workers.json', 'utf8'));
  await page.route('**/assets/batch-reject-fixture.js', route => route.fulfill({ contentType: 'text/javascript',
    body: "self.onmessage=()=>self.postMessage({type:'error',message:'rerun rejected fixture'});" }));
  await page.route('**/workers.json', route => route.fulfill({ contentType: 'application/json',
    body: JSON.stringify({ ...manifest, batch: 'assets/batch-reject-fixture.js' }) }));
  await page.locator('#batch-run').click(); await expect(page.locator('#batch-status')).toContainText('仕上げられる曲がありません');
  await expect(page.locator('.batch-track-status')).toContainText('rerun rejected fixture');
  await expect(page.locator('#batch-download-all')).toBeDisabled();
  await expect(page.locator('.batch-track').getByRole('button', { name: 'この曲を保存' })).toBeDisabled();
  await expect(page.locator('.batch-track').getByRole('button', { name: '原音と仕上がりを聴く' })).toBeEnabled();
});
