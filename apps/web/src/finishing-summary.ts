import type { GrainRestorationReport, TrebleRepairReport } from '@music-sync/core';

/** Explain what was actually rendered; loudness matching cancels a constant gain change. */
export function describeFinishingChange(seconds: number, repair: TrebleRepairReport | undefined, toneApplied: boolean, grain?: GrainRestorationReport) {
  if (grain?.inheritedTracks) return grain.explanation + ' 補修済みの素材を活かして仕上げています。';
  if (grain?.status === 'applied') return 'ジャリつきのスペクトル補修を' + grain.seconds.toFixed(1) + '秒に適用しました。音程の芯と立ち上がりを保護しながら、その周囲の細かい成分を抑えた候補です。音量をそろえて確認できます。';
  if (repair?.status === 'applied' && repair.seconds > 0) {
    const percent = repair.seconds / seconds * 100;
    const coverage = percent < 0.1 ? '曲全体の0.1%未満' : '曲全体の' + percent.toFixed(1) + '%';
    return 'ノイズ補修は' + repair.seconds.toFixed(1) + '秒（' + coverage + '）に適用しました。' +
      (percent < 1 && !toneApplied ? '今回は主に音量の調整なので、音量一致では違いが小さくなります。' : '');
  }
  return toneApplied ? '選んだ音の厚み・輪郭・広がりを調整しました。音量をそろえて聴き比べられます。' :
    '今回は主に全体の音量を調整しました。音量一致で聴くと差はほとんどありません。音の印象を変えるには、下の存在感・低音・明瞭さなどを選んで仕上げてください。';
}
