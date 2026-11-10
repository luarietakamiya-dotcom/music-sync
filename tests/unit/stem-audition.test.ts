import { expect, it } from 'vitest';
import { createBlindComparison, mixStems, renderFileStems, type AudioData, type StemDescriptor } from '@music-sync/core';
import { StemAuditionSelector } from '../../packages/core/src/stem-audition';

const rate = 8000;
function tone(length: number) { return Float32Array.from({ length }, (_, i) => 0.12 * Math.sin(2 * Math.PI * 300 * i / rate)); }

it('finds the changed interval including a partial tail across arbitrary chunk boundaries', () => {
  const dry = tone(8 * rate + 800), wet = dry.slice();
  for (let i = 8 * rate; i < wet.length; i++) wet[i] += 0.06 * Math.sin(2 * Math.PI * 700 * i / rate);
  const run = (step: number) => {
    const pick = new StemAuditionSelector(rate, dry.length);
    for (let i = 0; i < dry.length; i += step) {
      const a = dry.subarray(i,i+step), b = wet.subarray(i,i+step);
      pick.push([a,a], [b,b]);
    }
    return pick.finish()!;
  };
  const a = run(501), b = run(65536);
  expect(a.startFrame).toBe(800); expect(a.after.frames).toBe(8 * rate);
  expect(a.studio.channels[0]).toEqual(wet.slice(800));
  expect(b.startFrame).toBe(a.startFrame); expect(b.before.integratedLufs).toBe(a.before.integratedLufs);
  const match = createBlindComparison(a.before,a.after,false);
  expect(a.before.integratedLufs! + match.gainsDb.a).toBeCloseTo(a.after.integratedLufs! + match.gainsDb.b, 8);
});
it('skips silence and differences explained entirely by gain', () => {
  const a = tone(rate), b = a.map(v => v * 0.5), mute = new Float32Array(rate);
  for (const pair of [[a,b],[mute,mute],[a,a]]) {
    const pick = new StemAuditionSelector(rate, rate);
    pick.push([pair[0],pair[0]],[pair[1],pair[1]]); expect(pick.finish()).toBeUndefined();
  }
});
it('uses the committed studio mix and preserves levels, pan and muted tracks in its dry reference', async () => {
  const blockFrames = 257, frames = 2 * rate;
  function track(id: string, role: StemDescriptor['role'], pan: number, muted: boolean) {
    const descriptor: StemDescriptor = { id,name:id,role,pan,muted,frames,channels:1,sampleRate:rate,gainDb:-6 };
    const audio: AudioData = { sampleRate:rate,channels:[tone(frames)] };
    return { descriptor,audio,async *open() {
      for (let i=0;i<frames;i+=blockFrames) yield { sampleRate:rate,channels:[audio.channels[0].subarray(i,i+blockFrames)] };
    } };
  }
  const tracks = [track('guitar','guitar',-0.3,false),track('bass','bass',0,false),track('mute','other',0,true)];
  const dry = mixStems(tracks).audio;
  const written = [new Float32Array(frames),new Float32Array(frames)]; let offset=0;
  const result = await renderFileStems(tracks,{mode:'stems',autoBalance:false,blockFrames,audition:true,
    studio:{restore:false,repair:{},doubleAmount:80,doubleMs:30},async write(block) {
      block.channels.forEach((ch,c)=>written[c].set(ch,offset)); offset+=block.channels[0].length;
    }});
  expect(result.audition?.dry.channels).toEqual(dry.channels);
  expect(result.audition?.studio.channels).toEqual(written);
  expect(result.audition?.after.clippedSamples).toBe(0);
});
