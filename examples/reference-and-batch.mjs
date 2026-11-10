import assert from 'node:assert/strict';
import {analyzeAudio,analyzeReference,autoMixMaster,planBatchLoudness} from '@music-sync/core';

// Original synthetic arrangements: no recordings, services or user files required.
function arrangement(bass=1,level=1){
  const sampleRate=24000,frames=sampleRate*4,channels=[new Float32Array(frames),new Float32Array(frames)];
  const frequencies=[40,110,280,650,1600,3300,7000,11000],weights=[.06,.18,.14,.17,.18,.13,.10,.04];
  for(let n=0;n<frames;n++){
    const time=n/sampleRate,envelope=.7+.1*Math.sin(2*Math.PI*time*.7);let mid=0,side=0;
    for(let band=0;band<frequencies.length;band++){
      const amount=Math.sqrt(weights[band])*.13*(band<2?bass:1);
      mid+=amount*Math.sin(2*Math.PI*frequencies[band]*time+band*.47);
      side+=amount*Math.sin(2*Math.PI*(frequencies[band]+7)*time+band*.73);
    }
    channels[0][n]=level*envelope*(mid+side*.15);channels[1][n]=level*envelope*(mid-side*.15);
  }return {sampleRate,channels};
}

const reference=analyzeReference(arrangement());
const songs=[{id:'song-1',audio:arrangement(1.8)},{id:'song-2',audio:arrangement(1.2,.7)}];
const candidates=songs.map(song=>{
  const original=song.audio.channels.map(channel=>channel.slice());
  const finished=autoMixMaster(song.audio,'AUTO',{reference:{profile:reference,strength:.65}});
  assert.equal(finished.status,'accepted',finished.reasons.join(' '));
  assert.ok(finished.processed);assert.deepEqual(song.audio.channels,original,'Original must remain unchanged');
  return {id:song.id,audio:finished.processed.audio,analysis:analyzeAudio(finished.processed.audio),referenceStatus:finished.reference.status};
});

// This stage changes song-wide gain only. It cannot force every song to -16 LUFS.
const plan=planBatchLoudness(candidates.map(song=>({id:song.id,analysis:song.analysis})),{targetLufs:-16});
const measurements=plan.tracks.map(track=>{
  assert.equal(track.status,'ready',track.reason);const candidate=candidates.find(song=>song.id===track.id),gain=10**(track.gainDb/20);
  const leveled={sampleRate:candidate.audio.sampleRate,channels:candidate.audio.channels.map(channel=>Float32Array.from(channel,value=>value*gain))};
  const after=analyzeAudio(leveled);
  assert.equal(after.clippedSamples,0);assert.ok(after.truePeakDbtp<=plan.ceilingDb+.0001);
  assert.ok(Math.abs(after.integratedLufs-track.expectedLufs)<.05);
  return {id:track.id,referenceStatus:candidate.referenceStatus,beforeAlbumLufs:candidate.analysis.integratedLufs,
    gainDb:track.gainDb,measuredAlbumLufs:after.integratedLufs,truePeakDbtp:after.truePeakDbtp};
});
console.log(JSON.stringify({requestedTargetLufs:plan.requestedTargetLufs,commonTargetLufs:plan.commonTargetLufs,measurements,notes:plan.notes},null,2));
