import type { AudioData } from '@music-sync/shared';

/** Whole-song residual after fitting a shared RMS gain. This measures signal change, not quality. */
export function createFinishingDifferenceMeter() {
  let a2 = 0, b2 = 0, cross = 0;
  return {
    push(a: AudioData, b: AudioData) {
      if (a.sampleRate !== b.sampleRate || a.channels.length !== b.channels.length || a.channels.some((ch,c) => ch.length !== b.channels[c].length))
        throw new Error('仕上がり差の比較形式が一致しません。');
      for (let c=0;c<a.channels.length;c++) for (let i=0;i<a.channels[c].length;i++) {
        const x=a.channels[c][i], y=b.channels[c][i];
        a2+=x*x; b2+=y*y; cross+=x*y;
      }
    },
    finishDb() {
      if (a2 === 0 && b2 === 0) return -150;
      if (!a2 || !b2) return 0;
      return 10*Math.log10(Math.max(1e-15,2-2*cross/Math.sqrt(a2*b2)));
    },
  };
}
