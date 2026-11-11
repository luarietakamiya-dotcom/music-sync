import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { strFromU8, unzipSync } from 'fflate';
import { tone, wav } from '../helpers/audio';

const rate = 44100, seconds = 4, frames = rate * seconds;
const targets = ['lead-vocal', 'back-vocal', 'piano', 'guitar', 'bass', 'drums', 'remaining-other'];
const roles = ['vocal-lead', 'vocal-backing', 'keys', 'guitar', 'bass', 'drums', 'other'];
const metadata = [{ role: 'vocal', vocalRole: 'lead' }, { role: 'vocal', vocalRole: 'backing' },
  { role: 'keys', vocalRole: null }, { role: 'guitar', vocalRole: null }, { role: 'bass', vocalRole: null },
  { role: 'drums', vocalRole: null }, { role: 'other', vocalRole: null }];

function musicalFixture(duration = seconds) {
  const count = rate * duration, channels = [new Float32Array(count), new Float32Array(count)];
  let seed = 2137, low = 0;
  for (let frame = 0; frame < count; frame++) {
    const time = frame / rate, beat = time % .5, snare = (time + .25) % .5;
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const noise = seed / 2 ** 32 - .5; low += .1 * (noise - low);
    const lead = .025 * (Math.sin(2 * Math.PI * 330 * time) + .4 * Math.sin(2 * Math.PI * 660 * time)) * (.7 + .3 * Math.sin(time * 4));
    const backing = .018 * (Math.sin(2 * Math.PI * 415.3 * time) + .3 * Math.sin(2 * Math.PI * 830.6 * time));
    const piano = .04 * Math.exp(-beat * 7) * (Math.sin(2 * Math.PI * 523.25 * time) + .4 * Math.sin(2 * Math.PI * 1046.5 * time));
    const guitar = .023 * (Math.sin(2 * Math.PI * 196 * time) + .45 * Math.sin(2 * Math.PI * 588 * time));
    const bass = .035 * Math.sin(2 * Math.PI * 82.4 * time) * (.8 + .2 * Math.sin(time * 2));
    const kick = .045 * Math.exp(-beat * 35) * Math.sin(2 * Math.PI * 58 * beat);
    const hit = .032 * Math.exp(-snare * 35) * (noise - low), hat = .009 * Math.exp(-(time % .125) * 110) * (noise - low);
    const fade = Math.min(1, time / .01, (duration - time) / .03);
    channels[0][frame] = fade * (lead + backing * .8 + piano + guitar + bass + kick + hit + hat);
    channels[1][frame] = fade * (lead + backing + piano * .85 + guitar * .8 + bass + kick + hit * .95 - hat);
  }
  return { sampleRate: rate, channels };
}
const input = (name: string, duration = seconds) => ({ name, mimeType: 'audio/wav', buffer: Buffer.from(wav(musicalFixture(duration), 32, true)) });
async function pair(page: Page) {
  return Promise.all(['a-name', 'b-name', 'a-lufs', 'b-lufs'].map(id => page.locator('#' + id).innerText()));
}
async function staged(page: Page) {
  return page.locator('#stem-track-list .stem-track').evaluateAll(rows => rows.map(row => ({
    id: (row as HTMLElement).dataset.trackId,
    name: row.querySelector('strong')?.firstChild?.textContent,
    selections: Array.from(row.querySelectorAll('select'), select => select.value),
    included: Array.from(row.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'), input => input.checked),
  })));
}
async function priorPair(page: Page) {
  await page.goto('/');
  const file = (name: string, frequency: number) => ({ name, mimeType: 'audio/wav',
    buffer: Buffer.from(wav(tone({ sampleRate: rate, seconds: 1, frequency, amplitude: .08, stereo: true }), 32, true)) });
  await page.locator('#file-input').setInputFiles(file('kept-original.wav', 337));
  await expect(page.getByRole('status', { name: '処理状況', exact: true })).toContainText('解析完了');
  await page.locator('#file-input-b').setInputFiles(file('kept-comparison.wav', 659));
  await expect(page.locator('#b-name')).toContainText('kept-comparison.wav'); await expect(page.locator('#select-b')).toBeEnabled();
  await page.locator('#separation-panel > summary').click();
}
async function resultIds(page: Page) {
  return page.locator('.separation-track').evaluateAll(rows => rows.map(row => (row as HTMLElement).dataset.stemId));
}
async function candidates(page: Page) {
  return page.evaluate(async () => {
    const root = await navigator.storage.getDirectory(); let directory: FileSystemDirectoryHandle;
    try { directory = await root.getDirectoryHandle('music-sync-candidates'); }
    catch (error) { if (error instanceof DOMException && error.name === 'NotFoundError') return []; throw error; }
    const names: string[] = [];
    for await (const name of (directory as FileSystemDirectoryHandle & { keys(): AsyncIterable<string> }).keys()) names.push(name);
    return names.sort();
  });
}
function accumulate(bytes: Buffer, sum: Float64Array[]) {
  expect(bytes.toString('ascii', 0, 4)).toBe('RIFF'); expect(bytes.toString('ascii', 8, 12)).toBe('WAVE');
  let data = -1, size = 0, format = 0, channels = 0, sampleRate = 0, bits = 0;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const length = bytes.readUInt32LE(offset + 4), start = offset + 8;
    expect(start + length).toBeLessThanOrEqual(bytes.length);
    const tag = bytes.toString('ascii', offset, offset + 4);
    if (tag === 'fmt ') { format = bytes.readUInt16LE(start); channels = bytes.readUInt16LE(start + 2); sampleRate = bytes.readUInt32LE(start + 4); bits = bytes.readUInt16LE(start + 14); }
    if (tag === 'data') { data = start; size = length; }
    offset = start + length + (length & 1);
  }
  expect(format).toBe(3); expect(bits).toBe(32); expect(channels).toBe(2); expect(sampleRate).toBe(rate);
  expect(data).toBe(56); expect(size / 8).toBe(frames); expect(size / 8 / sampleRate).toBe(seconds);
  expect(bytes.length).toBe(56 + frames * 8);
  let finite = true;
  for (let frame = 0; frame < frames; frame++) for (let channel = 0; channel < 2; channel++) {
    const value = bytes.readFloatLE(data + (frame * 2 + channel) * 4); finite &&= Number.isFinite(value); sum[channel][frame] += value;
  }
  expect(finite).toBe(true);
}

