import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { strFromU8, unzipSync } from 'fflate';
import { tone, wav } from '../helpers/audio';

interface SavedStem { asset: string; original?: string }
interface SavedSource { original?: string; name: string; mix?: { tracks: unknown[] } }
interface SavedProject {
  assets: { id: string; path: string; name: string; mimeType: string }[];
  state: { stems: SavedStem[]; committed: SavedStem[]; sources: { a: SavedSource } };
}
const fixture = (name: string, frequency: number) => ({ name, mimeType: 'audio/wav',
  buffer: Buffer.from(wav(tone({ sampleRate: 16000, seconds: 2, stereo: true, frequency, amplitude: .06 }), 32, true)) });
async function pair(page: Page) {
  return Promise.all(['a-name', 'b-name', 'a-lufs', 'b-lufs'].map(id => page.locator('#' + id).innerText()));
}
async function saveProject(page: Page) {
  const pending = page.waitForEvent('download'); await page.locator('#project-save').click(); const saved = await pending;
  expect(saved.suggestedFilename()).toMatch(/\.musicsync\.zip$/);
  const bytes = await readFile((await saved.path())!), entries = unzipSync(new Uint8Array(bytes));
  const manifest = JSON.parse(strFromU8(entries['manifest.json'])) as SavedProject;
  await expect(page.locator('#processing-overlay')).toBeHidden();
  return { bytes, entries, manifest };
}
function assetBytes(saved: Awaited<ReturnType<typeof saveProject>>, id: string | undefined) {
  expect(id).toBeTruthy();
  const asset = saved.manifest.assets.find(asset => asset.id === id);
  expect(asset).toBeDefined(); expect(asset!.mimeType).toBe('audio/wav');
  return Buffer.from(saved.entries[asset!.path]);
}

// Only neural inference is replaced. Production separation orchestration writes
// real OPFS WAVs; project save/restore, fresh analysis and the STEM mixer are real.
const mockWorker = String.raw`
async function decode(file){
 const bytes=await file.arrayBuffer(),view=new DataView(bytes);let rate=0,channels=0,frames=0,start=-1;
 const tag=offset=>String.fromCharCode(...new Uint8Array(bytes,offset,4));
 for(let offset=12;offset+8<=bytes.byteLength;){const size=view.getUint32(offset+4,true),data=offset+8;
  if(tag(offset)==='fmt '){if(view.getUint16(data,true)!==3||view.getUint16(data+14,true)!==32)throw Error('Expected Float32 WAV');
   channels=view.getUint16(data+2,true);rate=view.getUint32(data+4,true);}
  if(tag(offset)==='data'){start=data;frames=size/(channels*4);}offset=data+size+(size&1);
 }
 if(start<0||!rate||!frames)throw Error('Invalid mock input');
 return {view,start,frames,channels,rate};
}
function wav(source,gain){
 const bytes=new ArrayBuffer(56+source.frames*8),view=new DataView(bytes),tag=(offset,text)=>{
  for(let i=0;i<text.length;i++)view.setUint8(offset+i,text.charCodeAt(i));
 };
 tag(0,'RIFF');view.setUint32(4,bytes.byteLength-8,true);tag(8,'WAVE');tag(12,'fmt ');view.setUint32(16,16,true);
 view.setUint16(20,3,true);view.setUint16(22,2,true);view.setUint32(24,source.rate,true);view.setUint32(28,source.rate*8,true);
 view.setUint16(32,8,true);view.setUint16(34,32,true);tag(36,'fact');view.setUint32(40,4,true);view.setUint32(44,source.frames,true);
 tag(48,'data');view.setUint32(52,source.frames*8,true);let peak=0;
 for(let frame=0;frame<source.frames;frame++)for(let channel=0;channel<2;channel++){
  const value=source.view.getFloat32(source.start+(frame*source.channels+Math.min(channel,source.channels-1))*4,true)*gain;
  view.setFloat32(56+(frame*2+channel)*4,value,true);peak=Math.max(peak,Math.abs(value));
 }return {bytes,peak};
}
self.onmessage=event=>{void(async()=>{
 const request=event.data;if(request.kind!=='separate'||request.mode!=='four')throw Error('Unexpected mocked inference request');
 const source=await decode(request.file),targets=request.plan.targets,targetPeaks={};let maxPeak=0;
 for(const target of targets){const part=wav(source,1/targets.length),stream=await request.destinations[target].createWritable();
  try{await stream.write(part.bytes);await stream.close();}catch(error){await stream.abort().catch(()=>{});throw error;}
  targetPeaks[target]=part.peak;maxPeak=Math.max(maxPeak,part.peak);
 }
 self.postMessage({type:'separation-result',report:{model:'SCNet',frames:source.frames,sampleRate:source.rate,segments:request.plan.starts.length,
  targetPeaks,maxPeak,residualRmsRatio:0,backend:'wasm'}});
})().catch(error=>self.postMessage({type:'error',message:error.message}));};
`;

