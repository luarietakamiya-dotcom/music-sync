import { expect, it } from 'vitest';
import { humanDouble } from '@music-sync/dsp';
import { analyzeAudio, longMasterGain, FinishRepair, type AudioData } from '@music-sync/core';
import { ReferenceStabilizer } from '../../packages/core/src/reference-stabilizer';
import { planAutoMastering } from '../../packages/core/src/auto/mastering-planner';

function tone(frames: number, rate = 48000): AudioData {
  const ch = Float32Array.from({ length: frames }, (_, i) => 0.1 * Math.sin(i * 2 * Math.PI * 440 / rate));
  return { sampleRate: rate, channels: [ch, ch.slice()] };
}
const controls = { sensitivityDb: 0.4, repairMs: 300, maxDb: 1, percent: 3, toleranceDb: 0.3 };
it('corrects a local mismatch against the aligned reference within the budget and leaves unrelated references alone', () => {
  const rate = 8000, audio = tone(rate * 6, rate), original = audio.channels[0].slice();
  const ref = tone(rate * 6, rate);
  for (const ch of ref.channels) for (let i=16000; i<16800; i++) ch[i] *= 1.15;
  const stable = new ReferenceStabilizer(rate, controls);
  stable.measure(audio, ref); stable.plan(); stable.renderer()(audio);
  expect(stable.explanation).toContain('0.10秒');
  expect(audio.channels[0].subarray(0,16000)).toEqual(original.subarray(0,16000));
  expect(audio.channels[0].subarray(16800)).toEqual(original.subarray(16800));
  expect(audio.channels[0][16310] / original[16310]).toBeCloseTo(Math.min(10 ** (controls.maxDb / 20), 1.15 / 10 ** (controls.toleranceDb / 20)), 5);
  for (const ch of ref.channels) for (let i=0; i<ch.length; i++) ch[i] = Math.sin(i * 0.73);
  const mismatch = new ReferenceStabilizer(rate, controls);
  mismatch.measure(audio, ref); mismatch.plan();
  expect(mismatch.explanation).toContain('一致を確認できず');
});
it('adds a delayed side signal to guitar while keeping the dry mono fold-down', () => {
  const audio = tone(48000), dry = audio.channels[0].slice();
  humanDouble(48000,30,100)(audio);
  let stereo = 0, error = 0;
  for (let i=0; i<dry.length; i++) {
    stereo += Math.abs(audio.channels[0][i] - audio.channels[1][i]);
    error = Math.max(error, Math.abs((audio.channels[0][i] + audio.channels[1][i]) / 2 - dry[i]));
  }
  expect(stereo / dry.length).toBeGreaterThan(0.01);
  expect(error).toBeLessThan(1e-7);
});
it('orders loudness choices for short and long masters and preserves the peak ceiling', () => {
  const a = analyzeAudio(tone(48000));
  const levels = [0,35,100].map(v => planAutoMastering(a,a,'AUTO',1,v).chain.gainDb);
  expect(levels[0]).toBe(0); expect(levels[1]).toBeGreaterThan(0); expect(levels[2]).toBeGreaterThan(levels[1]);
  const gains = [0,35,100].map(v => longMasterGain(a,'AUTO','auto',v).gainDb);
  expect(gains).toEqual(levels);
  expect(longMasterGain({ ...a, truePeakDbtp: -1.1 },'IMPACT','cd',100).gainDb).toBeLessThan(0.1);
});
it('restores sustained mid-high grain with hiss turned off and measures the resulting energy change', () => {
  const pcm = tone(144000).channels[0]; let seed=19;
  for (let i=0; i<pcm.length; i++) {
    seed = (Math.imul(seed,1664525)+1013904223) >>> 0; pcm[i] += (seed / 2**32-0.5) * 0.2;
  }
  const audio = { sampleRate: 48000, channels:[pcm] };
  const restore = new FinishRepair(48000,1,'off',{ grain:'strong',amount:100 });
  restore.analyze(audio); expect(restore.plan()).toBe(true);
  const candidate = { ...audio, channels: [pcm.slice()] };
  restore.renderer()(candidate); restore.measure(candidate); expect(restore.evaluate()).toBe(true);
  expect(restore.report.explanation).toContain('中高域');
  const off = new FinishRepair(48000,1,'off',{ grain:'strong',amount:0 });
  off.analyze(audio); expect(off.plan()).toBe(false);
});
it('independently restores measurable presence when hiss reduction is disabled', () => {
  const pcm = tone(144000).channels[0];
  for (let i=0; i<pcm.length; i++) pcm[i] += 0.008 * Math.sin(2*Math.PI*4750*i/48000);
  const audio = { sampleRate:48000, channels:[pcm] };
  const clarity = new FinishRepair(48000,1,'auto',{hissDb:0,clarityDb:2,autoClarity:false});
  clarity.analyze(audio); expect(clarity.plan()).toBe(true);
  const candidate = { ...audio, channels:[pcm.slice()] };
  clarity.renderer()(candidate); clarity.measure(candidate); expect(clarity.evaluate()).toBe(true);
  expect(clarity.report.clarityUsed).toBe(true);
});
