import {expect,it} from 'vitest';
import {encodeId3,validateAudioMetadata,validateAudioArtwork,MAX_ARTWORK_BYTES} from '../../apps/web/src/id3';
const cover=new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=','base64'));
function parse(data:Uint8Array){
  const view=new DataView(data.buffer,data.byteOffset,data.byteLength),frames=new Map<string,Uint8Array>();
  const length=(data[6]<<21)|(data[7]<<14)|(data[8]<<7)|data[9];
  expect(length+10).toBe(data.length);
  for(let offset=10;offset<data.length;){
    const id=new TextDecoder().decode(data.subarray(offset,offset+4)),size=view.getUint32(offset+4,false);
    frames.set(id,data.slice(offset+10,offset+10+size));offset+=10+size;
  }return frames;
}
it('writes standard ID3v2.3 Japanese and emoji text with whole-source duration and correct frame lengths',()=>{
  const tag=encodeId3({title:'日本語の曲🎵',artist:'独立した音楽家',album:'アルバム',albumArtist:'作者',year:'2026',track:'2/10',genre:'Electronic',comment:'1行目\n2行目'},undefined,123456);
  expect(Array.from(tag.subarray(0,6))).toEqual([73,68,51,3,0,0]);
  expect(Array.from(tag.subarray(6,10)).every(n=>n<128)).toBe(true);
  const frames=parse(tag),title=frames.get('TIT2')!;
  expect(title[0]).toBe(1);expect(Array.from(title.subarray(1,3))).toEqual([255,254]);
  expect(new TextDecoder('utf-16le').decode(title.subarray(3))).toBe('日本語の曲🎵');
  expect(new TextDecoder().decode(frames.get('TLEN')!.subarray(1))).toBe('123456');
  expect(frames.has('TPE1')&&frames.has('TALB')&&frames.has('TPE2')&&frames.has('TRCK')&&frames.has('TYER')&&frames.has('COMM')).toBe(true);
});
it('embeds a front-cover PNG without changing caller bytes',()=>{
  const saved=cover.slice(),tag=encodeId3({}, {mimeType:'image/png',data:cover}),apic=parse(tag).get('APIC')!;
  expect(apic[0]).toBe(0);expect(new TextDecoder().decode(apic.subarray(1,10))).toBe('image/png');
  expect(Array.from(apic.subarray(10,13))).toEqual([0,3,0]);expect(apic.subarray(13)).toEqual(saved);
  expect(cover).toEqual(saved);
});
it('rejects unsupported, misleading and oversized cover data before metadata is written',()=>{
  expect(()=>validateAudioArtwork({mimeType:'image/jpeg',data:cover})).toThrow();
  expect(()=>validateAudioArtwork({mimeType:'image/png',data:new Uint8Array(MAX_ARTWORK_BYTES+1)})).toThrow();
  expect(()=>validateAudioArtwork({mimeType:'image/svg+xml' as never,data:cover})).toThrow();
  expect(()=>validateAudioArtwork({mimeType:'image/png',data:new Uint8Array(4)})).toThrow();
  const copy=validateAudioArtwork({mimeType:'image/png',data:cover})!;copy.data[0]=0;expect(cover[0]).toBe(137);
});
it('validates metadata boundaries and does not silently accept invalid text or track ordering',()=>{
  for(const data of [{title:'x'.repeat(1001)},{artist:'bad\0name'},{title:'\ud800'},{year:'0000'},{year:'26'},{track:'0'},{track:'12/10'},{track:'-1'}])
    expect(()=>validateAudioMetadata(data)).toThrow();
  expect(validateAudioMetadata({title:'  name  ',track:'1/12'}).title).toBe('name');
  expect(()=>encodeId3({},undefined,NaN)).toThrow();
  expect(()=>encodeId3({},undefined,1200001)).toThrow();
});