test('MOCK separation retains an independent full-mix original through staged project restore, real remix and another save', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const prior = fixture('prior-main.wav', 110), original = fixture('new-full-mix.wav', 1600);
  expect(original.buffer.equals(prior.buffer)).toBe(false);
  await page.goto('/'); await page.locator('#file-input').setInputFiles(prior);
  await expect(page.getByRole('status', { name: '処理状況', exact: true })).toContainText('解析完了');
  const before = await pair(page), manifest = await (await page.request.get('/workers.json')).json();
  await page.route('**/assets/mock-project-separation.worker.js', route => route.fulfill({ status: 200, contentType: 'text/javascript', body: mockWorker }));
  await page.route('**/workers.json', route => route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ ...manifest, separation: 'assets/mock-project-separation.worker.js' }) }));
  await page.locator('#separation-panel > summary').click();
  await page.locator('#separation-input').setInputFiles(original); await page.locator('#separation-run').click();
  await expect(page.locator('.separation-track')).toHaveCount(4); await expect(page.locator('#processing-overlay')).toBeHidden();
  await page.locator('#separation-stage').click(); await expect(page.locator('#stem-track-list .stem-track')).toHaveCount(4);
  expect(await pair(page)).toEqual(before);

  // Save BEFORE mixing: current A is still the unrelated prior song. Each
  // pending STEM must retain the independent source, rather than borrowing A's.
  const staged = await saveProject(page);
  expect(staged.manifest.state.committed).toHaveLength(0);
  const origins = staged.manifest.state.stems.map(stem => stem.original);
  expect(origins).toHaveLength(4); expect(origins.every(id => typeof id === 'string')).toBe(true);
  expect(new Set(origins).size).toBe(1);
  expect(assetBytes(staged, origins[0])).toEqual(original.buffer);
  expect(assetBytes(staged, staged.manifest.state.sources.a.original)).toEqual(prior.buffer);
  expect(origins[0]).not.toBe(staged.manifest.state.sources.a.original);

  await page.reload();
  await page.locator('#project-open').setInputFiles({ name: 'pending-separated.musicsync.zip', mimeType: 'application/zip', buffer: staged.bytes });
  await expect(page.locator('#project-status')).toContainText('プロジェクトを復元しました');
  expect(await pair(page)).toEqual(before); await expect(page.locator('#stem-track-list .stem-track')).toHaveCount(4);
  // A full page reload removed the transient separation result and its WeakMap.
  await expect(page.locator('.separation-track')).toHaveCount(0);
  await page.locator('#stem-render').click();
  await expect(page.locator('#stem-status')).toContainText('4素材を読み込み');
  await expect(page.locator('#processing-overlay')).toBeHidden(); await expect(page.locator('#a-name')).toContainText('4 tracks');
  await page.locator('#separation-panel > summary').click();
  await expect(page.locator('#separation-source-name')).toHaveText('現在のOriginalを分離：new-full-mix.wav');

  const mixed = await saveProject(page);
  expect(mixed.manifest.state.sources.a.mix?.tracks).toHaveLength(4);
  expect(assetBytes(mixed, mixed.manifest.state.sources.a.original)).toEqual(original.buffer);
  expect(assetBytes(mixed, mixed.manifest.state.sources.a.original).equals(prior.buffer)).toBe(false);
  expect(mixed.manifest.state.committed).toHaveLength(4);
  for (const stem of [...mixed.manifest.state.stems, ...mixed.manifest.state.committed])
    expect(assetBytes(mixed, stem.original)).toEqual(original.buffer);
  expect(errors).toEqual([]);
});