test('REAL local seven-part instrument separation reconstructs two windows and retains vocal roles through staging, mixing and project restore', async ({ page, context }) => {
  // Real six-head inference plus computed unassigned remainder. There are no
  // model, Worker or network doubles in this case. Headless CPU can take minutes.
  test.setTimeout(240000);
  const errors: string[] = [], external: string[] = [], uploads: string[] = [], models: string[] = [], otherModels: string[] = [];
  const origin = new URL(String(test.info().project.use.baseURL ?? 'http://127.0.0.1:4173')).origin;
  page.on('pageerror', error => errors.push(error.message));
  context.on('request', request => {
    const url = request.url();
    if (/^https?:/.test(url) && new URL(url).origin !== origin) external.push(url);
    if (!['GET', 'HEAD'].includes(request.method())) uploads.push(request.method() + ' ' + url);
    if (/\/models\/mega53-instruments\/.*\.onnx(?:\?|$)/.test(url)) models.push(url);
    else if (/\/models\/.*\.onnx(?:\?|$)/.test(url)) otherModels.push(url);
  });
  await page.clock.install(); await page.clock.resume();
  await page.addInitScript(() => {
    const windows: number[] = []; Object.defineProperty(window, '__instrumentWindows', { value: windows });
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message: unknown, options?: Transferable[] | StructuredSerializeOptions) {
      const request = message as { kind?: string; mode?: string; plan?: { starts?: number[] } };
      if (request?.kind === 'separate' && request.mode === 'instruments') windows.push(request.plan?.starts?.length ?? 0);
      Reflect.apply(post, this, options === undefined ? [message] : [message, options]);
    };
  });
  await priorPair(page); const before = await pair(page), source = musicalFixture(), original = input('full-mix-4s.wav');
  await page.locator('#separation-input').setInputFiles(original); await page.locator('#separation-mode').selectOption('instruments');
  await page.locator('#separation-run').click();
  await expect(page.locator('.separation-track')).toHaveCount(7, { timeout: 210000 });
  await expect(page.locator('#processing-overlay')).toBeHidden(); expect(await resultIds(page)).toEqual(targets);
  expect(await pair(page)).toEqual(before); await expect(page.locator('#select-b')).toBeEnabled();
  expect(await page.evaluate(() => (window as unknown as { __instrumentWindows: number[] }).__instrumentWindows)).toEqual([2]);
  await expect(page.locator('.separation-track[data-stem-id="other"], .separation-track[data-stem-id="vocals"]')).toHaveCount(0);

  const sum = [new Float64Array(frames), new Float64Array(frames)];
  for (const target of targets) {
    const pending = page.waitForEvent('download');
    await page.locator(`.separation-track[data-stem-id="${target}"]`).getByRole('button', { name: /WAV保存/ }).click();
    const saved = await pending; expect(saved.suggestedFilename()).toBe('full-mix-4s_' + target + '.wav');
    accumulate(await readFile((await saved.path())!), sum);
  }
  let difference = 0;
  for (let channel = 0; channel < 2; channel++) for (let frame = 0; frame < frames; frame++) difference += (sum[channel][frame] - source.channels[channel][frame]) ** 2;
  // Reconstruction, duration, finite PCM and actual model loading are functional
  // checks. They do not measure instrument isolation or subjective sound quality.
  expect(Math.sqrt(difference / (frames * 2))).toBeLessThan(1e-5);
  expect(models.length).toBeGreaterThan(0); expect(otherModels).toEqual([]);
  await page.clock.fastForward(61000); // expire download ownership before testing the staged group's own leases
  await page.locator('#separation-stage').click(); await expect(page.locator('#stem-track-list .stem-track')).toHaveCount(7);
  expect(await pair(page)).toEqual(before);
  const roleSelectors = page.locator('#stem-track-list select[aria-label$=" の役割"]');
  expect(await roleSelectors.evaluateAll(elements => elements.map(element => (element as HTMLSelectElement).value))).toEqual(roles);
  for (const id of ['studio-restore', 'guitar-double', 'stem-multitrack-auto', 'stem-vocal-support', 'stem-stabilize']) await page.locator('#' + id).uncheck();
  await page.locator('#separation-clear').click(); await expect(page.locator('.separation-track')).toHaveCount(0);
  await expect(page.locator('#stem-track-list .stem-track')).toHaveCount(7); expect(await pair(page)).toEqual(before);
  await page.locator('#stem-render').click(); await expect(page.locator('#stem-status')).toContainText('7素材を読み込み', { timeout: 30000 });
  await expect(page.locator('#processing-overlay')).toBeHidden(); await expect(page.locator('#a-name')).toContainText('7 tracks');
  await expect(page.locator('#select-b')).toBeDisabled(); await expect(page.locator('#clipped')).toHaveText('0');
  await expect(page.locator('#separation-source-name')).toHaveText('現在のOriginalを分離：full-mix-4s.wav');

  const saving = page.waitForEvent('download'); await page.locator('#project-save').click(); const saved = await saving;
  const archive = unzipSync(new Uint8Array(await readFile((await saved.path())!)));
  const manifest = JSON.parse(strFromU8(archive['manifest.json'])) as { assets: { id: string; path: string }[]; state: {
    stems: { role: string; vocalRole?: string }[]; committed: { role: string; vocalRole?: string }[]; sources: { a: { original: string } };
  } };
  for (const records of [manifest.state.stems, manifest.state.committed]) expect(records.map(record => ({ role: record.role, vocalRole: record.vocalRole ?? null }))).toEqual(metadata);
  const raw = manifest.assets.find(asset => asset.id === manifest.state.sources.a.original);
  expect(raw).toBeDefined(); expect(Buffer.from(archive[raw!.path])).toEqual(original.buffer);
  await page.reload(); await page.locator('#project-open').setInputFiles((await saved.path())!);
  await expect(page.locator('#project-status')).toContainText('プロジェクトを復元しました');
  expect(await roleSelectors.evaluateAll(elements => elements.map(element => (element as HTMLSelectElement).value))).toEqual(roles);
  await expect(page.locator('#error')).toBeHidden(); expect(errors).toEqual([]); expect(external).toEqual([]); expect(uploads).toEqual([]);
});

