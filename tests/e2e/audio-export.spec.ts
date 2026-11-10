import {expect,test,type Page} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {tone,wav} from '../helpers/audio';

const cover=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=','base64');
async function reveal(page:Page,selector:string){
  await page.locator(selector).evaluate(element=>{
    for(let parent=element.parentElement;parent;parent=parent.parentElement)if(parent instanceof HTMLDetailsElement)parent.open=true;
  });
}
async function candidate(page:Page){
  await page.goto('/');
  await page.locator('#file-input').setInputFiles({name:'export-original.wav',mimeType:'audio/wav',
    buffer:Buffer.from(wav(tone({sampleRate:16000,seconds:3,amplitude:.08,frequency:440,stereo:true}),32,true))});
  await expect(page.locator('#mode-AUTO')).toBeEnabled();await page.locator('#mode-AUTO').click();
  await expect(page.locator('#finish-explanation')).toContainText('候補を用意しました');
  await reveal(page,'#audio-export-format');
}
function id3Frames(bytes:Buffer){
  expect(bytes.toString('ascii',0,3)).toBe('ID3');expect(bytes[3]).toBe(3);
  const end=10+(bytes[6]<<21)+(bytes[7]<<14)+(bytes[8]<<7)+bytes[9],frames=new Map<string,Buffer>();
  for(let offset=10;offset<end;){
    const id=bytes.toString('ascii',offset,offset+4),length=bytes.readUInt32BE(offset+4);
    expect(offset+10+length).toBeLessThanOrEqual(end);frames.set(id,bytes.subarray(offset+10,offset+10+length));offset+=10+length;
  }return frames;
}

test('selected PCM WAV bit depth is honored with source rate, stereo and duration retained',async({page})=>{
  await candidate(page);const original=await page.locator('#a-lufs').innerText(),processed=await page.locator('#b-lufs').innerText();
  for(const [format,bits] of [['wav-16',16],['wav-24',24]] as const){
    await page.locator('#audio-export-format').selectOption(format);await page.locator('#audio-export-dither').uncheck();
    const downloaded=page.waitForEvent('download');await page.locator('#wav-button').click();const saved=await downloaded;
    expect(saved.suggestedFilename()).toMatch(/\.wav$/i);const bytes=await readFile((await saved.path())!);
    expect(bytes.toString('ascii',0,4)).toBe('RIFF');expect(bytes.readUInt16LE(20)).toBe(1);expect(bytes.readUInt16LE(34)).toBe(bits);
    expect(bytes.readUInt16LE(22)).toBe(2);expect(bytes.readUInt32LE(24)).toBe(16000);expect(bytes.readUInt32LE(40)).toBe(16000*3*2*bits/8);
    expect(bytes.length).toBe(44+16000*3*2*bits/8);await expect(page.locator('#wav-button')).toBeEnabled();
  }
  await expect(page.locator('#a-lufs')).toHaveText(original);await expect(page.locator('#b-lufs')).toHaveText(processed);
});

test('MP3 downloads locally with Japanese metadata, front cover and browser-decodable stereo audio',async({page})=>{
  const errors:string[]=[],external:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  page.on('request',request=>{if(!request.url().startsWith('http://127.0.0.1:4173')&&!request.url().startsWith('blob:'))external.push(request.url());});
  await candidate(page);await page.locator('#audio-export-format').selectOption('mp3');await page.locator('#audio-export-bitrate').selectOption('320');
  for(const [key,value] of Object.entries({title:'日本語の曲🎵',artist:'独立した音楽家',album:'試聴アルバム',albumArtist:'Music Sync',year:'2026',track:'1/2',genre:'Electronic',comment:'ローカルで保存'}))
    await page.locator('#audio-tag-'+key).fill(value);
  await page.locator('#audio-export-artwork').setInputFiles({name:'jacket.png',mimeType:'image/png',buffer:cover});
  await expect(page.locator('#audio-export-cover')).toBeVisible();
  const downloaded=page.waitForEvent('download');await page.locator('#wav-button').click();const saved=await downloaded;
  expect(saved.suggestedFilename()).toMatch(/\.mp3$/i);const bytes=await readFile((await saved.path())!),frames=id3Frames(bytes);
  expect(frames.get('TIT2')?.subarray(3).toString('utf16le')).toBe('日本語の曲🎵');
  expect(frames.get('TPE1')?.subarray(3).toString('utf16le')).toBe('独立した音楽家');
  expect(frames.get('TALB')?.subarray(3).toString('utf16le')).toBe('試聴アルバム');
  expect(frames.get('APIC')?.subarray(13)).toEqual(cover);expect(frames.get('APIC')?.[11]).toBe(3);
  const decoded=await page.evaluate(async values=>{
    const context=new AudioContext();
    try{
      const audio=await context.decodeAudioData(new Uint8Array(values).buffer),samples=audio.getChannelData(0);
      let power=0;for(const value of samples)power+=value*value;
      return {channels:audio.numberOfChannels,duration:audio.duration,rms:Math.sqrt(power/samples.length)};
    }finally{await context.close();}
  },Array.from(bytes));
  expect(decoded.channels).toBe(2);expect(decoded.duration).toBeGreaterThanOrEqual(3);expect(decoded.duration).toBeLessThan(3.2);expect(decoded.rms).toBeGreaterThan(.001);
  await expect(page.locator('#audio-export-status')).toContainText('320 kbps');expect(errors).toEqual([]);expect(external).toEqual([]);
});

test('an oversized image header retains the previous jacket and does not leave export stuck pending',async({page})=>{
  await candidate(page);await page.locator('#audio-export-format').selectOption('mp3');
  await page.locator('#audio-export-artwork').setInputFiles({name:'good.png',mimeType:'image/png',buffer:cover});
  await expect(page.locator('#audio-export-cover')).toBeVisible();const previous=await page.locator('#audio-export-cover').getAttribute('src');
  const huge=Buffer.from(cover);huge.writeUInt32BE(20000,16);
  await page.locator('#audio-export-artwork').setInputFiles({name:'too-large.png',mimeType:'image/png',buffer:huge});
  await expect(page.locator('#error')).toContainText('ピクセル');await expect(page.locator('#audio-export-cover')).toHaveAttribute('src',previous!);
  const downloaded=page.waitForEvent('download');await page.locator('#wav-button').click();const bytes=await readFile((await (await downloaded).path())!);
  expect(id3Frames(bytes).get('APIC')?.subarray(13)).toEqual(cover);await expect(page.locator('#wav-button')).toBeEnabled();
});

test('cancelling MP3 encoder loading never downloads or changes accepted A and B',async({page})=>{
  await candidate(page);await page.locator('#audio-export-format').selectOption('mp3');
  const a=await page.locator('#a-lufs').innerText(),b=await page.locator('#b-lufs').innerText(),downloads:string[]=[];
  page.on('download',download=>downloads.push(download.suggestedFilename()));
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
  await page.route('**/vendor/lamejs/lamejs.js',async route=>{await gate;await route.continue();});
  try{
    await page.locator('#wav-button').click();await expect(page.locator('#processing-overlay')).toBeVisible();
    await page.locator('#cancel-button').click();release();await expect(page.locator('#processing-overlay')).toBeHidden();
    await expect(page.locator('#wav-button')).toBeEnabled();await expect(page.locator('#a-lufs')).toHaveText(a);await expect(page.locator('#b-lufs')).toHaveText(b);
    expect(downloads).toEqual([]);
  }finally{release();}
});
