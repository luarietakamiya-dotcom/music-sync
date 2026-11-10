# Music Sync Web Phase 7 実装報告

Version 0.7.0 / 2026-09-29。AUTO / IMPACT / LIVEを押して候補を生成し、
ラウドネスマッチしたOriginal / Processedを比較する流れを維持しています。
原音PCMは変更せず、キャンセル・Undo・Exportまで保持します。

## 1. 変更ファイル

[全変更一覧](phase7-changes.md)参照。解析・DSP・Core・Web表示・公開APIテスト・
fixture・ドキュメント・協調バージョンmetadataを更新しました。
既存Windows版のソース98ファイルはハッシュ照合で変更なしを確認しています。

## 2. 新規モジュール

- `audio-analysis/src/perceptual.ts`: チャンク対応の時間・周波数・Mid/Side解析。
- `dsp/src/band-dynamics.ts`: Dynamic EQと3band Dynamics。
- `core/src/auto/perceptual-decisions.ts`: 根拠・確信度・問題の強さを伴う検出／処理判断。
- `core/src/auto/objective-quality.ts`: 処理目的とBefore/Afterを対応させる評価。
- `core/src/blind-comparison.ts`: Loudness Match必須のX/Y表示準備API。

UIからDSPを直接呼ばず、既存Worker → Core → DSPの責務分離を維持しています。

## 3. Perceptual Features

Sub / Low / Low-Mid / Mid / Upper-Mid / Presence / High / Airの平均エネルギー、
p50/p90、過多区間率、RMS、帯域内の強弱幅を集計します。Centroid、Rolloff、Flux、
Crest、Attack、Onset、Mid/Side、低域Side、Correlation、減衰傾向を組み合わせます。

濁り、箱鳴り、刺さり、明るさ／暗さ、Presence、ボーカル帯域の混雑傾向、
Transient Density／Punch／Consistency、Dynamic Density、Stereo幅／不安定さ、
Center／Side優勢、Ambience／Dry傾向、Masking傾向などをvalue＋confidenceで返します。
これらは音源分離・ボーカル認識・残響の意味理解ではなく、実験的な特徴量です。

## 4. Problem Detection

各問題にseverity・confidence・evidence・temporal・bandを記録。
confidence ≥0.55、severity ≥0.28、両者の積 ≥0.18を満たした問題だけを処理候補にします。
最大3補正、重複帯域の抑制、合計3 dBの量予算、0.25 dB未満の変更の見送りを設けました。
一部だけの過多はp90−p50と区間率を併用し、持続的な偏りと区別します。

## 5. Dynamic EQ

Stereo-linked RMS Sidechainによる、特定帯域の減衰のみを加える並列処理です。
1〜3band対応。Thresholdは解析した帯域RMSから生成し、Attack/Releaseは通常8/120 ms。
計画上の最大減衰1.8 dB、DSPの上限2 dB。Threshold以下では原音の寄与を維持します。
主に一部の区間だけの刺さり・膨らみを対象とします。

## 6. Multiband

180 Hz / 最大3500 Hzの3band。補完的な一次分割でunity時は原音へ戻ります。
LowまたはHighだけ必要時に制御し、他bandの減衰は0。
通常Attack/Release 15/120 ms、計画最大1.2 dB、DSP上限1.5 dB。
全帯域が正常なら使用しません。急峻なスタジオ用クロスオーバーではなく基礎実装です。

## 7. Quality Gate

従来のLUFS・推定TP・RMS・Crest・相関・Side・Clipping・DCの基準を維持。
さらに特徴量の有限値、濁り／刺さり／明るさ／暗さ／Masking／不安定さの悪化、
低域Side増加、Presence後退を確認します。

各補正のtargetIssueに対し、目的の特徴量・帯域p90・帯域変動幅などが改善したかを評価。
改善量がmax(0.001, 元指標の0.5%)を超えなければ成功扱いにしません。
最大3回の範囲で弱めて再試行し、効果が確認できない帯域補正は除去します。
安全基準を満たせなければ候補を不採用にします。

## 8. モードの判断

| Mode | Phase 7の判断 |
| --- | --- |
| AUTO | 確かな問題だけ補正。正常・軽微・不確かな音源では追加DSPを抑制 |
| IMPACT | Punch／Dynamic Densityを確認。既に強いAttackや潰れた素材への強調を見送る |
| LIVE | Dry / Moderate / Wetに応じ追加量を調整。Wet推定では会場感を大幅に減らす |

自動的にStereo幅を広げず、低域SideとMono互換性を優先します。
通常画面は簡単な説明、AdvancedはDetected Issues / Processing Decisions /
Skipped Processing / Quality Evaluationと全試行JSONを確認できます。

## 9. 追加テスト

25 unitケースと2 browserケースを追加。8band、逆相、チャンク境界、音量不変性、
問題検出、confidence、Dynamic EQ、Multiband、処理抑制、目的評価、原音保護、
iteration・cancel・determinism、Blind比較のマッチ必須を検証しています。
13種類の著作権に依存しない生成fixtureと期待判定も用意しました。
fixtureは実楽曲の聴感評価の代用ではありません。

## 10. 必須検証

| Check | Result |
| --- | --- |
| lint / typecheck | 成功 |
| unit/reference test | 95件成功（既存70件を含む） |
| Chromium browser test | 23件成功（既存21件を含む） |
| build / Node examples | 成功 |
| 外部Core導入・Node・TypeScript・Bundler | 成功 |
| Chromium / WebKit SDK | 成功 |

[検証記録](validation.md)と[生成fixtureの評価証拠](evaluation/phase7-fixtures.json)参照。

## 11. Performance / Memory

3分・44.1 kHz stereo、60.56 MiB PCMの合成素材でLIVEは約18.36秒、1試行。
NodeプロセスRSSは処理前104.57 MiB／処理後231.83 MiB。
これは瞬間値で、ピークRAMやブラウザでの計測ではありません。
以前のPhase 6測定17.34秒とは別実行のため、厳密な性能比較には使えません。

追加解析の数値配列は1 analyzer当たり256 KiB未満の固定FFT／Histogramバッファ。
曲全体のスペクトル履歴を保持せず、TypedArrayを再利用します。
96 MiB入力制限は維持。DSP全体のストリーミング化はまだ行っていません。

## 12. 残課題

実楽曲による聴感確認とconfidenceの校正、残響と持続音の区別、稀な短い異常の検出、
高sample rateでの低域解像度、急峻な帯域分割の比較、低RAM端末での実測が残ります。
メーター完全適合、Firefox／実Safari、公開CI／ホスティングは未確認です。
Blind比較はAPI準備までで、完成UIは未実装。Stem／意味理解／品質保証も対象外です。

## 13. Phase 8候補

1. 許諾済みの多様な実楽曲＋Loudness Matched Blind評価による判定校正。
2. 時間帯域の局所検出とDynamic EQの誤検出削減。
3. 残響・持続音の不確かさを扱うAmbience推定の改善。
4. Candidate DSPのチャンク処理／メモリ実測と長時間曲対応。
5. Blind比較UIと評価履歴。MusicSyncは音声処理・音響解析に集中します。

詳細アルゴリズム・安全範囲・API例は[Perceptual Intelligence](perceptual-intelligence.md)参照。