// A separate, explicit inference double for the fast ownership/error tests.
// It writes genuine OPFS Float32 WAVs, so production client validation and leases
// run normally. Neither project/mixing nor model quality is faked or claimed.
const mockWorker = String.raw`
async function read(file){
 const bytes=await file.arrayBuffer(),view=new DataView(bytes);let rate=0,channels=0,frames=0,start=-1;
 const tag=offset=>String.fromCharCode(...new Uint8Array(bytes,offset,4));
 for(let offset=12;offset+8<=bytes.byteLength;){const size=view.getUint32(offset+4,true),data=offset+8;
  if(tag(offset)==='fmt '){if(view.getUint16(data,true)!==3||view.getUint16(data+14,true)!==32)throw Error('Expected Float32 WAV');channels=view.getUint16(data+2,true);rate=view.getUint32(data+4,true);}
  if(tag(offset)==='data'){start=data;frames=size/(channels*4);}offset=data+size+(size&1);
 }
 if(start<0||!rate||!frames)throw Error('Invalid mock source');return {view,start,rate,channels,frames};
}
function wav(source,gain,headerOnly=false){
 const bytes=new ArrayBuffer(56+(headerOnly?0:source.frames*8)),view=new DataView(bytes),tag=(offset,text)=>{for(let i=0;i<text.length;i++)view.setUint8(offset+i,text.charCodeAt(i));};
 tag(0,'RIFF');view.setUint32(4,48+source.frames*8,true);tag(8,'WAVE');tag(12,'fmt ');view.setUint32(16,16,true);view.setUint16(20,3,true);
 view.setUint16(22,2,true);view.setUint32(24,source.rate,true);view.setUint32(28,source.rate*8,true);view.setUint16(32,8,true);view.setUint16(34,32,true);
 tag(36,'fact');view.setUint32(40,4,true);view.setUint32(44,source.frames,true);tag(48,'data');view.setUint32(52,source.frames*8,true);let peak=0;
 if(!headerOnly)for(let frame=0;frame<source.frames;frame++)for(let channel=0;channel<2;channel++){
  const value=source.view.getFloat32(source.start+(frame*source.channels+Math.min(channel,source.channels-1))*4,true)*gain;
  view.setFloat32(56+(frame*2+channel)*4,value,true);peak=Math.max(peak,Math.abs(value));
 }return {bytes,peak};
}
self.onmessage=event=>{void(async()=>{
 const request=event.data;if(request.kind!=='separate'||request.mode!=='instruments')throw Error('Unexpected mock mode');
 const source=await read(request.file),targets=request.plan.targets,targetPeaks={};let maxPeak=0;
 for(const target of targets){const part=wav(source,1/targets.length,action==='hold'),stream=await request.destinations[target].createWritable();
  try{await stream.write(part.bytes);await stream.close();}catch(error){await stream.abort().catch(()=>{});throw error;}
  targetPeaks[target]=part.peak;maxPeak=Math.max(maxPeak,part.peak);if(action==='error')throw Error('MOCK instrument inference error');
 }
 if(action==='hold'){self.postMessage({type:'separation-progress',fraction:.24,text:'MOCK instrument inference wait'});await new Promise(()=>{});return;}
 self.postMessage({type:'separation-result',report:{model:'Mega53 Instruments',frames:source.frames,sampleRate:source.rate,segments:request.plan.starts.length,targetPeaks,maxPeak,residualRmsRatio:0,backend:'wasm'}});
})().catch(error=>self.postMessage({type:'error',message:error.message}));};
`;

