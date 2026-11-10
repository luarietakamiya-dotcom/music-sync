# 現行構成の調査 — impact.67

調査日: 2026-09-22。対象: `Music_Sync_v2.0.0-alpha.16.5-impact.67_Freeze_Guard_Windows_Portable.zip`
および、以前の作業フォルダ `music_sync_review/Music_Sync_v2.0.0-alpha.16.5_Performance_Fast_Path`。
後者のフォルダ名は古いが、`app.py:62` の `APP_VERSION` とセッション保存バージョンは impact.67。
`.git` は存在せず、Git remote / commit履歴の監査は実施できなかった。

## 1. 現在のアーキテクチャ

- `launcher.py` → `app.MusicSyncV2App`。Tkinter/TkinterDnD/PillowによるUI。
  `app.py` 約302 KBにUIイベント、解析/処理の呼出し、入出力操作が集約されている。
- `native_core/stem_session.py`: STEMとロール、マスキング、バス処理、候補選択、
  セクション処理、ThreadPoolExecutor、キャッシュ、セッション保存の統括。
- `analysis.py`: Welchスペクトル、帯域レベル、Mid/Side、相関、区間解析。
- `dsp.py`: NumPy/SciPyによるEQ、包絡、ラウドネス、リサンプリング、リミッター。
- `dynamic_sculpt`, `punch_designer`, `harmonic_color`, `stereo_stage`, `air_polish`,
  `final_guard`, `artifact_repair`, `high_end_repair`, `drum_tail_repair`,
  `stability_guard`, `live_venue`, `retro_audio`: 音響処理群。
- `module.py`, `parameters.py`, `intent.py`: 処理モジュール、パラメータ、意図のモデル。
  `commander`, `configuration_search`, `section_commander`, `quality`: 自動候補判断。
- `audio_preview.py` + `review_player_ui.py`: sounddeviceによる再生、試聴・レビュー。
- `io.py`: soundfile入出力、SciPy resample_poly、メタデータ、書出し名整形。
- `product_features`, `write_guard`, `runtime_support`: ユーザーデータ、保存範囲、
  診断ログ、Windows署名確認。`report`, `validation_lab`: レポート・検証。
- `MusicSync.spec` / `pyinstaller_hooks` / vendor Tk: ネイティブ配布。
  元ディレクトリに49個のPythonテストファイルが存在。

98個の関連ファイルを構文解析/一覧化し、imports・クラス・関数・SHA-256を
[`legacy-source-manifest.json`](legacy-source-manifest.json) に記録。
これは静的監査であり、全機能の動作試験やセキュリティ認証ではない。
今回、旧デスクトップ版の起動・全49テストの再実行はしていない。

## ソースと配布物の対応

配布ZIP SHA-256:
`cab57e43e6d638297dd40c6c3840b9c4af39881b7def3f2b2381207a59b4b7a9`

ZIP内 `MusicSync.exe` SHA-256:
`022e175c2f3fb7b29ae91ac0ada02d70e797b71b32dc5847fceb877266dc5c80`

ソースフォルダ内 `dist_impact67/MusicSync/MusicSync.exe` と一致した。
これは同一ビルド成果物の確認であり、ソースからの再現ビルド証明ではない。
既存ファイルは移動/編集しない。新Web側との数値同等性も現時点では主張しない。

## 2. Webへ移植しやすい部分

パラメータの範囲/状態、モジュールID、解析結果、候補評価結果は共通契約へ移せる。
PCM演算、帯域/相関/包絡/クレスト等は純粋関数として移植可能。
ただしNumPy/SciPyのPython実装はJSへそのままimportできない。
画面、デコード、再生、保存はブラウザアダプターに置き換える。
Webではモノ音源を勝手に二重化せず、多チャンネルを黙って切り捨てない。

## 3. WASM化すべき候補

FFT、リサンプリング、オーバーサンプリング、長い畳み込み、非線形DSPを候補とする。
候補探索全体ではなく測定で律速と分かった数値カーネルからC/C++/Rust等へ切り出す。
最初からPythonランタイム全体をWASMに搭載しない。
Phase 1はTypeScript＋Workerの参照実装。WASM導入時も同じPCM/Report契約と
ゴールデンテストを通す。バイナリの元ソース、ビルド手順、ライセンスを同梱する。

## 4. Desktop専用として残す部分

Tk UI、sounddevice/PortAudio、OSファイル書込み、署名検査、PyInstaller、
OSデバイス選択、ネイティブプラグインホスト。
確認した現行 `native_core` 内にVST3/pedalboardのホストは見つからなかった。
過去バージョンに存在する可能性と、現在の実装が確認できたことは区別する。
VST3が必要になった場合はDesktop専用の別プロセス/アダプターで実装する。

## 5. Coreとして分離すべき部分

Planar Float32 PCM、解析仕様/結果、処理パラメータ、チェーン構成、品質判定、
候補選択/ロールバックをUI非依存にする。ファイルパスやAudioContextはCoreへ渡さない。
Phase 1はPCM→解析だけを切り出した新しい公開ファサード。
既存PythonクラスをTSに置換したという意味ではない。
後続の接続は、版付きのJSON設定とPCM境界で行い、同一テスト素材を両実装に流す。

測定上の重要事項: 既存 `dsp.measure_lufs` はpyloudnormが利用できない/測定失敗時に
RMSを返す。Webは代用せず `null` と理由を返す。
既存True PeakはSciPyの4倍resample_poly、Webは4倍窓付きsinc近似であり
一致保証はない。規格適合を主張する前に正式な検証素材を追加する。

## 6. 依存関係・ライセンス

既存requirementsは下限指定のみで固定ロックなし:
numpy, scipy, soundfile, pyloudnorm, sounddevice, tkinterdnd2, Pillow。
旧アプリ全体の明確なLICENSEをルートで確認できなかった。
libsndfile、PortAudio/ASIO、Tk/TkDND、PyInstaller配布物、画像・効果音は
個別の再配布条件と来歴確認が必要。[詳細](licenses.md)。

## 7. セキュリティ上の注意

デスクトップのセッションファイルに絶対パスが含まれる可能性、JSON設定の型/範囲検証、
保存先制限、診断ログの個人情報、OSコマンド呼出し、ネイティブDLL読み込みを監査対象にする。
署名確認は `subprocess` とPowerShellを利用。Web側へは移さない。
Webはファイル/チャンネル/展開PCM量を制限し、NaN/Infinityを拒否。
ファイル名をHTMLとして解釈せず、Workerと世代IDで中止済み結果を破棄する。
FLACのネイティブデコード自体は中断できず、ヘッダー検査だけで悪意あるデータの
一時的メモリ消費を完全には防げない。詳細は [SECURITY](../SECURITY.md)。
