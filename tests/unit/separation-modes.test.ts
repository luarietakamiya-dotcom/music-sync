import {describe,expect,it} from 'vitest';
import {planSeparation} from '@music-sync/core';
import {INSTRUMENT_MODEL,DRUM_MODEL,SCNET_MODEL,SEPARATION_TRACKS,DIRECT_SEPARATION_MODES,isDirectSeparationMode,separationModel,separationTargets} from '../../apps/web/src/separation-protocol';

describe('optional instrument and chorus separation contracts',()=>{
  it('selects six learned full-mix estimates plus one remainder, without coarse vocal/Other parents',()=>{
    const targets=separationTargets('instruments');
    expect(targets).toEqual(['lead-vocal','back-vocal','piano','guitar','bass','drums','remaining-other']);
    expect(targets).not.toContain('vocals');expect(targets).not.toContain('other');
    expect(new Set(targets).size).toBe(targets.length);
    const model=separationModel('instruments');
    expect(model).toBe(INSTRUMENT_MODEL);expect(model.mixtureMasks).toBe(true);
    expect(model.residualTarget).toBe('remaining-other');
    const plan=planSeparation({sampleRate:44100,channels:2,frames:44100*4},{id:model.id,kind:'music',targets,segmentSeconds:model.segmentSeconds,overlap:model.overlap});
    expect(plan.starts).toHaveLength(2);expect(plan.outputChannels).toBe(2);
    expect(plan.outputBytes).toBe(44100*4*8*7);expect(plan.targets).toEqual(targets);
  });

  it('assigns distinct lead/backing roles instead of guessing from the Original filename',()=>{
    expect(SEPARATION_TRACKS['lead-vocal']).toMatchObject({role:'vocal',vocalRole:'lead'});
    expect(SEPARATION_TRACKS['back-vocal']).toMatchObject({role:'vocal',vocalRole:'backing'});
    expect(SEPARATION_TRACKS.piano.role).toBe('keys');expect(SEPARATION_TRACKS.guitar.role).toBe('guitar');
    for(const id of ['piano','guitar','bass','drums','remaining-other'])expect(SEPARATION_TRACKS[id].vocalRole).toBeUndefined();
  });

  it('keeps the old direct model contracts and rejects composite or unknown direct requests',()=>{
    expect(separationModel('four')).toBe(SCNET_MODEL);expect(separationModel('two')).toBe(SCNET_MODEL);
    expect(separationModel('drums')).toBe(DRUM_MODEL);
    expect(separationTargets('four')).toEqual(['vocals','drums','bass','other']);
    expect(separationTargets('two')).toEqual(['vocals','instrumental']);
    expect(separationTargets('drums')).toEqual(['kick','snare','hh','toms','percussion','remaining-drums']);
    for(const mode of DIRECT_SEPARATION_MODES)expect(isDirectSeparationMode(mode)).toBe(true);
    for(const mode of [null,undefined,'detailed','warm','__proto__',{},1])expect(isDirectSeparationMode(mode)).toBe(false);
  });
});
