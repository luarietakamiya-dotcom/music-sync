import { expect, it } from 'vitest';
import { prepareStemRestoration, renderStemRestoration, renderFileStems, mixStems, planStemMix,
  type AudioData, type StemDescriptor, type StemRestorationSettings } from '@music-sync/core';

const rate=48000,frames=rate*2+317;
function fixture():AudioData {
  let seed=31,low=0;
  const samples=Float32Array.from({length:frames},(_,n)=>{
    seed=(Math.imul(seed,1664525)+1013904223)>>>0;
    const noise=(seed/2**32-.5)*.16; low+=.28*(noise-low);
    const t=n/rate,envelope=.35+.65*Math.abs(Math.sin(2*Math.PI*3*t));
    return envelope*(.11*Math.sin(2*Math.PI*220*t)+.04*Math.sin(2*Math.PI*3300*t)+.024*Math.sin(2*Math.PI*4400*t)+noise-low);
  });
  return {sampleRate:rate,channels:[samples]};
}
function source(audio:AudioData,size=65536) {
  return {sampleRate:audio.sampleRate,channels:audio.channels.length,frames:audio.channels[0].length,
    async *open(){for(let n=0;n<audio.channels[0].length;n+=size)
      yield {...audio,channels:audio.channels.map(channel=>channel.subarray(n,n+size))};}};
}
function descriptor(id:string,audio:AudioData):StemDescriptor {
  return {id,name:id+'.wav',role:'other',sampleRate:rate,channels:audio.channels.length,frames:audio.channels[0].length,
    gainDb:0,pan:0,muted:false};
}
async function repaired(audio:AudioData,settings:StemRestorationSettings,readSize=65536,blockFrames=65536) {
  const samples=audio.channels.map(channel=>new Float32Array(channel.length));let offset=0;
  const result=await renderStemRestoration(source(audio,readSize),settings,{blockFrames,async write(block){
    block.channels.forEach((channel,c)=>samples[c].set(channel,offset));offset+=block.channels[0].length;
  }});
  expect(offset).toBe(audio.channels[0].length);
  return {...result,samples};
}

it('renders exactly the same accepted grain/treble material that enters the mix, without the other track or mix controls',async()=>{
  const audio=fixture(),saved=audio.channels[0].slice();
  const silence={...audio,channels:[new Float32Array(frames)]};
  for(const [grain,treble] of [['strong','off'],['off','strong'],['strong','strong']] as const){
    const settings:StemRestorationSettings={restore:true,repair:{grain,amount:100,clarityDb:1},treble};
    const preview=await repaired(audio,settings);
    let offset=0;
    const mixed=await renderFileStems([
      {descriptor:descriptor('material',audio),...source(audio)},
      {descriptor:descriptor('silence',silence),...source(silence)},
    ],{mode:'stems',autoBalance:false,blockFrames:65536,studio:{...settings,doubleAmount:0,doubleMs:30},async write(block){
      for(const channel of block.channels) expect(channel).toEqual(preview.samples[0].subarray(offset,offset+channel.length));
      offset+=block.channels[0].length;
    }});
    expect(mixed.report.tracks[0].restoration).toEqual(preview.restoration);
    expect(mixed.report.attenuationDb).toBe(0);
    expect(preview.before.frames).toBe(frames);
    expect(preview.analysis.frames).toBe(frames);
    if(grain==='strong')expect(preview.restoration.grain?.status).toBe('applied');
  }
  expect(audio.channels[0]).toEqual(saved);
});

it('turns repair off for one material while retaining the other material repair and original PCM',async()=>{
  const a=fixture(),b={...a,channels:[Float32Array.from(a.channels[0],value=>value*.5)]};
  const saved=a.channels[0].slice();
  const settings:StemRestorationSettings={restore:true,treble:'off',repair:{grain:'strong',amount:100}};
  const expected=await repaired(b,settings);
  const expectedMix=mixStems([{descriptor:descriptor('disabled',a),audio:a},
    {descriptor:descriptor('enabled',b),audio:{...b,channels:expected.samples}}]);
  let offset=0;
  const result=await renderFileStems([
    {descriptor:{...descriptor('disabled',a),restorationEnabled:false},...source(a)},
    {descriptor:descriptor('enabled',b),...source(b)},
  ],{mode:'stems',autoBalance:false,blockFrames:65536,studio:{...settings,doubleAmount:0,doubleMs:30},async write(block){
    const end=offset+block.channels[0].length;
    expect(block.channels[0]).toEqual(expectedMix.audio.channels[0].subarray(offset,end));offset=end;
  }});
  expect(result.report.tracks[0].restoration).toEqual({enabled:false});
  expect(result.report.tracks[0].descriptor.restorationEnabled).toBe(false);
  expect(result.report.tracks[1].restoration?.grain?.status).toBe('applied');
  expect(a.channels[0]).toEqual(saved);
});