test('MOCK seven-part inference errors and cancellation remove provisional files while retaining results, pending edits and A/B', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await priorPair(page); const before = await pair(page), manifest = await (await page.request.get('/workers.json')).json();
  let action: 'success' | 'error' | 'hold' = 'success';
  await page.route('**/assets/mock-instrument-separation.worker.js', route => route.fulfill({ status: 200, contentType: 'text/javascript',
    body: 'const action=' + JSON.stringify(action) + ';\n' + mockWorker }));
  await page.route('**/workers.json', route => route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ ...manifest, separation: 'assets/mock-instrument-separation.worker.js' }) }));
  await page.locator('#separation-input').setInputFiles(input('mock-instruments.wav', 2)); await page.locator('#separation-mode').selectOption('instruments');
  await page.locator('#separation-run').click(); await expect(page.locator('.separation-track')).toHaveCount(7);
  await expect(page.locator('#processing-overlay')).toBeHidden(); expect(await resultIds(page)).toEqual(targets);
  await page.locator('#separation-stage').click(); await expect(page.locator('#stem-track-list .stem-track')).toHaveCount(7);
  await page.locator('#stem-track-list .stem-track').first().getByRole('combobox', { name: / の音量$/ }).selectOption('-3');
  await page.locator('#stem-track-list .stem-track').last().getByRole('checkbox').uncheck();
  const pending = await staged(page), baseline = await candidates(page);
  const urls = await page.locator('.separation-track audio').evaluateAll(elements => elements.map(element => element.getAttribute('src')));
  expect(baseline.length).toBeGreaterThanOrEqual(8);
  for (const outcome of ['error', 'hold'] as const) {
    action = outcome; await page.locator('#separation-run').click();
    if (outcome === 'hold') {
      await expect(page.locator('#status')).toContainText('MOCK instrument inference wait');
      await expect(page.locator('#processing-overlay')).toBeVisible(); expect((await candidates(page)).length).toBeGreaterThan(baseline.length);
      await page.locator('#cancel-button').click(); await expect(page.locator('#separation-status')).toContainText('キャンセル');
    } else await expect(page.locator('#separation-status')).toContainText('MOCK instrument inference error');
    await expect(page.locator('#processing-overlay')).toBeHidden(); await expect.poll(() => candidates(page), { timeout: 10000 }).toEqual(baseline);
    expect(await pair(page)).toEqual(before); expect(await staged(page)).toEqual(pending); expect(await resultIds(page)).toEqual(targets);
    expect(await page.locator('.separation-track audio').evaluateAll(elements => elements.map(element => element.getAttribute('src')))).toEqual(urls);
    await expect(page.locator('#separation-stage')).toBeEnabled(); await expect(page.locator('#separation-run')).toBeEnabled(); await expect(page.locator('#select-b')).toBeEnabled();
  }
  expect(errors).toEqual([]);
});
