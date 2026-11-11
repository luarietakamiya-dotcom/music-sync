import assert from 'node:assert/strict';
import {planSeparation, renderSeparation, SEPARATION_LIMITS} from '@music-sync/core';

// Deterministic orchestration example ONLY: these proportional copies do not
// isolate instruments or simulate a neural model. No recordings/models/network.
const sampleRate=8000,frames=sampleRate*5+17;
const sample=(channel,frame)=>.12*Math.sin(2*Math.PI*(channel?331:223)*frame/sampleRate)
  +.03*Math.sin(2*Math.PI*719*frame/sampleRate);
const targets=['demo-a','demo-b'],fractions={'demo-a':.25,'demo-b':.75};
const plan=planSeparation({sampleRate,channels:2,frames},{
  id:'deterministic-callback-example',kind:'music',targets,segmentSeconds:2,overlap:.25,
});
const written=Object.fromEntries(targets.map(target=>[target,0]));
let largestRead=0,largestWrite=0,maximumError=0;
const summary=await renderSeparation(plan,{
  signal:AbortSignal.timeout(10000),
  async read(start,count){
    largestRead=Math.max(largestRead,count);
    return {sampleRate,channels:[0,1].map(channel=>
      Float32Array.from({length:count},(_,frame)=>sample(channel,start+frame)))};
  },
  async infer(audio){
    // A real host invokes its own inference provider here. Core supplies owned,
    // padded stereo scratch PCM and expects the same rate/window length back.
    return Object.fromEntries(targets.map(target=>[target,{
      sampleRate:audio.sampleRate,
      channels:audio.channels.map(channel=>Float32Array.from(channel,value=>value*fractions[target])),
    }]));
  },
  async write(target,audio){
    // A file host appends this chunk to a TEMPORARY output before resolving.
    // Adopt outputs only when renderSeparation succeeds; discard them on error.
    const count=audio.channels[0].length,start=written[target];
    largestWrite=Math.max(largestWrite,count);
    for(let channel=0;channel<2;channel++)for(let frame=0;frame<count;frame++)
      maximumError=Math.max(maximumError,Math.abs(audio.channels[channel][frame]-sample(channel,start+frame)*fractions[target]));
    written[target]+=count;
  },
});
assert.equal(summary.frames,frames);
assert.equal(summary.segments,plan.starts.length);
assert.ok(largestRead<=plan.segmentFrames&&largestWrite<=plan.segmentFrames);
assert.ok(targets.every(target=>written[target]===frames));
assert.ok(maximumError<1e-7);
assert.equal(plan.outputBytes,frames*2*4*targets.length);
assert.equal(SEPARATION_LIMITS.maxTargets,16);
console.log('Deterministic Core callback example passed (no neural inference).',{
  frames:summary.frames,segments:summary.segments,largestRead,largestWrite,maximumError,
});