it('replays an accepted sustained high-frequency repair exactly before summing',async()=>{
  let seed=7,previous=0;
  const samples=Float32Array.from({length:rate*3},(_,n)=>{
    seed=(Math.imul(seed,1664525)+1013904223)>>>0;
    const next=seed/2**32-.5,hiss=(next-previous)*.15;previous=next;
    const t=n/rate;
    return .12*Math.sin(2*Math.PI*440*t)+(t>=.65&&t<2.6?hiss:0);
  });
  const audio={sampleRate:rate,channels:[samples]},silence={sampleRate:rate,channels:[new Float32Array(samples.length)]};
  const settings:StemRestorationSettings={restore:true,treble:'auto',repair:{grain:'off',clarityDb:0}};
  const preview=await repaired(audio,settings,371,257);
  expect(preview.restoration.treble?.status).toBe('applied');
  let offset=0;
  await renderFileStems([
    {descriptor:descriptor('hiss',audio),...source(audio,257)},
    {descriptor:descriptor('silent',silence),...source(silence,257)},
  ],{mode:'stems',autoBalance:false,blockFrames:257,studio:{...settings,doubleAmount:0,doubleMs:30},async write(block){
    expect(block.channels[0]).toEqual(preview.samples[0].subarray(offset,offset+block.channels[0].length));
    offset+=block.channels[0].length;
  }});
});

it('replays independently of input/output chunks and snapshots selection during preparation',async()=>{
  const audio=fixture();
  const settings:StemRestorationSettings={restore:true,treble:'strong',repair:{grain:'strong',amount:100,clarityDb:1}};
  const whole=await repaired(audio,settings),chunked=await repaired(audio,settings,1177,257);
  expect(chunked.samples).toEqual(whole.samples);
  expect(chunked.restoration).toEqual(whole.restoration);
  const prepared=await prepareStemRestoration(source(audio),settings);
  settings.repair.grain='off';settings.restore=false;
  const output=new Float32Array(frames);let offset=0;
  for await(const block of prepared.open()){output.set(block.channels[0],offset);offset+=block.channels[0].length;}
  expect(output).toEqual(whole.samples[0]);
  expect(prepared.settings.restore).toBe(true);
});

it('owns written dry chunks, retains source dimensions and records an explicit disabled selection',async()=>{
  const audio=fixture(),saved=audio.channels[0].slice();let written=0;
  const result=await renderStemRestoration(source(audio,997),{restore:false,repair:{}},{blockFrames:257,async write(block){
    written+=block.channels[0].length;block.channels[0].fill(0);
  }});
  expect(written).toBe(frames);expect(result.restoration).toEqual({enabled:false});
  expect(result.analysis).toEqual(result.before);
  expect(audio.channels[0]).toEqual(saved);
});

it('cancels before write and rejects malformed source/configuration without adopting output',async()=>{
  const audio=fixture(),cancel=new AbortController();let written=0;
  await expect(renderStemRestoration(source(audio),{restore:true,repair:{grain:'strong'},treble:'strong'},{
    signal:cancel.signal,progress(fraction){if(fraction>.3)cancel.abort();},async write(){written++;},
  })).rejects.toThrow();expect(written).toBe(0);
  await expect(prepareStemRestoration({...source(audio),frames:frames+1},{restore:false,repair:{}})).rejects.toThrow();
  await expect(prepareStemRestoration(source(audio),{restore:true,repair:{amount:101}})).rejects.toThrow();
  await expect(prepareStemRestoration(source(audio),{restore:true,repair:{},treble:'bad' as never})).rejects.toThrow();
  const tracks=[descriptor('one',audio),descriptor('two',audio)];
  expect(()=>planStemMix([{...tracks[0],restorationEnabled:'false' as never},tracks[1]])).toThrow();
});
