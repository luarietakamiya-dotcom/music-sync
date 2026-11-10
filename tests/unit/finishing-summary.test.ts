import { expect, it } from 'vitest';
import { describeFinishingChange } from '../../apps/web/src/finishing-summary';
import { createFinishingDifferenceMeter, type AudioData, type TrebleRepairReport } from '@music-sync/core';

it('reports a tiny actual repair rather than suggesting the entire song was corrected', () => {
  const report: TrebleRepairReport = {mode:'strong',status:'applied',seconds:0.2,highReductionDb:1,clarityUsed:false,explanation:''};
  const text=describeFinishingChange(262.8,report,false);
  expect(text).toContain('0.2秒'); expect(text).toContain('0.1%未満'); expect(text).toContain('音量一致');
  expect(describeFinishingChange(262.8,undefined,false)).toContain('主に全体の音量');
  expect(describeFinishingChange(262.8,undefined,true)).toContain('厚み・輪郭');
});
it('does not mistake uniform gain for tone processing, even over irregular chunks', () => {
  const a:AudioData={sampleRate:8000,channels:[Float32Array.from({length:8000},(_,i)=>0.1*Math.sin(i/3))]};
  const b={...a,channels:[a.channels[0].map(v=>v*1.6)]};
  const gainOnly=createFinishingDifferenceMeter(), changed=createFinishingDifferenceMeter();
  for(let offset=0;offset<8000;offset+=311) {
    const dry={...a,channels:[a.channels[0].subarray(offset,offset+311)]};
    const wet={...a,channels:[b.channels[0].subarray(offset,offset+311)]};
    gainOnly.push(dry,wet);
    changed.push(dry,{...wet,channels:[wet.channels[0].map((v,i)=>v+0.02*Math.sin((offset+i)/7))]});
  }
  expect(gainOnly.finishDb()).toBeLessThan(-100);
  expect(changed.finishDb()).toBeGreaterThan(-30);
});
