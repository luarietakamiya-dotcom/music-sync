import './style.css';
import { bindReferenceWorkspace } from './reference-workspace';
import { bindBatchWorkspace, type BatchPreview } from './batch-workspace';
import type { ReferenceProfile } from '@music-sync/core';
import { bindNotificationSounds } from './notification-sounds';
import { bindExportSettings } from './export-settings';
import audioExportWorkerUrl from './audio-export.worker.ts?worker&url';
import projectWorkerUrl from './project.worker.ts?worker&url';
import { captureProjectSession, restoreProjectSession, type SessionCaptureInput, type SessionInspectionInput } from './project-session';
import type { ProjectManifest } from './project-archive';
import type { AudioExportResult } from './audio-export';
import { type RepairControls, type StemStudioSettings, type TrebleMode, LIMITS, AUTO_ENGINE_LIMITS, SOUND_COLOR_PRESETS, SOUND_COLOR_INTENSITIES, LIVE_SPACES, createComparisonPlan, singleSourceGainDb, validateProcessingChain, planMastering, type LiveSelection, type SoundColorSelection, type SoundColorResult, type AutoMode, type AutoFinishResult, type MasteringOptions, type ProcessingChain, type AudioData, type AnalysisResult, type ComparisonSlot, type ComparisonPlan } from '@music-sync/core';
import { drawWaveform, formatMetric } from '@music-sync/ui';
import { decodeFlac } from './decode';
import { CandidateFile } from './candidate-file';
import { needsFileMix, longStemInputBytes } from './file-stems';
import { LONG_WAV_LIMITS, readWavFileMetadata } from './wav-stream';
import { prepareStemRepairPreview } from './stem-repair-preview';
import { bindStemSolo } from './stem-solo';
import { bindListeningTest } from './stem-audition';
import { describeFinishingChange } from './finishing-summary';
import { ComparisonPlayer } from './comparison-player';
import { openAudioWorker } from './worker-client';
import analysisWorkerUrl from './analysis.worker.ts?worker&url';
import processingWorkerUrl from './processing.worker.ts?worker&url';
import { STEM_LIMITS, STEM_ROLES, suggestStemRole, suggestStemVocalRole, anonymizeFinishingReport, type StemMode, type StemMixReport } from '@music-sync/core';
import type { StemFileEntry } from './stem-worker';
import { DEFAULT_FINISH_CONTROLS, FINISH_CONTROL_LABELS, OUTPUT_PROFILES, type FinishingPreferences, type FinishControls, type OutputProfileId } from '@music-sync/core';

function element<T extends HTMLElement>(id: string): T {
  const result = document.getElementById(id);
  if (!result) throw new Error(`Missing element: ${id}`);
  return result as T;
}
type Source = { originalFile?: File; result: AnalysisResult; name: string; stemMix?: StemMixReport; processing?: { chain: ProcessingChain; maxReductionDb: number; peakGuardDb: number } } &
  ({ audio: AudioData; file?: never } | { audio?: never; file: File });
const sources: Partial<Record<ComparisonSlot, Source>> = {};
const sounds = bindNotificationSounds();
const exportSettings = bindExportSettings(showError, () => {});
let sessionAbort: AbortController | undefined;
let externalJobCancel:(()=>void)|undefined;
const input = element<HTMLInputElement>('file-input');
const inputB = element<HTMLInputElement>('file-input-b');
const canvas = element<HTMLCanvasElement>('waveform');
const playButton = element<HTMLButtonElement>('play-button');
const stopButton = element<HTMLButtonElement>('stop-button');
const exportButton = element<HTMLButtonElement>('export-button');
const easyFinishButton = element<HTMLButtonElement>('easy-finish-download');
let easyReadySource: Source | undefined;
function setEasyStatus(text: string) { element('easy-finish-status').textContent = text; }
const cancelButton = element<HTMLButtonElement>('cancel-button');
const progress = element<HTMLProgressElement>('progress');
const seek = element<HTMLInputElement>('seek');
const matchToggle = element<HTMLInputElement>('match-toggle');
const status = element('status'), errorBox = element('error');
const demoButton = element<HTMLButtonElement>('demo-button');
let worker: Worker | undefined, generation = 0, busy = false;
let importingSingle = false;
let mixFile: CandidateFile | undefined;
let stemModeExplicit = false;
let pendingFile: CandidateFile | undefined, acceptedFile: CandidateFile | undefined;
function discardPendingFile() { void pendingFile?.discard(); pendingFile = undefined; }
function discardAcceptedFile() { void acceptedFile?.discard(); acceptedFile = undefined; }
let flacDecodeInFlight: Promise<unknown> = Promise.resolve();
let selected: ComparisonSlot = 'a', plan: ComparisonPlan | undefined, matched = false;
let context: AudioContext | undefined, player: ComparisonPlayer | undefined, animation = 0;
const stemAudition = bindListeningTest({ song: getPlayer, context: () => context!,
  reports: () => plan?.match.available && sources.a && sources.b ? { a: sources.a.result, b: sources.b.result,
    aLabel: sources.a.stemMix ? 'STEMミックス A' : '原音 A', bLabel: sources.b.processing || sources.b.file ? '仕上がり B' : '比較音源 B' } : undefined,
  restore: () => { configurePlayer(); paint(); }, volume: () => Number(element<HTMLInputElement>('volume').value), time: seconds => time(seconds) });
let autoMode: AutoMode = 'AUTO', finishReport: (Omit<AutoFinishResult, 'processed'> & { sourceMix?: StemMixReport }) | undefined;
let stemEntries: StemFileEntry[] = [], stemNextId = 0, stemImportActive = false;
let stemQueued = false;
let committedStemStudio: StemStudioSettings | undefined;
let restoredStemNeedsRebuild = false;
let committedStemInputs: StemFileEntry[] = [];
let committedStemOptions: { signature: string; reference?: File } | undefined;
function stemInputOptions() {
  // These controls belong to the STEM workspace; finishing controls are reset separately.
  const double=checked('guitar-double'),stabilize=checked('stem-stabilize');
  const clarity=stemMode.value==='stems' && stemEntries.length>=3 && checked('stem-multitrack-auto');
  const signature=JSON.stringify({
    restore:checked('studio-restore'),
    double:double ? {amount:studioNumber('double-amount'),ms:studioNumber('double-ms')} : null,
    stabilize:stabilize ? {sensitivityDb:studioNumber('ref-sense'),repairMs:studioNumber('ref-duration'),
      maxDb:studioNumber('ref-max'),percent:studioNumber('ref-percent'),toleranceDb:studioNumber('ref-tolerance')} : null,
    autoBalance:stemMode.value==='vocal-instrumental' && stemAutoBalance.checked,
    clarity,vocalSupport:clarity && checked('stem-vocal-support'),
  });
  return {signature,reference:stabilize ? element<HTMLInputElement>('stem-reference').files?.[0] : undefined};
}
function waitForFlacSlot(signal:AbortSignal):Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve,reject)=>{
    const cancelled=()=>{signal.removeEventListener('abort',cancelled);reject(new DOMException('Cancelled','AbortError'));};
    const done=()=>{signal.removeEventListener('abort',cancelled);resolve();};
    signal.addEventListener('abort',cancelled,{once:true});
    void flacDecodeInFlight.then(done,done);
  });
}
function hasPendingStemInputs() {
  if(restoredStemNeedsRebuild)return true;
  if (!sources.a?.stemMix || !stemEntries.length) return false;
  if (stemMode.value !== sources.a.stemMix.plan.mode || stemEntries.length !== committedStemInputs.length) return true;
  const currentOptions=stemInputOptions();
  if(currentOptions.signature!==committedStemOptions?.signature || currentOptions.reference!==committedStemOptions?.reference)return true;
  return stemEntries.some((entry,index) => {
    const committed = committedStemInputs[index];
    return !committed || entry.id !== committed.id || entry.file !== committed.file || entry.role !== committed.role ||
      entry.vocalRole !== committed.vocalRole || entry.gainDb !== committed.gainDb || entry.pan !== committed.pan ||
      entry.muted !== committed.muted || (entry.restorationEnabled !== false) !== (committed.restorationEnabled !== false);
  });
}
function soloTracks() {
  const reports = sources.a?.stemMix?.tracks ?? [];
  return stemEntries.flatMap(entry => {
    const track = reports.find(track => track.descriptor.id === entry.id);
    return track ? [{ id: entry.id, name: entry.file.name, file: entry.file, analysis: track.analysis,
      repairAvailable:!!committedStemStudio?.restore,
      repairEnabled:entry.restorationEnabled !== false,
      repairCommitted:!!committedStemStudio?.restore && track.descriptor.restorationEnabled !== false && !track.descriptor.muted,
      repairPending:(entry.restorationEnabled !== false)!==(track.descriptor.restorationEnabled !== false),
    }] : [];
  });
}
const stemSolo = bindStemSolo({
  song: getPlayer, context: () => context!, tracks: soloTracks,
  mix: () => sources.a ? {source:sources.a,analysis:sources.a.result} : undefined,
  volume: () => Number(element<HTMLInputElement>('volume').value),
  time: seconds => time(seconds), beforeOpen: () => stemAudition.close(),
  restore: () => { configurePlayer(); paint(); },
  async prepareRepair(id,signal,onProgress) {
    const entry=stemEntries.find(entry=>entry.id===id), studio=committedStemStudio;
    if(!entry||!studio?.restore)throw new Error('素材補修を有効にしてミックスを作り直してください。');
    return prepareStemRepairPreview({...entry},structuredClone(studio),async buffer=>{
      await waitForFlacSlot(signal);
      signal.throwIfAborted();
      const decoding=decodeFlac(buffer,STEM_LIMITS.maxBusBytes);
      flacDecodeInFlight=decoding.then(()=>undefined,()=>undefined);
      return decoding;
    },signal,(fraction,text)=>onProgress(fraction,text));
  },
  setRepairEnabled(id,enabled) {
    const entry=stemEntries.find(entry=>entry.id===id);
    if(!entry||busy)return;
    entry.restorationEnabled=enabled;renderStemList();
    element('stem-status').textContent='素材の補修設定を変更しました。「ミックスを作り直す」で反映します。現在のA/Bは保持しています。';
  },
  rebuild() { if(!busy)void assembleStems(stemEntries,stemMode.value as StemMode); },
});
const stemMode = element<HTMLSelectElement>('stem-mode');
const stemAutoBalance = element<HTMLInputElement>('stem-auto-balance');
let colorReport: Omit<SoundColorResult, 'processed'> | undefined;
const outputProfile = element<HTMLSelectElement>('output-profile');
for (const [id, profile] of Object.entries(OUTPUT_PROFILES)) {
  const option = document.createElement('option'); option.value = id; option.textContent = profile.label; outputProfile.append(option);
}
for (const [id, label] of Object.entries(FINISH_CONTROL_LABELS)) {
  const control = document.createElement('select'); control.id = `finish-${id}`;
  ['そのまま', '少し', 'しっかり', '強め'].forEach((text, value) => { const option = document.createElement('option'); option.value = String(value); option.textContent = text; control.append(option); });
  const parent = document.createElement('label'); parent.htmlFor = control.id; parent.append(label, control); element('finish-controls').append(parent);
}
function finishingPreferences(): FinishingPreferences {
  const controls = { ...DEFAULT_FINISH_CONTROLS };
  for (const id of Object.keys(controls) as (keyof FinishControls)[]) controls[id] = Number(element<HTMLSelectElement>(`finish-${id}`).value) as FinishControls[typeof id];
  return { controls, output: outputProfile.value as OutputProfileId };
}
function updateOutputProfile(): void {
  const p = OUTPUT_PROFILES[outputProfile.value as OutputProfileId];
  element('output-description').textContent = `${p.description}${p.targetLufs === null ? '' : ` 目標 ${p.targetLufs} LUFS / 推定ピーク上限 ${p.ceilingDb} dBTP。`} 音量目標より原音の強弱と安全性を優先し、実測値を表示します。`;
}
updateOutputProfile();
const colorSelect = element<HTMLSelectElement>('sound-color-preset');
const colorIntensity = element<HTMLSelectElement>('sound-color-intensity');
for (const [id, preset] of Object.entries(SOUND_COLOR_PRESETS)) {
  let group = Array.from(colorSelect.children).find(el => el.getAttribute('label') === preset.group) as HTMLOptGroupElement | undefined;
  if (!group) { group = document.createElement('optgroup'); group.label = preset.group; colorSelect.append(group); }
  const option = document.createElement('option'); option.value = id; option.textContent = preset.label; group.append(option);
}
function colorSelection(): SoundColorSelection {
  return { preset: colorSelect.value as SoundColorSelection['preset'], intensity: colorIntensity.value as SoundColorSelection['intensity'] };
}
function updateColorSelection(): void {
  const selection = colorSelection(), p = SOUND_COLOR_PRESETS[selection.preset], amount = SOUND_COLOR_INTENSITIES[selection.intensity];
  element('sound-color-description').textContent = `${p.description} 選択だけでは現在のBは変わりません。`;
  const labels = p.bands.map(b => `${b.frequencyHz >= 1000 ? `${b.frequencyHz / 1000} kHz` : `${b.frequencyHz} Hz`} ${(b.gainDb * amount).toFixed(1)} dB`);
  if (p.highpassHz || p.lowpassHz) labels.push('帯域を狭める');
  if (p.noiseDb !== undefined || p.crackleDb !== undefined) labels.push('ノイズの質感');
  if (p.wowDepthMs) labels.push('軽い揺れ');
  if (!labels.length) labels.push('音色変更なし');
  element('sound-color-bands').replaceChildren(...labels.map(label => { const span = document.createElement('span'); span.textContent = label; return span; }));
}
function liveSelection(): LiveSelection {
  return { venue: element<HTMLSelectElement>('live-venue').value as LiveSelection['venue'], intensity: element<HTMLSelectElement>('live-intensity').value as LiveSelection['intensity'] };
}
function updateLiveSelection(): void {
  const selection = liveSelection(), intensity = { gentle: '控えめ', standard: '標準', vivid: 'はっきり' }[selection.intensity];
  const descriptions = { 'live-house': '近いステージと短い壁の反射', 'concert-hall': 'ホールの広がりと奥行き', arena: '大きな客席へ広がる長い響き' };
  element('live-description').textContent = `${descriptions[selection.venue]}を${intensity}に加えます。選択後、下のLIVEを押してください。`;
}

const time = (seconds: number) => {
  const ticks = Math.floor(Math.max(0, seconds) * 10);
  return `${Math.floor(ticks / 600)}:${((ticks % 600) / 10).toFixed(1).padStart(4, '0')}`;
};
const duration = () => plan?.durationSeconds ?? sources.a?.result.durationSeconds ?? 0;
const gains = () => plan ? (matched ? plan.match.gainsDb : plan.rawGainsDb) : { a: sources.a ? singleSourceGainDb(sources.a.result) : 0, b: 0 };
function configurePlayer(): void {
  player?.configure(selected, { ...gains() }, Number(element<HTMLInputElement>('volume').value));
}
function rebuildPlayer(): void {
  // Copy the slot map: active playback must not retain a mutable UI state object.
  player?.setSources({ ...sources }, duration());
  configurePlayer();
  seek.max = String(duration());
  paint();
}
function getPlayer(): ComparisonPlayer {
  sounds.cancel();
  if (!player) {
    context = new AudioContext(); player = new ComparisonPlayer(context);
    rebuildPlayer();
  }
  return player;
}
function paint(): void {
  cancelAnimationFrame(animation);
  const position = player?.positionSeconds ?? 0, source = sources[selected];
  if (source) drawWaveform(canvas, source.result.waveform, position / source.result.durationSeconds);
  element('play-time').textContent = `${time(position)} / ${time(duration())}`;
  seek.value = String(position);
  const playing = player?.playing ?? false;
  playButton.textContent = playing ? 'Ⅱ' : '▶'; playButton.setAttribute('aria-label', playing ? '一時停止' : '再生');
  if (playing) animation = requestAnimationFrame(paint);
}
function showError(message: string): void { errorBox.textContent = message; errorBox.hidden = false; sounds.error(); }
async function togglePlayback(): Promise<void> {
  if (busy || !sources.a) return;
  try {
    const playback = getPlayer();
    if (playback.playing) playback.pause(); else await playback.play();
    paint();
  } catch { showError('再生を開始できません。ブラウザの音声設定を確認してください。'); }
}

function updateComparison(): void {
  for (const slot of ['a', 'b'] as const) {
    const source = sources[slot], button = element<HTMLButtonElement>(`select-${slot}`);
    element(`${slot}-name`).textContent = source?.name ?? (slot === 'a' ? '元の音源を読み込み' : '比較する音源を読み込み');
    element(`${slot}-lufs`).textContent = source ? `${formatMetric(source.result.integratedLufs)} LUFS` : '—';
    element(`${slot}-gain`).textContent = source ? `${gains()[slot].toFixed(1)} dB` : '—';
    button.disabled = busy || !source;
    button.setAttribute('aria-pressed', String(selected === slot));
    element(`card-${slot}`).classList.toggle('selected', selected === slot && !!source);
  }
  inputB.disabled = !sources.a?.audio;
  element<HTMLButtonElement>('clear-b').disabled = busy || !sources.b;
  element<HTMLButtonElement>('blind-song').disabled = busy || !plan?.match.available;
  matchToggle.disabled = busy || !plan?.match.available;
  matchToggle.checked = matched;
  element('match-mode').textContent = matched ? 'LOUDNESS MATCHED' : 'RAW';
  const messages = [];
  if (plan) {
    messages.push(`比較区間 0:00.0–${time(plan.durationSeconds)}。`);
    if (plan.lengthMismatch) messages.push('長さが異なるため、再生は短い方の末尾まで。音量補正は各ファイル全体のLUFSを使います。');
    messages.push(plan.match.reason ?? (matched ? `試聴目標 ${plan.match.targetLufs!.toFixed(1)} LUFS。大きい方を下げて比較しています。` : '元の音量差を保って比較しています。'));
    const common = matched ? plan.match.sharedAttenuationDb : plan.rawGainsDb.a;
    if (common < -0.01) messages.push(`ピーク対策で両方を共通に ${common.toFixed(1)} dB下げています。`);
  } else messages.push('Bに別途処理した音源を読み込むと、同じ位置でA/B比較できます。');
  element('comparison-status').textContent = messages.join(' ');
  configurePlayer();
}
function setStatus(text: string) {
  status.textContent = text;
  element('processing-task').textContent = text;
}
function setProgress(fraction?: number) {
  if (fraction === undefined || !Number.isFinite(fraction) || fraction <= 0) {
    progress.removeAttribute('value');
    element('processing-percent').textContent = '準備中';
    return;
  }
  progress.value = Math.min(1, fraction);
  element('processing-percent').textContent = Math.round(progress.value * 100) + '%';
}
function setBusy(value: boolean): void {
  if (value) { stemAudition.close(); stemSolo.close(); }
  sounds.working(value);
  element<HTMLFieldSetElement>('audio-export-settings').disabled = value;
  element<HTMLButtonElement>('project-save').disabled = value || !sources.a;
  element<HTMLInputElement>('project-open').disabled = value;
  element<HTMLInputElement>('project-name').disabled = value;
  busy = value; referenceWorkspace.refresh();batchWorkspace.setBlocked(value);
  cancelButton.hidden = !value; progress.hidden = !value;
  easyFinishButton.disabled = value || !sources.a;
  outputProfile.disabled = value;
  if (!value && easyReadySource !== sources.a) {
    easyReadySource = sources.a;
    setEasyStatus(sources.a ? '読み込み済みです。ボタンを押すと、自動仕上げから選択形式での保存まで進みます。' : 'まず音源を読み込んでください。');
  }
  element('processing-overlay').hidden = !value;
  if (value) { setProgress(); element('processing-task').textContent = '準備しています…'; }
  demoButton.disabled = value; element<HTMLButtonElement>('compare-demo-button').disabled = value;
  playButton.disabled = value || !sources.a; stopButton.disabled = value || !sources.a;
  exportButton.disabled = value || !sources[selected]; seek.disabled = value || !sources.a;
  element<HTMLButtonElement>('process-button').disabled = value || !sources.a?.audio;
  element<HTMLButtonElement>('sound-color-apply').disabled = value || !sources.a?.audio;
  element<HTMLFieldSetElement>('sound-color-settings').disabled = value;
  element<HTMLFieldSetElement>('live-settings').disabled = value;
  element<HTMLFieldSetElement>('finish-preferences').disabled = value;
  element<HTMLFieldSetElement>('stem-settings').disabled = value;
  element<HTMLButtonElement>('stem-render').disabled = value || stemEntries.length < 2;
  for (const button of document.querySelectorAll<HTMLButtonElement>('.stem-listen'))
    button.disabled = value || !soloTracks().some(track=>track.id===button.closest<HTMLElement>('.stem-track')?.dataset.trackId);
  element<HTMLButtonElement>('finish-preferences-apply').disabled = value || !sources.a?.audio;
  element<HTMLButtonElement>('wav-button').disabled = value || !(sources.b?.processing || sources.b?.file);
  element<HTMLFieldSetElement>('dsp-settings').disabled = value;
  element<HTMLFieldSetElement>('master-settings').disabled = value;
  for (const mode of ['AUTO', 'IMPACT', 'LIVE'] as const) {
    element<HTMLButtonElement>(`mode-${mode}`).disabled = importingSingle || stemImportActive || !sources.a;
    element(`mode-${mode}`).setAttribute('aria-pressed', String(mode === autoMode));
  }
  element<HTMLButtonElement>('undo-finish').disabled = value || !sources.b;
  element<HTMLButtonElement>('finish-report-button').disabled = value || (!finishReport && !colorReport);
  const fileMode = !!sources.a?.file;
  element<HTMLFieldSetElement>('sound-color-settings').disabled = value || fileMode;
  element<HTMLButtonElement>('finish-preferences-apply').disabled = value || !sources.a;
  updateMasteringPlan();
  const processing = sources.b?.processing;
  element('processing-result').textContent = processing
    ? `Bは適用時の設定で生成済み。${processing.chain.bypass ? '全体バイパス' : `ゲイン ${processing.chain.gainDb.toFixed(1)} dB · EQ ${processing.chain.eq.enabled ? `${processing.chain.eq.frequencyHz} Hz / ${processing.chain.eq.gainDb} dB / Q ${processing.chain.eq.q}` : 'OFF'} · リミッター ${processing.chain.limiter.enabled ? `${processing.chain.limiter.ceilingDb} dB / ${processing.chain.limiter.releaseMs} ms` : 'OFF'}`}。最大ゲインリダクション ${processing.maxReductionDb.toFixed(1)} dB / 推定ピーク追加減衰 ${processing.peakGuardDb.toFixed(1)} dB。`
    : 'Aから新しいBを生成します。適用すると現在のBを置き換えます。';
  if (processing && finishReport?.status === 'accepted') element('processing-result').textContent = `以下はMaster最終段の設定です。Mix補正と再試行は自動仕上げレポートで確認できます。 ${element('processing-result').textContent}`;
  if (processing && colorReport?.status === 'accepted') element('processing-result').textContent = `Bの音色：${SOUND_COLOR_PRESETS[colorReport.selection.preset].label}。以下は音色処理後のピーク保護設定です。音色のEQ・質感設定はレポートに含まれます。 ${element('processing-result').textContent}`;
  updateComparison();
}
function clearScreen(): void {
  for (const id of ['lufs', 'true-peak', 'crest', 'correlation', 'sample-peak', 'rms', 'clipped', 'side', 'duration']) element(id).textContent = '—';
  element('track-name').textContent = 'まだ音声がありません';
  element('track-meta').textContent = 'オリジナルの音声を読み込んで始めましょう。';
  element('source-badge').textContent = 'A · BEFORE';
  element('analysis-note').textContent = 'まだ解析結果はありません。';
  element('warnings').replaceChildren(); element('wave-placeholder').hidden = false;
  document.querySelectorAll<HTMLElement>('.meter-track span').forEach(bar => { bar.style.width = '0%'; });
  drawWaveform(canvas, []);
}
function showResult(): void {
  const source = sources[selected];
  if (!source) { clearScreen(); return; }
  const value = source.result;
  element('track-name').textContent = source.name;
  element('source-badge').textContent = selected === 'a' ? 'A · BEFORE' : 'B · AFTER';
  element('track-meta').textContent = `${(value.sampleRate / 1000).toFixed(1)} kHz · ${value.channels === 1 ? 'MONO' : 'STEREO'} · ${time(value.durationSeconds)} · 原音のサンプルレートで解析`;
  element('duration').textContent = time(value.durationSeconds); element('wave-placeholder').hidden = true;
  const metrics: [string, number | null, string, number][] = [
    ['lufs', value.integratedLufs, '', 1], ['true-peak', value.truePeakDbtp, '', 1],
    ['crest', value.crestFactorDb, '', 1], ['correlation', value.stereoCorrelation, '', 2],
    ['sample-peak', value.samplePeakDbfs, ' dBFS', 1], ['rms', value.rmsDbfs, ' dBFS', 1], ['side', value.sideEnergyPercent, ' %', 1],
  ];
  metrics.forEach(([id, value, unit, decimals]) => { element(id).textContent = formatMetric(value, decimals) + (value === null ? '' : unit); });
  element('clipped').textContent = value.clippedSamples.toLocaleString();
  const levels = [value.integratedLufs === null ? 0 : (value.integratedLufs + 60) / 60,
    value.truePeakDbtp === null ? 0 : (value.truePeakDbtp + 60) / 60,
    (value.crestFactorDb ?? 0) / 30, value.stereoCorrelation === null ? 0 : (value.stereoCorrelation + 1) / 2];
  document.querySelectorAll<HTMLElement>('.meter-track span').forEach((bar, i) => { bar.style.width = `${100 * Math.min(1, Math.max(0, levels[i]))}%`; });
  element('analysis-note').textContent = value.warnings.length ? '確認しておきたい点があります。' : '基本解析が完了しました。原音は変更されていません。';
  element('warnings').replaceChildren(...value.warnings.map(message => { const li = document.createElement('li'); li.textContent = message; return li; }));
  paint();
}
function cancel(): void {
  externalJobCancel?.();externalJobCancel=undefined;
  sessionAbort?.abort(); sessionAbort = undefined; sounds.cancel();
  discardPendingFile();
  importingSingle = false;
  stemQueued = false;
  if (stemImportActive) { stemImportActive = false; element('stem-status').textContent = 'STEM読み込みをキャンセルしました。現在のA/Bと素材リストを保持しています。'; }
  generation++; worker?.terminate(); worker = undefined; rebuildPlayer(); setBusy(false); showResult();
  setStatus('処理をキャンセルしました。保持されている音源を利用できます。');
  setEasyStatus('処理をキャンセルしました。自動保存は行っていません。原音と既存の仕上がりを保持しています。');
  element('finish-explanation').textContent = '処理をキャンセルしました。原音と既存の仕上がりは保持しています。';
}
function fail(message: string, id: number, processing = false): void {
  if (id !== generation) return;
  discardPendingFile();
  importingSingle = false;
  if (stemImportActive && stemQueued) { restartQueuedStems(); return; }
  if (stemImportActive) { stemImportActive = false; element('stem-status').textContent = `読み込めませんでした：${message} 現在のA/Bと素材リストを保持しています。`; }
  worker?.terminate(); worker = undefined; rebuildPlayer(); setBusy(false); showResult(); showError(message);
  setStatus(processing ? '処理を完了できませんでした。原音と既存の仕上がりは保持しています。' : '読み込めませんでした。別のファイルをお試しください。');
  if (processing) element('finish-explanation').textContent = message;
  setEasyStatus('処理を完了できませんでした。自動保存は行っていません。' + message);
}

async function startWorker(id: number, slot: ComparisonSlot, name: string, message: { buffer?: ArrayBuffer; audio?: AudioData; file?: File; maxDecodedBytes?: number }, transfer: Transferable[], onComplete?: () => void): Promise<void> {
  if (id !== generation) return;
  let ready: Worker;
  try { ready = await openAudioWorker('analysis', new URL(analysisWorkerUrl, document.baseURI)); }
  catch (error) { fail(error instanceof Error ? error.message : '解析処理を開始できませんでした。', id, true); return; }
  if (id !== generation) { ready.terminate(); return; }
  worker = ready;
  worker.onmessage = (event: MessageEvent) => {
    if (id !== generation) return;
    const data = event.data;
    if (data.type === 'progress') { setProgress(data.fraction); setStatus(`${slot.toUpperCase()} 音響解析中… ${Math.round(data.fraction * 100)}%`); }
    else if (data.type === 'error') fail(data.message, id);
    else if (data.type === 'result' || data.type === 'stream-result') {
      try {
        if (data.type === 'stream-result' && (slot !== 'a' || !message.file)) throw new Error('長尺WAVはAに読み込んでください。');
        if (slot === 'b') {
          if (!sources.a) throw new Error('先にAの音声を読み込んでください。');
          const nextPlan = createComparisonPlan(sources.a.result, data.result);
          resetImportResult('b'); plan = nextPlan;
        } else {
          resetImportResult('a');
        }
        sources[slot] = data.type === 'stream-result' ? { file: message.file!, result: data.result, name } : { audio: data.audio, result: data.result, name };
        if (slot === 'a') {
          const limit = time(Math.min(LIMITS.maxSeconds, AUTO_ENGINE_LIMITS.maxInputBytes / (data.result.channels * 4 * data.result.sampleRate)));
          element('input-capacity').textContent = data.type === 'stream-result'
            ? `このWAV ${time(data.result.durationSeconds)} を分割解析しました。モードと出力先を選ぶと仕上がりを試聴・保存できます。`
            : `この音源：${time(data.result.durationSeconds)} / ${(data.result.sampleRate / 1000).toFixed(1)} kHz。仕上げ可能な長さはこの形式で最大 ${limit} です。`;
        }
        worker?.terminate(); worker = undefined; selected = slot; importingSingle = false;
        rebuildPlayer(); showResult(); setBusy(false);
        setStatus(data.type === 'stream-result' ? '長尺WAVの分割解析が完了しました。原音の試聴ができます。' : '解析完了 · 音声はこの端末内だけで処理されました。');
        if (data.type === 'stream-result') element('finish-explanation').textContent = 'AUTO・IMPACT・LIVEから選んでください。長尺WAVには曲全体の音量・ピーク補正と、モードに応じた処理を適用します。';
        if (!onComplete) sounds.success();
        onComplete?.();
      } catch (error) { fail(error instanceof Error ? error.message : '比較を準備できませんでした。', id); }
    }
  };
  worker.onerror = () => fail('解析Workerでエラーが発生しました。再読み込みしてお試しください。', id);
  worker.postMessage(message, transfer);
}
function resetImportResult(slot: ComparisonSlot): void {
  setAcceptedFinishSettings(); element('finish-applied-summary').textContent = '';
  discardAcceptedFile();
  element('preferences-result').textContent = '選択後、AUTOなどを押すと適用します。現在のBにはまだ適用していません。';
  element('master-outcome').textContent = '';
  finishReport = undefined; colorReport = undefined; element('live-result').textContent = '会場を選び、LIVEを押してください。'; element('sound-color-result').textContent = '音色を選び、AUTOまたは音色の適用ボタンを押してください。'; element('finish-explanation').textContent = '曲を読み込み、仕上がりの方向を選んでください。'; element('finish-details').textContent = '';
  delete sources.b;
  if (slot === 'a') { restoredStemNeedsRebuild=false; stemAudition.set(); element<HTMLInputElement>('stem-reference').value = ''; void mixFile?.discard(); mixFile = undefined; delete sources.a; stemEntries = []; committedStemInputs = []; renderStemList(); element('stem-status').textContent = '単体音源を読み込みます。STEMやボーカル＋伴奏は、素材をまとめて追加できます。'; }
  selected = 'a'; plan = undefined; matched = false;
}
function begin(slot: ComparisonSlot): number {
  sessionAbort?.abort(); sessionAbort=undefined;
  discardPendingFile();
  generation++; worker?.terminate(); worker = undefined;
  stemImportActive = false; stemQueued = false;
  importingSingle = true;
  // Keep committed audio, source list and reports until the new import succeeds.
  player?.setSources({}, 0); errorBox.hidden = true;
  setProgress(0); setBusy(true); setStatus(`${slot.toUpperCase()} の音声を読み込み中…`);
  return generation;
}
async function loadFile(file: File, slot: ComparisonSlot): Promise<void> {
  if (slot === 'b' && !sources.a) { showError('先にAの音声を読み込んでください。'); return; }
  if (slot === 'b' && !sources.a?.audio) { showError('長尺WAVのB比較はまだ利用できません。'); return; }
  const id = begin(slot);
  try {
    if (!/\.(wav|flac)$/i.test(file.name)) throw new Error('WAVまたはFLACファイルを選択してください。');
    if (!file.size) throw new Error('空のファイルは読み込めません。');
    if (/\.wav$/i.test(file.name)) {
      const info = await readWavFileMetadata(file);
      if (id !== generation) return;
      if (file.size > LIMITS.maxFileBytes || info.frames / info.sampleRate > LIMITS.maxSeconds || info.frames * info.channels * 4 > AUTO_ENGINE_LIMITS.maxInputBytes) {
        if (slot === 'b') throw new Error('長尺WAVのB比較はまだ利用できません。');
        void startWorker(id, slot, file.name, { file }, [], () => { sources[slot]!.originalFile=file; sounds.success(); });
        return;
      }
    } else if (file.size > LIMITS.maxFileBytes) throw new Error('FLACは100 MiB以内にしてください。');
    await flacDecodeInFlight;
    if (id !== generation) return;
    const retained = slot === 'b' && sources.a?.audio ? sources.a.audio.channels.length * sources.a.audio.channels[0].byteLength : 0;
    const maxDecodedBytes = LIMITS.maxDecodedBytes - retained;
    const buffer = await file.arrayBuffer();
    if (id !== generation) return;
    if (/\.flac$/i.test(file.name)) {
      setStatus('FLACをデコード中…');
      const decoding = decodeFlac(buffer, maxDecodedBytes);
      flacDecodeInFlight = decoding.then(() => undefined, () => undefined);
      const decoded = await decoding;
      if (id !== generation) return;
      startWorker(id, slot, file.name, { audio: decoded }, decoded.channels.map(c => c.buffer as ArrayBuffer), () => { sources[slot]!.originalFile=file; sounds.success(); });
    } else startWorker(id, slot, file.name, { buffer, maxDecodedBytes }, [buffer], () => { sources[slot]!.originalFile=file; sounds.success(); });
  } catch (error) { fail(error instanceof Error ? error.message : '音声を読み込めませんでした。', id); }
}
function bindImport(fileInput: HTMLInputElement, zone: HTMLElement, slot: ComparisonSlot): void {
  fileInput.addEventListener('change', () => { const files = Array.from(fileInput.files ?? []); if (slot === 'a' && files.length && (files.length > 1 || stemImportActive)) void addStemFiles(files); else if (files[0]) void loadFile(files[0], slot); fileInput.value = ''; });
  zone.addEventListener('dragover', event => { event.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', event => {
    event.preventDefault(); zone.classList.remove('drag-over');
    const files = event.dataTransfer?.files;
    if (slot === 'a' && files?.length && (files.length > 1 || stemImportActive)) void addStemFiles(Array.from(files));
    else if (files?.length === 1) void loadFile(files[0], slot); else showError('Bは1つずつファイルを読み込んでください。');
  });
}
window.addEventListener('dragover', event => event.preventDefault());
window.addEventListener('drop', event => event.preventDefault());
bindImport(input, element('dropzone'), 'a'); bindImport(inputB, element('card-b'), 'b');

function renderStemList(): void {
  const rows = stemEntries.map(entry => {
    const row = document.createElement('div'); row.className = 'stem-track'; row.dataset.trackId = entry.id;
    const name = document.createElement('strong'); name.textContent = entry.file.name;
    const applied = sources.a?.stemMix?.autoBalance?.tracks.find(track => track.id === entry.id);
    if (applied && applied.adjustmentDb !== 0) {
      const mark = document.createElement('span'); mark.className = 'stem-applied';
      mark.textContent = `現在のA: 自動 ${applied.adjustmentDb > 0 ? '+' : ''}${applied.adjustmentDb.toFixed(1)} dB`;
      name.append(mark);
    }
    const masking = sources.a?.stemMix?.masking;
    if (masking?.status === 'applied' && masking.instrumentalId === entry.id) {
      const mark = document.createElement('span'); mark.className = 'stem-applied';
      mark.textContent = '現在のA: 声と重なる帯域を控えめに整理'; name.append(mark);
    }
    const currentTrack = sources.a?.stemMix?.tracks.find(track=>track.descriptor.id===entry.id);
    if(entry.restorationEnabled === false || currentTrack?.descriptor.restorationEnabled === false) {
      const mark=document.createElement('span');mark.className='stem-applied';
      const pending=(entry.restorationEnabled !== false)!==(currentTrack?.descriptor.restorationEnabled !== false);
      mark.textContent=pending ? '補修設定の変更あり · 再合成で反映' : '現在のA: この素材の補修OFF';
      name.append(mark);
    }
    const grain = sources.a?.stemMix?.tracks.find(track => track.descriptor.id === entry.id)?.restoration?.grain;
    if (grain) {
      const mark = document.createElement('span'); mark.className = 'stem-applied';
      mark.textContent = grain.status === 'applied' ? '現在のA: ジャリつき補修 ' + grain.seconds.toFixed(1) + '秒' :
        grain.status === 'reverted' ? '現在のA: 保護条件により補修を見送り' : '現在のA: 追加のジャリつき補修なし';
      mark.title = grain.explanation; name.append(mark);
    }
    const clarity = sources.a?.stemMix?.clarity;
    const adjusted = clarity?.status === 'applied' ? clarity.tracks.find(track => track.id === entry.id) : undefined;
    if (adjusted && (adjusted.presenceSeconds > 0 || adjusted.lowSeconds > 0 || (adjusted.supportSeconds ?? 0) > 0)) {
      const mark = document.createElement('span'); mark.className = 'stem-applied';
      mark.textContent = '現在のA: ' + [
        (adjusted.supportSeconds ?? 0) > 0 ? '小さくなる歌声を補助 ' + adjusted.supportSeconds!.toFixed(1) + '秒' : '',
        adjusted.presenceSeconds > 0 ? '歌の重なりを整理 ' + adjusted.presenceSeconds.toFixed(1) + '秒' : '',
        adjusted.lowSeconds > 0 ? 'キックと低音の重なりを整理 ' + adjusted.lowSeconds.toFixed(1) + '秒' : '',
      ].filter(Boolean).join(' / ');
      name.append(mark);
    }
    const role = document.createElement('select'); role.setAttribute('aria-label', `${entry.file.name} の役割`);
    for (const [value, text] of Object.entries(STEM_ROLES)) { const option = document.createElement('option'); option.value = value; option.textContent = text; role.append(option); }
    for (const [value, text] of [['lead', 'メインボーカル'], ['backing', 'コーラス']] as const) {
      const option = document.createElement('option'); option.value = 'vocal-' + value; option.textContent = text; role.append(option);
    }
    role.value = entry.role === 'vocal' && entry.vocalRole ? 'vocal-' + entry.vocalRole : entry.role;
    const volume = document.createElement('select'); volume.setAttribute('aria-label', `${entry.file.name} の音量`);
    for (const gain of [-12, -6, -3, 0, 3, 6]) { const option = document.createElement('option'); option.value = String(gain); option.textContent = `${gain > 0 ? '+' : ''}${gain} dB`; volume.append(option); }
    volume.value = String(entry.gainDb);
    const included = document.createElement('input'); included.type = 'checkbox'; included.checked = !entry.muted;
    const includeLabel = document.createElement('label'); includeLabel.append(included, '含める');
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'text-button'; remove.textContent = '外す'; remove.setAttribute('aria-label', `${entry.file.name} を素材リストから外す`);
    const changed = () => { element('stem-status').textContent = '素材設定を変更しました。「ミックスを作り直す」で反映します。現在のA/Bは保持しています。'; };
    role.addEventListener('change', () => {
      if (role.value === 'vocal-lead' || role.value === 'vocal-backing') { entry.role = 'vocal'; entry.vocalRole = role.value === 'vocal-lead' ? 'lead' : 'backing'; }
      else { entry.role = role.value as StemFileEntry['role']; delete entry.vocalRole; }
      changed();
    });
    volume.addEventListener('change', () => { entry.gainDb = Number(volume.value); changed(); });
    included.addEventListener('change', () => { entry.muted = !included.checked; changed(); });
    remove.addEventListener('click', () => { stemEntries = stemEntries.filter(e => e.id !== entry.id); renderStemList(); changed(); });
    const listen = document.createElement('button'); listen.type = 'button'; listen.className = 'button subtle stem-listen';
    listen.textContent = 'この素材を聴く'; listen.setAttribute('aria-label', entry.file.name + ' だけを聴く');
    listen.disabled = busy || !sources.a?.stemMix?.tracks.some(track=>track.descriptor.id===entry.id);
    listen.title = listen.disabled ? '読み込み・合成後に元の素材を単独で聴けます。' : '元の素材（補修前）を単独で試聴します。';
    listen.addEventListener('click',()=>stemSolo.open(entry.id));
    row.append(name, role, volume, includeLabel, listen, remove);
    return row;
  });
  element('stem-track-list').replaceChildren(...rows);
  stemSolo.refresh();
  element<HTMLButtonElement>('stem-render').disabled = busy || stemEntries.length < 2;
}
async function addStemFiles(files: File[], forcedRole?: 'vocal' | 'instrumental'): Promise<void> {
  if (busy && !stemImportActive) { showError('仕上げ・単体読み込みの完了を待つか、キャンセルしてから素材を追加してください。'); return; }
  if (forcedRole && files.length !== 1) { showError('ボーカル・伴奏の枠には、それぞれ1素材を追加してください。'); return; }
  const entries = [...stemEntries.map(e => ({ ...e })), ...files.map(file => ({ id: `stem-${++stemNextId}`, file, role: forcedRole ?? suggestStemRole(file.name), vocalRole: forcedRole === 'instrumental' ? undefined : suggestStemVocalRole(file.name), gainDb: 0, pan: 0, muted: false }))];
  if (!stemModeExplicit && entries.length >= 2) {
    const paired = entries.length === 2 && entries.some(t => t.role === 'vocal') && entries.some(t => t.role === 'instrumental');
    stemMode.value = paired ? 'vocal-instrumental' : 'stems'; element('stem-pair-inputs').hidden = !paired;
  }
  const allWav = entries.every(t => /\.wav$/i.test(t.file.name));
  const mode = stemMode.value as StemMode;
  if (entries.length > (mode === 'vocal-instrumental' ? 2 : STEM_LIMITS.maxTracks) ||
    entries.some(t => !/\.(wav|flac)$/i.test(t.file.name) || !t.file.size || t.file.size > (allWav ? LONG_WAV_LIMITS.maxFileBytes : STEM_LIMITS.maxFileBytes)) ||
    entries.reduce((n, t) => n + t.file.size, 0) > (allWav ? longStemInputBytes : STEM_LIMITS.maxTotalFileBytes)) {
    showError('ボーカル＋伴奏は2素材、STEMは16素材までのWAV/FLACです。WAVのみは各512 MiB・合計1 GiB、FLACを含む場合は各100 MiB・合計400 MiBまで。素材リストをクリアして入れ替えられます。'); return;
  }
  if (mode === 'vocal-instrumental') {
    const other = entries.filter(t => t.role === 'other');
    if (entries.length === 1 && other.length === 1) other[0].role = 'vocal';
    else if (entries.length === 2 && other.length) {
      if (!entries.some(t => t.role === 'vocal')) other.shift()!.role = 'vocal';
      if (!entries.some(t => t.role === 'instrumental') && other.length) other[0].role = 'instrumental';
    }
  }
  // Staging is independent of committed A/B. Keep failed files editable, too.
  stemEntries = entries; renderStemList();
  if (stemImportActive) {
    stemQueued = true;
    element('stem-status').textContent = `${entries.length}素材を登録しました。追加分は処理待ちです。現在の読み込み後にまとめて合成します。`;
    return;
  }
  if (entries.length < 2) {
    element('stem-status').textContent = '1素材を待機リストに追加しました。もう1つ追加すると読み込み・合成します。役割は確認して変更できます。現在のA/Bは保持しています。';
    return;
  }
  await assembleStems(entries, mode);
}
async function assembleStems(entries: StemFileEntry[], mode: StemMode, onCommitted?: () => void): Promise<void> {
  discardPendingFile(); importingSingle = false;
  stemQueued = false;
  const pending = entries.map(e => ({ ...e })), id = ++generation;
  worker?.terminate(); worker = undefined; player?.setSources({}, 0); stemImportActive = true;
  setBusy(true); setProgress(0); errorBox.hidden = true; setStatus('STEMの形式と同期条件を確認しています…');
  element('stem-status').textContent = '読み込み中… 現在のA/Bは、合成が成功するまで保持しています。';
  let ready: Worker;
  let appliedStudio: StemStudioSettings | undefined;
  let appliedStemOptions: ReturnType<typeof stemInputOptions> | undefined;
  try { ready = await openAudioWorker('processing', new URL(processingWorkerUrl, document.baseURI)); }
  catch (error) { fail(error instanceof Error ? error.message : 'STEM処理を開始できませんでした。', id, true); return; }
  if (id !== generation) { ready.terminate(); return; }
  worker = ready;
  ready.onmessage = (event: MessageEvent) => {
    if (id !== generation) return;
    const data = event.data;
    if (data.type === 'stem-progress') { setProgress(data.fraction); setStatus(data.text); return; }
    if (data.type === 'stem-capacity') {
      element('stem-capacity').textContent = `${data.tracks}素材 / ${(data.sampleRate / 1000).toFixed(1)} kHz。長さ ${time(data.seconds)} / 合成上限 ${time(data.maxSeconds)}。素材の展開容量 ${data.sourceMiB.toFixed(1)} / 384 MiB、合成 ${data.busMiB.toFixed(1)} / 96 MiB。`;
      return;
    }
    if (data.type === 'stem-flac') {
      setProgress(); setStatus('FLAC素材を音声に展開しています…');
      void (async () => {
        try {
          await flacDecodeInFlight;
          if (id !== generation) return;
          const decoding = decodeFlac(data.buffer, STEM_LIMITS.maxBusBytes);
          flacDecodeInFlight = decoding.then(() => undefined, () => undefined);
          const audio = await decoding;
          if (id !== generation) return;
          ready.postMessage({ kind: 'stems-flac-result', id: data.id, audio }, audio.channels.map(c => c.buffer as ArrayBuffer));
        } catch (error) { if (id === generation) ready.postMessage({ kind: 'stems-flac-result', id: data.id, error: error instanceof Error ? error.message : 'FLACを読み込めませんでした。' }); }
      })();
      return;
    }
    if (data.type === 'error') { fail(data.message, id, true); return; }
    if (data.type !== 'stem-result') return;
    if (stemQueued) { restartQueuedStems(); return; }
    discardAcceptedFile();
    void mixFile?.discard(); mixFile = data.file ? pendingFile : undefined; pendingFile = undefined;
    setAcceptedFinishSettings(); element('finish-applied-summary').textContent = '';
    stemAudition.set(data.audition);
    stemEntries = pending; stemImportActive = false;
    // Keep raw staged gains/options, not the Core report's automatically adjusted gains.
    committedStemInputs = pending.map(entry => ({...entry}));
    committedStemOptions = appliedStemOptions;
    committedStemStudio = appliedStudio; restoredStemNeedsRebuild=false;
    sources.a = { ...(data.file ? { file: data.file } : { audio: data.audio }), result: data.analysis, stemMix: data.report, name: `${mode === 'vocal-instrumental' ? 'Vocal + Instrumental' : 'STEM Mix'} · ${pending.length} tracks.wav` };
    delete sources.b; selected = 'a'; plan = undefined; matched = false; finishReport = undefined; colorReport = undefined;
    element('finish-details').textContent = ''; element('master-outcome').textContent = '';
    element('preferences-result').textContent = '合成したAに、選択中の仕上がり調整を適用できます。';
    element('live-result').textContent = '合成したAからLIVEの候補を作れます。';
    element('sound-color-result').textContent = '合成したAから音色の候補を作れます。';
    element('finish-explanation').textContent = 'STEMミックスをAに用意しました。AUTO / IMPACT / LIVEで仕上げて、A/B比較できます。';
    element('stem-status').textContent = `${pending.length}素材を読み込み、先頭から同期してAを作りました。${data.report.autoBalance ? `${data.report.autoBalance.explanation} ` : ''}${data.report.masking ? `${data.report.masking.explanation} ` : ''}${data.report.warnings.join(' ')} 素材ファイルは保持しています。`;
    if (data.studioCompared && !data.audition) element('stem-status').textContent += ' 音量をそろえて比較できる調整差は見つかりませんでした。';
    worker?.terminate(); worker = undefined; renderStemList(); rebuildPlayer(); showResult(); setBusy(false);
    setStatus('STEM読み込み完了 · AUTOなどで仕上げられます。素材は端末から送信されません。');
    if (onCommitted && id === generation) onCommitted(); else sounds.success();
  };
  ready.onerror = event => { event.preventDefault(); fail('STEM読み込みが停止しました。現在のA/Bは保持しています。', id, true); };
  try {
    const fileMode = await needsFileMix(pending);
    if (id !== generation) return;
    const studio = stemStudio(), reference = element<HTMLInputElement>('stem-reference').files?.[0];
    appliedStudio=studio ? structuredClone(studio) : undefined;
    appliedStemOptions=stemInputOptions();
    if (studio?.stabilize && !reference) throw new Error('安定化には比較用の原曲WAVを選んでください。');
    const clarity = mode === 'stems' && pending.length >= 3 && checked('stem-multitrack-auto');
    const request = { mode, studio, clarity, vocalSupport: checked('stem-vocal-support'), reference: studio?.stabilize ? reference : undefined, tracks: pending, autoBalance: mode === 'vocal-instrumental' && stemAutoBalance.checked };
    if (fileMode) {
      if (!navigator.storage?.getDirectory || !navigator.locks) throw new Error('このブラウザでは長尺STEMの一時保存を利用できません。');
      element('stem-capacity').textContent = '長尺WAVを分割して合成します。合成上限は20分・512 MiBです。';
      pendingFile = new CandidateFile();
      const destination = await pendingFile.handle;
      if (id === generation) ready.postMessage({ ...request, kind: 'file-stems', destination });
    } else ready.postMessage({ ...request, kind: studio || clarity ? 'file-stems' : 'stems-import' });
  } catch (error) { fail(error instanceof Error ? error.message : 'STEMの読み込みに失敗しました。', id, true); }
}
function restartQueuedStems(): void {
  worker?.terminate(); worker = undefined;
  void assembleStems(stemEntries, stemMode.value as StemMode);
}
const stemInput = element<HTMLInputElement>('stem-file-input'), stemZone = element('stem-dropzone');
stemInput.addEventListener('change', () => { const files = Array.from(stemInput.files ?? []); if (files.length) void addStemFiles(files); stemInput.value = ''; });
stemZone.addEventListener('dragover', e => { e.preventDefault(); stemZone.classList.add('drag-over'); });
stemZone.addEventListener('dragleave', () => stemZone.classList.remove('drag-over'));
stemZone.addEventListener('drop', e => { e.preventDefault(); e.stopPropagation(); stemZone.classList.remove('drag-over'); const files = Array.from(e.dataTransfer?.files ?? []); if (files.length) void addStemFiles(files); });
element('stem-render').addEventListener('click', () => { if (!busy) void assembleStems(stemEntries, stemMode.value as StemMode); });
element('stem-clear').addEventListener('click', () => { if (!busy) { element<HTMLInputElement>('stem-reference').value = ''; stemEntries = []; renderStemList(); element('stem-status').textContent = '素材リストをクリアしました。現在のA/Bは保持しています。新しい素材を追加できます。'; } });
stemMode.addEventListener('change', () => { stemModeExplicit = true; element('stem-pair-inputs').hidden = stemMode.value !== 'vocal-instrumental'; element('stem-status').textContent = '素材の組み合わせを変更しました。読み込み済みの役割を確認して、ミックスを作り直してください。'; });
element('stem-vocal-support').addEventListener('change', () => { element('stem-status').textContent = '歌声の補助を変更しました。「ミックスを作り直す」で反映します。現在のA/Bは保持しています。'; });
element('stem-multitrack-auto').addEventListener('change', () => { element('stem-status').textContent = '自動ミックスの設定を変更しました。「ミックスを作り直す」で反映します。'; });
stemAutoBalance.addEventListener('change', () => { element('stem-status').textContent = '自動バランスの設定を変更しました。「ミックスを作り直す」で反映します。現在のA/Bは保持しています。'; });
for (const role of ['vocal', 'instrumental'] as const) {
  const zone = element(`stem-${role}-zone`), fileInput = element<HTMLInputElement>(`stem-${role}-input`);
  fileInput.addEventListener('change', () => { const files = Array.from(fileInput.files ?? []); if (files.length) void addStemFiles(files, role); fileInput.value = ''; });
  zone.addEventListener('dragover', event => event.preventDefault());
  zone.addEventListener('drop', event => { event.preventDefault(); event.stopPropagation(); const files = Array.from(event.dataTransfer?.files ?? []); if (files.length) void addStemFiles(files, role); });
}

function demo(compare: boolean): void {
  if (busy) return;
  const id = begin('a'), sampleRate = 48000, frames = sampleRate * 6;
  const channels = [new Float32Array(frames), new Float32Array(frames)];
  for (let i = 0; i < frames; i++) {
    const t = i / sampleRate, envelope = Math.min(1, t * 4, (6 - t) * 4) * (0.65 + 0.35 * Math.sin(t * Math.PI) ** 2);
    channels[0][i] = envelope * (0.18 * Math.sin(2 * Math.PI * 220 * t) + 0.065 * Math.sin(2 * Math.PI * 440 * t));
    channels[1][i] = envelope * (0.18 * Math.sin(2 * Math.PI * 220 * t) + 0.065 * Math.sin(2 * Math.PI * 330 * t));
  }
  startWorker(id, 'a', 'Music Sync · Stereo study.wav', { audio: { sampleRate, channels } }, channels.map(c => c.buffer), compare ? () => {
    const channels = sources.a!.audio!.channels.map(c => Float32Array.from(c, x => x * 2));
    startWorker(begin('b'), 'b', 'Stereo study · +6 dB demo.wav', { audio: { sampleRate, channels } }, channels.map(c => c.buffer));
  } : undefined);
}
demoButton.addEventListener('click', () => demo(false));
element('compare-demo-button').addEventListener('click', () => demo(true));
for (const slot of ['a', 'b'] as const) element(`select-${slot}`).addEventListener('click', () => {
  if (busy || !sources[slot]) return;
  selected = slot; updateComparison(); showResult();
});
matchToggle.addEventListener('change', () => {
  matched = !!plan?.match.available && matchToggle.checked; updateComparison();
});
element('clear-b').addEventListener('click', () => {
  if (busy) return;
  discardAcceptedFile();
  delete sources.b; selected = 'a'; plan = undefined; matched = false;
  element('preferences-result').textContent = '選択後、AUTOなどを押すと適用します。現在のBにはまだ適用していません。';
  element('master-outcome').textContent = '';
  finishReport = undefined; colorReport = undefined; element('live-result').textContent = '原音へ戻しました。選択中の会場感はまだ適用していません。'; element('sound-color-result').textContent = '原音へ戻しました。選択中の音色はまだ適用していません。'; element('finish-explanation').textContent = '原音へ戻しました。いつでも別のモードで作り直せます。'; element('finish-details').textContent = '';
  rebuildPlayer(); setBusy(false); showResult();
});
playButton.addEventListener('click', () => void togglePlayback());
stopButton.addEventListener('click', () => { player?.stop(); paint(); });
cancelButton.addEventListener('click', cancel);
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && busy) { event.preventDefault(); cancel(); }
});
seek.addEventListener('input', () => {
  if (busy || !sources.a) return;
  const seconds = Number(seek.value);
  void getPlayer().seek(seconds).then(paint).catch(() => showError('再生位置を変更できませんでした。'));
});
element<HTMLInputElement>('volume').addEventListener('input', configurePlayer);
exportButton.addEventListener('click', () => {
  const result = sources[selected]?.result;
  if (!result) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = 'music-sync-analysis.json'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

function readChain(): ProcessingChain {
  const number = (id: string) => {
    const field = element<HTMLInputElement>(id);
    if (!field.value.trim() || !field.checkValidity()) throw new Error('DSP設定の数値と範囲を確認してください。');
    return Number(field.value);
  };
  return { version: 1, bypass: element<HTMLInputElement>('dsp-bypass').checked, gainDb: number('dsp-gain'),
    eq: { enabled: element<HTMLInputElement>('eq-enabled').checked, frequencyHz: number('eq-frequency'), gainDb: number('eq-gain'), q: number('eq-q') },
    limiter: { enabled: element<HTMLInputElement>('limiter-enabled').checked, ceilingDb: number('limiter-ceiling'), releaseMs: number('limiter-release') } };
}
function readMasteringOptions(): MasteringOptions {
  const number = (id: string) => {
    const input = element<HTMLInputElement>(id);
    if (!input.value.trim() || !input.checkValidity()) throw new Error('目標LUFSとピーク上限の数値・範囲を確認してください。');
    return Number(input.value);
  };
  return { targetLufs: number('master-target'), ceilingDb: number('master-ceiling') };
}
function updateMasteringPlan(): void {
  const button = element<HTMLButtonElement>('master-button'), text = element('master-plan');
  button.disabled = true;
  if (!sources.a?.audio) { text.textContent = sources.a?.file ? '長尺WAVはメイン画面のモードと出力先で仕上げます。' : 'Aを読み込むと補正案が表示されます。'; return; }
  try {
    const proposed = planMastering(sources.a.result, readMasteringOptions());
    text.textContent = proposed.available
      ? `補正案：${proposed.chain.bypass ? '目標範囲内のため変更なし' : `ゲイン ${proposed.chain.gainDb.toFixed(1)} dB、左右連動リミッター`}。目標 ${proposed.options.targetLufs} LUFS / 推定ピーク上限 ${proposed.options.ceilingDb} dB。EQは変更しません。`
      : proposed.reasons.join(' ');
    button.disabled = busy || !proposed.available;
  } catch (error) { text.textContent = error instanceof Error ? error.message : '設定を確認してください。'; }
}
const checked = (id: string) => element<HTMLInputElement>(id).checked;
function studioNumber(id: string) {
  const field = element<HTMLInputElement>(id);
  if (!field.validity.valid || !Number.isFinite(field.valueAsNumber)) throw new Error((field.labels?.[0]?.textContent ?? id) + ' の入力値を確認してください。');
  return field.valueAsNumber;
}
function repairControls(): RepairControls {
  return { grain: element<HTMLSelectElement>('grain-mode').value as RepairControls['grain'],
    amount: studioNumber('grain-amount'), repeatGrain: checked('grain-repeat'), hissHz: studioNumber('hiss-hz'), hissDb: checked('hiss-enabled') ? studioNumber('hiss-db') : 0,
    clarityDb: checked('clarity-enabled') ? studioNumber('clarity-db') : 0, autoClarity: checked('clarity-auto') };
}
function stemStudio(): StemStudioSettings | undefined {
  const restore = checked('studio-restore'), double = checked('guitar-double'), stabilize = checked('stem-stabilize');
  if (!restore && !double && !stabilize) return undefined;
  const repair = restore ? repairControls() : {};
  if (restore && (!repair.grain || repair.grain === 'off')) repair.grain = 'strong';
  return { restore, repair, treble: trebleSelection(), doubleMs: studioNumber('double-ms'), doubleAmount: double ? studioNumber('double-amount') : 0,
    stabilize: stabilize ? { sensitivityDb: studioNumber('ref-sense'), repairMs: studioNumber('ref-duration'), maxDb: studioNumber('ref-max'),
      percent: studioNumber('ref-percent'), toleranceDb: studioNumber('ref-tolerance') } : undefined };
}
for (const id of ['double-amount','grain-amount','master-aggression']) {
  const field = element<HTMLInputElement>(id);
  field.addEventListener('input', () => { document.querySelector<HTMLOutputElement>('output[for="' + id + '"]')!.value = field.value; });
}
let acceptedFinishSettings: string | undefined;
function finishSettingsSnapshot() {
  const fields = document.querySelectorAll<HTMLInputElement | HTMLSelectElement>('#output-profile, #finish-preferences input, #finish-preferences select, #sound-color-settings select, #live-settings select');
  return JSON.stringify([autoMode, referenceWorkspace.signature(), ...Array.from(fields, field => [field.id, field.value, field instanceof HTMLInputElement ? field.checked : undefined])]);
}
function updatePendingFinishSettings() {
  const note = element('finish-settings-status');
  note.hidden = !sources.b || !acceptedFinishSettings || acceptedFinishSettings === finishSettingsSnapshot();
  note.textContent = '設定を変更しました。「この調整で仕上げる」を押すと、新しいBに反映します。';
}
for (const id of ['finish-preferences', 'sound-color-settings', 'live-settings']) {
  element(id).addEventListener('input', updatePendingFinishSettings);
  element(id).addEventListener('change', updatePendingFinishSettings);
}
function setAcceptedFinishSettings(snapshot?: string) {
  acceptedFinishSettings = snapshot; updatePendingFinishSettings();
}
function trebleSelection(): TrebleMode { return element<HTMLSelectElement>('treble-repair').value as TrebleMode; }
async function finishLong(file: File, before: AnalysisResult, name: string, sourceMix?: StemMixReport, downloadOnSuccess = false): Promise<void> {
  const id = ++generation, mode = autoMode, live = liveSelection(), preferences = finishingPreferences(), output = preferences.output;
  const requestedReference=referenceWorkspace.selection();
  const requestedSettings = finishSettingsSnapshot();
  let downloadInitiated = false;
  player?.setSources({}, 0); errorBox.hidden = true; setBusy(true); setProgress(0);
  setStatus('仕上がり候補の一時ファイルを準備しています…');
  try {
    if (!navigator.storage?.getDirectory) throw new Error('このブラウザでは仕上がり候補の一時保存を利用できません。');
    const temp = new CandidateFile(); pendingFile = temp;
    const destination = await temp.handle;
    if (id !== generation) return;
    const ready = await openAudioWorker('processing', new URL(processingWorkerUrl, document.baseURI));
    if (id !== generation) { ready.terminate(); return; }
    worker = ready;
    ready.onerror = () => fail('長尺WAVの処理が停止しました。', id, true);
    ready.onmessage = ({ data }) => {
      if (id !== generation) return;
      if (data.type === 'progress') {
        setProgress(data.fraction);
        setStatus(({ Readjusting: '測定結果に合わせて弱めに再調整しています', 'Grain analysis': '声や楽器に重なるジャリつきをスペクトル補修しています', 'Treble analysis': 'ざらつきが続く箇所を調べています', 'Treble evaluation': '高域の補修効果と明瞭さを確認しています', Analyzing: '補正後の曲全体を測定中', 'Creating candidate': '候補WAVを作成中', Evaluating: '保存した候補を再解析中' } as Record<string,string>)[data.stage] ?? data.stage ?? '音源を処理しています…');
        return;
      }
      if (data.type !== 'long-result') { fail(data.message ?? '長尺WAVの候補を作成できませんでした。', id, true); return; }
      try {
        const comparison = createComparisonPlan(before, data.result);
        discardAcceptedFile(); acceptedFile = temp; pendingFile = undefined;
        const acceptedSource: Source = { file: data.file, result: data.result, name: name.replace(/\.wav$/i, '') + '-' + mode + '.wav' };
        sources.b = acceptedSource;
        plan = comparison; selected = 'b'; matched = comparison.match.available;
        finishReport = undefined; colorReport = undefined;
        element('finish-details').textContent = JSON.stringify({ mode, gainDb: data.gainDb, target: data.target, grain: data.grain, repair: data.repair, preferences: data.preferences, reference:data.reference, differenceDb: data.differenceDb }, null, 2);
        ready.terminate(); worker = undefined; rebuildPlayer(); setBusy(false); showResult();
        element('finish-explanation').textContent = mode + 'の候補を用意しました。' + data.explanations.join(' ') + '曲全体の音量を ' + data.gainDb.toFixed(1) + ' dB 調整しました。';
        const applied = (Object.keys(DEFAULT_FINISH_CONTROLS) as (keyof FinishControls)[]).filter(key => data.preferences?.appliedControls[key]).map(key => FINISH_CONTROL_LABELS[key]);
        element('preferences-result').textContent = OUTPUT_PROFILES[output].label + '：目標 ' + data.target.toFixed(1) + ' LUFS、実測 ' + data.result.integratedLufs.toFixed(1) + ' LUFS。' +
          (applied.length ? '適用済み：' + applied.join('・') + '。' : '') + (data.preferences?.strength < 1 ? '測定条件に合わせて調整量を弱めました。' : '') + (data.preferences?.skipped.join(' ') ?? '');
        element('finish-applied-summary').textContent = describeFinishingChange(before.durationSeconds, data.repair, data.toneApplied, data.grain);
        element('reference-result').textContent=data.reference ? [...data.reference.explanations,...data.reference.reasons].join(' ') : '';
        setAcceptedFinishSettings(requestedSettings);
        setStatus('長尺WAVの仕上げが完了しました。音量をそろえて比較してから保存できます。');
        if (!downloadOnSuccess) sounds.success();
        if (downloadOnSuccess && !downloadInitiated && id === generation && sources.b === acceptedSource) {
          downloadInitiated = true;
          void runProcessing('export', { downloadOnSuccess: true });
        }
      } catch (error) { fail(String(error), id, true); }
    };
    ready.postMessage({ kind: 'long-render', reference:requestedReference, sourceMix, controls: preferences.controls, repairControls: repairControls(), aggression: studioNumber('master-aggression'), treble: trebleSelection(), file, destination, before, mode, live, output });
  } catch (error) { fail(error instanceof Error ? error.message : '候補を一時保存できません。', id, true); }
}



async function readSoundReference(file:File,signal:AbortSignal):Promise<{profile:ReferenceProfile;result:AnalysisResult}> {
  signal.throwIfAborted();
  if(!file.size||!/\.(wav|flac)$/i.test(file.name))throw new Error('参考曲は空でないWAV / FLACを選んでください。');
  let audio:AudioData|undefined;
  if(/\.flac$/i.test(file.name)){
    if(file.size>LIMITS.maxFileBytes)throw new Error('参考曲のFLACは100 MiB以内にしてください。');
    await waitForFlacSlot(signal);signal.throwIfAborted();
    const buffer=await file.arrayBuffer();signal.throwIfAborted();
    const decoding=decodeFlac(buffer,AUTO_ENGINE_LIMITS.maxInputBytes);
    flacDecodeInFlight=decoding.then(()=>undefined,()=>undefined);audio=await decoding;
  }
  signal.throwIfAborted();
  const result=await sessionWorkerTask('analysis',audio?{audio,reference:true}:{file,reference:true},signal,audio?audio.channels.map(channel=>channel.buffer as ArrayBuffer):[]);
  signal.throwIfAborted();
  if(result.type!=='reference-result'||!result.profile)throw new Error('参考曲の解析を完了できませんでした。');
  return {profile:result.profile as ReferenceProfile,result:result.result as AnalysisResult};
}
async function loadSoundReference(file:File) {
  if(busy)return;
  const id=++generation,controller=new AbortController();sessionAbort=controller;
  player?.pause();paint();setBusy(true);errorBox.hidden=true;setStatus('参考曲の音色・低域・密度を調べています…');
  try{
    const result=await readSoundReference(file,controller.signal);
    if(id!==generation)return;
    sessionAbort=undefined;setBusy(false);sounds.success();setStatus('参考曲の解析が完了しました。現在のOriginalとProcessedは保持しています。');
    return result;
  }catch(error){
    if(id===generation){sessionAbort=undefined;fail(error instanceof Error?error.message:'参考曲を読み込めませんでした。',id,true);}
  }
}
async function previewBatch(value:BatchPreview) {
  const signal=sessionAbort?.signal;if(!signal)throw new Error('比較の準備を開始できません。');
  const comparison=createComparisonPlan(value.before,value.after);
  const raw=new CandidateFile(),finished=new CandidateFile();
  let committed=false;
  try{
    for(const [file,target] of [[value.original,raw],[value.processed,finished]] as const){
      signal.throwIfAborted();const handle=await target.handle;signal.throwIfAborted();
      await file.stream().pipeTo(await handle.createWritable(),{signal});
    }
    const originalFile=await(await raw.handle).getFile(),processedFile=await(await finished.handle).getFile();
    if(originalFile.size!==value.original.size||processedFile.size!==value.processed.size)throw new Error('比較用音源の保存サイズが一致しません。');
    signal.throwIfAborted();
    const oldMix=mixFile,oldAccepted=acceptedFile;
    stemAudition.set();stemSolo.close();
    mixFile=raw;acceptedFile=finished;committed=true;
    sources.a={file:originalFile,result:value.before,name:value.name,originalFile:value.originalFile};
    sources.b={file:processedFile,result:value.after,name:value.name.replace(/\.(wav|flac)$/i,'')+'-finished.wav'};
    stemEntries=[];committedStemInputs=[];committedStemStudio=undefined;committedStemOptions=undefined;restoredStemNeedsRebuild=false;
    element<HTMLInputElement>('stem-reference').value='';renderStemList();
    selected='b';plan=comparison;matched=comparison.match.available;finishReport=undefined;colorReport=undefined;setAcceptedFinishSettings();
    element('finish-explanation').textContent='一括仕上げの候補を読み込みました。Original / Processedを音量をそろえて比較できます。 '+(value.notes??[]).join(' ');
    element('finish-details').textContent=JSON.stringify({workflow:'batch',explanations:value.notes??[],before:value.before,after:value.after},null,2);element('finish-applied-summary').textContent='';element('reference-result').textContent='';
    element('master-outcome').textContent='';element('live-result').textContent='一括仕上げで採用した候補です。処理内容は仕上げの説明に表示しています。';element('sound-color-result').textContent='一括仕上げで採用した候補です。';
    element('stem-status').textContent='完成曲を一括仕上げから読み込みました。新しいSTEMは別途追加できます。';element('input-capacity').textContent='一括仕上げで選んだ曲をファイルとして保持しています。原音と仕上がりを比較し、別の候補も作れます。';
    element('preferences-result').textContent='一括仕上げで採用した音声です。各曲の共通音量は一括処理の一覧に表示しています。';
    rebuildPlayer();showResult();void oldMix?.discard();void oldAccepted?.discard();
    element('comparison-heading').scrollIntoView({block:'start'});
  }finally{if(!committed){void raw.discard();void finished.discard();}}
}

const sessionControlSelector = '#output-profile, #finish-preferences input, #finish-preferences select, #sound-color-settings select, #live-settings select, #dsp-settings input, #dsp-settings select, #master-settings input, #stem-settings input, #stem-settings select, #volume';
function sessionFields() {
  return Array.from(document.querySelectorAll<HTMLInputElement|HTMLSelectElement>(sessionControlSelector))
    .filter(field=>field.id && !(field instanceof HTMLInputElement && field.type==='file'));
}
function sessionControls() {
  return Object.fromEntries(sessionFields().map(field=>[field.id,field instanceof HTMLInputElement&&field.type==='checkbox'?field.checked:field.value]));
}
function validateSessionControls(values:Record<string,string|boolean>) {
  if(!values||typeof values!=='object'||Array.isArray(values))throw new Error('プロジェクトの設定が不正です。');
  const fields=new Map(sessionFields().map(field=>[field.id,field]));
  if(Object.keys(values).length!==fields.size||Array.from(fields.keys()).some(id=>!Object.hasOwn(values,id)))throw new Error('プロジェクトの設定が不足しています。');
  for(const [id,value] of Object.entries(values)) {
    const field=fields.get(id);if(!field)throw new Error('対応していないプロジェクト設定です：'+id);
    if(field instanceof HTMLSelectElement) {
      if(typeof value!=='string'||!Array.from(field.options).some(option=>option.value===value))throw new Error('選択設定が不正です：'+id);
    }else if(field.type==='checkbox') {if(typeof value!=='boolean')throw new Error('ON/OFF設定が不正です：'+id);}
    else {
      if(typeof value!=='string'||value.length>1000)throw new Error('入力設定が不正です：'+id);
      if(['number','range'].includes(field.type)) {
        const probe=field.cloneNode(false) as HTMLInputElement;probe.disabled=false;probe.value=value;
        if(!value.trim()||probe.value!==value||!Number.isFinite(probe.valueAsNumber)||!probe.checkValidity())throw new Error('設定が範囲外です：'+id);
      }
    }
  }
}
async function sessionWorkerTask(kind:'project'|'analysis',message:unknown,signal:AbortSignal,transfer:Transferable[]=[]):Promise<Record<string,unknown>> {
  signal.throwIfAborted();
  const ready=await openAudioWorker(kind,new URL(kind==='project'?projectWorkerUrl:analysisWorkerUrl,document.baseURI));
  if(signal.aborted){ready.terminate();signal.throwIfAborted();}
  worker=ready;
  return new Promise((resolve,reject)=>{
    const cleanup=()=>{signal.removeEventListener('abort',aborted);ready.terminate();if(worker===ready)worker=undefined;};
    const aborted=()=>{cleanup();reject(new DOMException('Cancelled','AbortError'));};
    signal.addEventListener('abort',aborted,{once:true});
    ready.onerror=()=>{cleanup();reject(new Error('プロジェクトの処理が停止しました。現在の作業は保持しています。'));};
    ready.onmessage=({data})=>{
      if(data.type==='progress'){setProgress(data.fraction);setStatus(data.text??'音声を再解析しています…');return;}
      cleanup();
      if(data.type==='error')reject(new Error(data.message));else resolve(data);
    };
    ready.postMessage(message,transfer);
  });
}
async function inspectSessionAudio(input:SessionInspectionInput,options:{signal?:AbortSignal;progress?:(fraction:number,text?:string)=>void;retainAudio:boolean}) {
  const signal=options.signal??new AbortController().signal;
  let audio:AudioData|undefined;
  if(input.kind==='planar') {
    const channels:Float32Array[]=[];
    for(const plane of input.planes){signal.throwIfAborted();channels.push(new Float32Array(await plane.arrayBuffer()));}
    audio={sampleRate:input.sampleRate,channels};
  }else if(/\.flac$/i.test(input.file.name)) {
    await waitForFlacSlot(signal);signal.throwIfAborted();
    const decoding=decodeFlac(await input.file.arrayBuffer(),STEM_LIMITS.maxBusBytes);
    flacDecodeInFlight=decoding.then(()=>undefined,()=>undefined);audio=await decoding;
  }
  signal.throwIfAborted();
  const result=await sessionWorkerTask('analysis',audio?{audio}:{file:(input as {file:File}).file},signal,audio?audio.channels.map(channel=>channel.buffer as ArrayBuffer):[]);
  signal.throwIfAborted();
  return {result:result.result as AnalysisResult,...(audio&&options.retainAudio?{audio:result.audio as AudioData}:input.kind==='file'?{file:input.file}:{})};
}
const savedExplanationIds=['reference-result','finish-explanation','finish-details','finish-applied-summary','preferences-result','live-result','sound-color-result','master-outcome'];
function captureSession():SessionCaptureInput {
  validateSessionControls(sessionControls());
  return {name:element<HTMLInputElement>('project-name').value,sources,stems:stemEntries,committedStemInputs,committedStemStudio,committedStemOptions,
    autoMode,reference:element<HTMLInputElement>('stem-reference').files?.[0],controls:sessionControls(),exportSettings:exportSettings.state(),artwork:exportSettings.artwork(),
    selected,matched,position:player?.positionSeconds??0,acceptedFinishSettings,stemModeExplicit,stemMode:stemMode.value as StemMode,
    soundReference:referenceWorkspace.state(),explanations:Object.fromEntries(savedExplanationIds.map(id=>[id,element(id).textContent??'']))};
}
async function saveProjectSession() {
  if(busy||!sources.a)return;
  let captured:ReturnType<typeof captureProjectSession>;
  try{captured=captureProjectSession(captureSession());}catch(error){showError(error instanceof Error?error.message:String(error));return;}
  const id=++generation,controller=new AbortController();sessionAbort=controller;
  player?.pause();paint();errorBox.hidden=true;setBusy(true);setStatus('素材と現在のA/Bをプロジェクトにまとめています…');
  let temporary:CandidateFile|undefined;
  try{
    let destination:FileSystemFileHandle|undefined;
    if(typeof navigator.storage?.getDirectory==='function'&&navigator.locks){temporary=new CandidateFile();pendingFile=temporary;destination=await temporary.handle;}
    controller.signal.throwIfAborted();
    const result=await sessionWorkerTask('project',{kind:'project-export',...captured,destination},controller.signal);
    if(id!==generation)return;
    const blob=(result.file??result.blob) as Blob;
    if(!(blob instanceof Blob))throw new Error('プロジェクトを作成できませんでした。');
    const savedTemp=temporary;pendingFile=undefined;temporary=undefined;
    downloadBlob(blob,safeDownloadName(element<HTMLInputElement>('project-name').value+'.musicsync','zip'),()=>{void savedTemp?.discard();});
    sessionAbort=undefined;setBusy(false);sounds.success();
    element('project-status').textContent='プロジェクトの保存を開始しました。素材・設定・現在のA/B・曲情報を含みます。';
    setStatus('プロジェクトの保存を開始しました。ダウンロード一覧を確認してください。');
  }catch(error){void temporary?.discard();if(id===generation){sessionAbort=undefined;fail(error instanceof Error?error.message:'プロジェクトを保存できませんでした。',id,true);}}
}
async function openProjectSession(file:File) {
  if(busy)return;
  const id=++generation,controller=new AbortController();sessionAbort=controller;
  player?.pause();paint();errorBox.hidden=true;setBusy(true);setStatus('プロジェクトの内容を検証しています…');
  try{
    const imported=await sessionWorkerTask('project',{kind:'project-import',file},controller.signal);
    const restored=await restoreProjectSession({manifest:imported.manifest as ProjectManifest,assets:new Map(imported.assetEntries as [string,File][])},{
      signal:controller.signal,inspect:inspectSessionAudio,
      progress:(fraction,text)=>{setProgress(fraction);setStatus(text);},
      validateSettings:settings=>{validateSessionControls(settings.controls);if(settings.controls['stem-mode']!==settings.stemMode)throw new Error('素材の組み合わせ設定が一致しません。');},
    });
    controller.signal.throwIfAborted();if(id!==generation)return;
    const restoredReference=restored.soundReference?await readSoundReference(restored.soundReference.file,controller.signal):undefined;
    controller.signal.throwIfAborted();
    const nextPlan=restored.sources.a&&restored.sources.b?createComparisonPlan(restored.sources.a.result,restored.sources.b.result):undefined;
    let referenceTransfer:DataTransfer|undefined;
    if(restored.reference){referenceTransfer=new DataTransfer();referenceTransfer.items.add(restored.reference);}
    // Validate cover and all export settings before touching current audio or STEM state.
    await exportSettings.restore(restored.exportSettings,restored.artwork,controller.signal);
    controller.signal.throwIfAborted();if(id!==generation)return;
    referenceWorkspace.commit(restored.soundReference?.file,restoredReference?.profile,restored.soundReference?.enabled??true,restored.soundReference?.strength??.65);
    stemAudition.set();stemSolo.close();discardAcceptedFile();void mixFile?.discard();mixFile=undefined;
    sources.a=restored.sources.a;delete sources.b;if(restored.sources.b)sources.b=restored.sources.b;
    stemEntries=restored.stems;committedStemInputs=restored.committedStemInputs;
    committedStemStudio=restored.committedStemStudio;committedStemOptions=restored.committedStemOptions;
    restoredStemNeedsRebuild=!!committedStemStudio?.restore&&!!sources.a?.stemMix;
    stemNextId=Math.max(stemNextId,...stemEntries.map(entry=>Number(entry.id.replace(/\D/g,''))||0));
    stemModeExplicit=restored.stemModeExplicit;autoMode=restored.autoMode;
    for(const field of sessionFields()){
      const value=restored.controls[field.id];if(value===undefined)continue;
      if(field instanceof HTMLInputElement&&field.type==='checkbox')field.checked=value as boolean;else field.value=value as string;
    }
    stemMode.value=restored.stemMode;element('stem-pair-inputs').hidden=stemMode.value!=='vocal-instrumental';
    const ref=element<HTMLInputElement>('stem-reference');ref.value='';
    if(referenceTransfer)ref.files=referenceTransfer.files;
    for(const input of sessionFields())if(input instanceof HTMLInputElement&&input.type==='range')input.dispatchEvent(new Event('input'));
    selected=restored.selected;plan=nextPlan;
    matched=restored.matched&&!!plan?.match.available;
    finishReport=undefined;colorReport=undefined;
    for(const key of savedExplanationIds)element(key).textContent=restored.explanations?.[key]??'';
    element<HTMLInputElement>('project-name').value=restored.name;
    updateOutputProfile();updateColorSelection();updateLiveSelection();renderStemList();setAcceptedFinishSettings(restored.acceptedFinishSettings);
    sessionAbort=undefined;setBusy(false);rebuildPlayer();showResult();
    void getPlayer().seek(Math.min(restored.position,duration())).then(paint).catch(()=>{});
    sounds.success();
    element('project-status').textContent='プロジェクトを復元しました。現在のA/Bと素材を再解析し、設定・曲情報・ジャケットを読み込みました。';
    element('stem-status').textContent=stemEntries.length?stemEntries.length+'素材を復元しました。素材を1つずつ聴く・ミックスの作り直しができます。':'単体音源のプロジェクトを復元しました。';
    setStatus('プロジェクトの復元が完了しました。再生・比較・書き出しを続けられます。');
  }catch(error){if(id===generation){sessionAbort=undefined;fail(error instanceof Error?error.message:'プロジェクトを開けませんでした。',id,true);element('project-status').textContent='プロジェクトを開けませんでした。現在のA/Bと素材は保持しています。';}}
}
element('project-save').addEventListener('click',()=>void saveProjectSession());
element<HTMLInputElement>('project-open').addEventListener('change',event=>{const input=event.currentTarget as HTMLInputElement;const file=input.files?.[0];input.value='';if(file)void openProjectSession(file);});

function downloadBlob(blob:Blob,name:string,onRelease?:()=>void) {
  const url=URL.createObjectURL(blob);
  try {const link=document.createElement('a');link.href=url;link.download=name;link.click();}
  catch(error){URL.revokeObjectURL(url);onRelease?.();throw error;}
  setTimeout(()=>{URL.revokeObjectURL(url);onRelease?.();},60000);
}
function safeDownloadName(name:string,extension:string) {
  const clean=name.replace(/\.(wav|flac|mp3|zip)$/i,'').replace(/[<>:"/\\|?*]/g,'_').split('').map(char=>char.charCodeAt(0)<32?'_':char).join('').trim().slice(0,140);
  return (clean||'MusicSync')+'.'+extension;
}
async function exportCurrentAudio(easy=false):Promise<void> {
  const source=sources.b;if(busy||!source)return;
  let options:ReturnType<typeof exportSettings.options>;
  try{options=exportSettings.options();}catch(error){showError(String(error));return;}
  const id=++generation;
  worker?.terminate();player?.pause();paint();setBusy(true);errorBox.hidden=true;
  setStatus(options.format==='mp3'?'MP3と曲情報・ジャケットを準備しています…':'選択した音質でWAVを準備しています…');
  if(easy)setEasyStatus('品質条件を通過した仕上がりを保存用にまとめています…');
  try{
    const ready=await openAudioWorker('export',new URL(audioExportWorkerUrl,document.baseURI));
    if(id!==generation){ready.terminate();return;}
    worker=ready;
    ready.onerror=()=>fail('書き出しが停止しました。Bは保持しています。',id,true);
    ready.onmessage=({data})=>{
      if(id!==generation)return;
      if(data.type==='progress'){setProgress(data.fraction);setStatus(data.text);return;}
      if(data.type==='error'){fail(data.message,id,true);return;}
      if(data.type!=='audio-export-result')return;
      try{
        if(sources.b!==source)throw new Error('仕上がりが変わったため保存を中止しました。');
        const result=data as AudioExportResult;
        downloadBlob(result.blob,safeDownloadName(options.metadata?.title||source.name,result.extension));
        worker?.terminate();worker=undefined;setBusy(false);sounds.success();
        const message=(result.extension==='mp3'?'MP3':'WAV')+'の保存を開始しました。ブラウザのダウンロード一覧を確認してください。';
        setStatus(message);if(easy)setEasyStatus(message);
        element('audio-export-status').textContent=message+' '+(result.sampleRate/1000)+' kHz'+(result.bitrate?' / '+result.bitrate+' kbps':'')+'。試聴音量・ラウドネスマッチ・SEは含みません。';
      }catch(error){fail(error instanceof Error?error.message:'音声を保存できませんでした。',id,true);}
    };
    ready.postMessage({kind:'audio-export',source:source.file?{file:source.file}:{audio:source.audio},options});
  }catch(error){fail(error instanceof Error?error.message:'書き出しを開始できませんでした。',id,true);}
}

type ProcessingRunOptions = { downloadOnSuccess?: boolean };
async function runProcessing(kind: 'process' | 'master' | 'auto' | 'color' | 'export', runOptions: ProcessingRunOptions = {}): Promise<void> {
  if (busy) return;
  if (kind === 'export') { await exportCurrentAudio(runOptions.downloadOnSuccess === true); return; }
  if(kind==='auto'&&restoredStemNeedsRebuild){
    await assembleStems(stemEntries,stemMode.value as StemMode,()=>{void runProcessing('auto',runOptions);});return;
  }
  // Intent belongs to this operation's closure; stale/cancelled generations cannot save an old B.
  const downloadAfter = kind === 'auto' && runOptions.downloadOnSuccess === true;
  const preparationError = (message: string) => { showError(message); if (downloadAfter) setEasyStatus('自動保存は行っていません。' + message); };
  const source = sources.a;
  const requestedSettings = finishSettingsSnapshot();
  const requestedReference=referenceWorkspace.selection();
  let studioFinish;
  if (kind === 'auto') {
    try { studioFinish = { repairControls: repairControls(), aggression: studioNumber('master-aggression') }; }
    catch (error) { preparationError(String(error)); return; }
  }
  if (source?.file && kind === 'auto') {
    if (source.stemMix?.tracks.some(t => !t.descriptor.muted && t.analysis.clippedSamples > 0)) {
      preparationError('元素材にクリッピングがあります。該当する素材の録音レベルを確認してください。'); return;
    }
    await finishLong(source.file, source.result, source.name, source.stemMix, downloadAfter); return; }
  if (!source?.audio) {
    if (downloadAfter) preparationError('仕上げる音源がありません。音源を読み込んでください。');
    return;
  }
  let chain: ProcessingChain | undefined;
  let options: MasteringOptions | undefined;
  try {
      if (kind === 'process') { chain = readChain(); validateProcessingChain(chain, source.audio.sampleRate); }
      else if (kind === 'master') {
        options = readMasteringOptions();
        const proposed = planMastering(source.result, options);
        if (!proposed.available) throw new Error(proposed.reasons.join(' '));
      }
      const bytes = source.audio.channels[0].byteLength * source.audio.channels.length;
      if (bytes * 2 > LIMITS.maxDecodedBytes) throw new Error('Aと処理後Bの合計が192 MiBを超えます。Aを96 MiB以内に分割してください。');
      if (kind === 'auto' && bytes > AUTO_ENGINE_LIMITS.maxInputBytes) throw new Error('自動仕上げは展開後96 MiBまでです。曲を短く分割してお試しください。');
  } catch (error) { preparationError(error instanceof Error ? error.message : '設定を確認してください。'); return; }
  const id = ++generation;
  worker?.terminate(); player?.setSources({}, 0); paint(); errorBox.hidden = true;
  setBusy(true); setProgress(0);
  setStatus(kind === 'auto' ? 'Analyzing · 曲を調べています…' : kind === 'color' ? '音色の候補を生成・再解析しています… 原音と既存Bは保持しています。' : kind === 'master' ? '自動処理と品質確認中… Aと既存Bを保持しています。' : 'DSP処理中… Aは保持されます。');
  let ready: Worker;
  try { ready = await openAudioWorker('processing', new URL(processingWorkerUrl, document.baseURI)); }
  catch (error) { fail(error instanceof Error ? error.message : '仕上げ処理を開始できませんでした。', id, true); return; }
  if (id !== generation) { ready.terminate(); return; }
  worker = ready;
  worker.onmessage = (event: MessageEvent) => {
    if (id !== generation) return;
    const data = event.data;
    if (data.type === 'progress') {
      setProgress(data.fraction);
      if (data.stage) {
        const stages: Record<string, string> = { Analyzing: '曲を調べています', 'Creating candidate': '仕上がりの候補を作っています', Evaluating: '原音と比較し、問題がないか確認しています', Finalizing: '結果を準備しています' };
        setStatus(`${data.stage} · ${stages[data.stage] ?? ''}${data.iteration ? `（候補 ${data.iteration}/3）` : ''}`);
        element('finish-explanation').textContent = status.textContent;
      }
      return;
    }
    if (data.type === 'error') { fail(data.message, id, true); return; }
    let acceptedForDownload: Source | undefined;
    try {
      if (data.type === 'processed') {
        const nextPlan = createComparisonPlan(sources.a!.result, data.result);
        sources.b = { audio: data.audio, result: data.result, name: `${source.name.replace(/\.(wav|flac)$/i, '')} · ${data.finishing ? data.finishing.mode : data.mastering ? 'Master' : data.soundColor ? SOUND_COLOR_PRESETS[data.soundColor.selection.preset as SoundColorSelection['preset']].label : 'DSP'}.wav`,
          processing: { chain: data.chain, maxReductionDb: data.maxReductionDb, peakGuardDb: data.peakGuardDb } };
        plan = nextPlan; selected = 'b'; matched = !!(data.finishing || data.soundColor) && nextPlan.match.available;
        rebuildPlayer(); showResult();
        setStatus('DSP完了 · Bを再解析しました。A/B比較とWAV保存ができます。');
        element('master-outcome').textContent = data.mastering
          ? `採用：目標 ${data.mastering.plan.options.targetLufs} LUFS → 実測 ${data.result.integratedLufs.toFixed(2)} LUFS、推定ピーク ${data.result.truePeakDbtp.toFixed(2)} dBTP。品質条件を通過した結果をBに設定しました。${data.chain.bypass ? '変更なし（バイパス）。' : ''}` : '';
        if (data.mastering) setStatus('自動マスタリング完了 · Bを試聴して仕上がりを確認してください。');
        finishReport = data.finishing;
        element('reference-result').textContent=finishReport?.reference ? [...finishReport.reference.explanations,...finishReport.reference.reasons].join(' ') : '';
        setAcceptedFinishSettings(finishReport ? requestedSettings : undefined);
        element('finish-applied-summary').textContent = '';
        if (finishReport && sources.a?.stemMix) finishReport.sourceMix = sources.a.stemMix;
        const preferences = finishReport?.preferences;
        element('preferences-result').textContent = preferences
          ? `適用済み：${OUTPUT_PROFILES[preferences.selection.output].label}。目標 ${preferences.requestedLufs.toFixed(1)} LUFS → 実測 ${preferences.actualLufs!.toFixed(1)} LUFS。${preferences.explanations.join(' ')} 選択だけでは現在のBは変わりません。`
          : '今回のBには、追加の仕上がり調整と出力先の指定を適用していません。';
        colorReport = data.soundColor;
        element('sound-color-result').textContent = colorReport
          ? `適用済み：${SOUND_COLOR_PRESETS[colorReport.selection.preset].label}（${{ gentle: '控えめ', standard: '標準', vivid: 'はっきり' }[colorReport.selection.intensity]}）。${colorReport.explanations.join(' ')} 音量をそろえて聴き比べられます。`
          : '今回のBには音色・演出プリセットを適用していません。';
        if (finishReport) {
          const lastMix = finishReport.attempts.at(-1)?.mix;
          const hasTone = !!lastMix?.stages.some(stage => stage.kind !== 'dc') || !!finishReport.preferences?.attempts.at(-1)?.plan.stages.length || !!finishReport.soundColor;
          element('finish-applied-summary').textContent = describeFinishingChange(finishReport.before.durationSeconds, finishReport.treble, hasTone, finishReport.grain);
          const mix = finishReport.attempts.at(-1)?.mix, live = mix?.liveSelection;
          element('live-result').textContent = live ? `適用済み：${LIVE_SPACES[live.venue].label}（${{ gentle: '控えめ', standard: '標準', vivid: 'はっきり' }[live.intensity]}）。${mix!.strength < 1 ? '測定条件に合わせて効果を弱めて採用しました。' : '選んだ会場感で候補を用意しました。'} 原音と音量をそろえて比較できます。` : '今回のBにはLIVEの会場感を加えていません。';
          element('finish-explanation').textContent = `${finishReport.mode}の候補を用意しました。${finishReport.explanations.join(' ')} 音量をそろえて原音と比較できます。`;
          element('finish-details').textContent = formatFinishingDetails(finishReport!);
          setStatus('Finalizing · 完成候補を用意しました。Original / Processedで聴き比べてください。');
        } else if (colorReport) {
          element('live-result').textContent = '今回のBは音色処理のみです。LIVEの会場感は加えていません。';
          element('finish-explanation').textContent = `${SOUND_COLOR_PRESETS[colorReport.selection.preset].label}の候補を用意しました。原音と聴き比べてください。`;
          element('finish-details').textContent = JSON.stringify(colorReport, null, 2);
          setStatus('音色処理完了 · Original / Processedで聴き比べてください。');
        } else { element('live-result').textContent = '今回のBはAdvanced Settingsの処理結果です。'; element('finish-explanation').textContent = 'Advanced Settingsの処理結果をBに設定しました。'; element('finish-details').textContent = ''; }
        if (downloadAfter && data.finishing?.status === 'accepted') acceptedForDownload = sources.b;
      } else if (data.type === 'rejected') {
        if (data.finishing) {
          finishReport = data.finishing;
          if (finishReport && sources.a?.stemMix) finishReport.sourceMix = sources.a.stemMix;
          if (finishReport?.preferences) element('preferences-result').textContent = '選んだ仕上がり調整を安全に適用できませんでした。原音と既存Bを保持しています。';
          element('finish-explanation').textContent = `候補を採用しませんでした。${finishReport!.reasons.join(' ')} 原音と既存のProcessedは保持しています。`;
          element('finish-details').textContent = formatFinishingDetails(finishReport!);
        } else if (data.soundColor) {
          element('sound-color-result').textContent = `候補を採用しませんでした。${data.soundColor.reasons.join(' ')} 原音と既存Bは保持しています。`;
        } else {
        const after = data.mastering.after;
        element('master-outcome').textContent = `保留：${data.mastering.reasons.join(' ')}${after ? ` 候補の実測 ${formatMetric(after.integratedLufs)} LUFS / ${formatMetric(after.truePeakDbtp)} dBTP。` : ''} Aと既存Bは変更していません。`;
        }
        setStatus('品質条件を満たさないため、候補を採用しませんでした。');
        if (downloadAfter) setEasyStatus('品質条件を満たさないため、自動保存は行いませんでした。原音と既存の仕上がりを保持しています。');
      }
      worker?.terminate(); worker = undefined; rebuildPlayer(); setBusy(false);
      if (data.type === 'rejected') sounds.error(); else if (!acceptedForDownload) sounds.success();
      if (acceptedForDownload && id === generation && sources.b === acceptedForDownload)
        void runProcessing('export', { downloadOnSuccess: true });
    } catch (error) { fail(error instanceof Error ? error.message : '処理結果を準備できませんでした。', id, true); }
  };
  worker.onerror = event => {
    event.preventDefault();
    fail(`仕上げ処理が停止しました。原音は保持しています。${event.message ? ` 詳細：${event.message}` : '画面を再読み込みしてお試しください。'}`, id, true);
  };
  // Structured clone preserves the original source. Terminating the Worker cancels jobs.
  worker.postMessage({ kind, reference:kind==='auto'?requestedReference:undefined, ...(kind === 'auto' ? studioFinish : {}), treble: trebleSelection(), audio: source.audio, sourceMix: source.stemMix, chain, options, mode: autoMode, soundColor: colorSelection(), live: liveSelection(), preferences: finishingPreferences() });
}
outputProfile.addEventListener('change', () => { updateOutputProfile(); updatePendingFinishSettings(); });

function prepareEasyFinish() {
  // Reflect the actual beginner request in the visible controls and the accepted snapshot.
  const output = outputProfile.value;
  autoMode = 'AUTO';
  for (const key of Object.keys(DEFAULT_FINISH_CONTROLS)) element<HTMLSelectElement>('finish-' + key).value = '0';
  for (const field of element('studio-finish-controls').querySelectorAll('input')) {
    field.value = field.defaultValue; field.checked = field.defaultChecked; field.dispatchEvent(new Event('input'));
  }
  element<HTMLSelectElement>('treble-repair').value = 'auto';
  element<HTMLSelectElement>('grain-mode').value = 'off';
  colorSelect.value = 'none'; colorIntensity.value = 'standard';
  outputProfile.value = output;
  for (const mode of ['AUTO','IMPACT','LIVE']) element('mode-' + mode).setAttribute('aria-pressed', String(mode === 'AUTO'));
  updateOutputProfile(); updateColorSelection(); updatePendingFinishSettings();
}
easyFinishButton.addEventListener('click', () => {
  if (busy || !sources.a) return;
  const finishCommittedSource = () => {
    prepareEasyFinish();
    setEasyStatus('曲に必要な補正を選び、品質条件を確かめてからWAVの保存まで進みます…');
    void runProcessing('auto', { downloadOnSuccess: true });
  };
  let pendingStemChanges: boolean;
  try { pendingStemChanges=hasPendingStemInputs(); }
  catch(error){showError(error instanceof Error?error.message:'素材の設定を確認してください。');setEasyStatus('素材の設定を確認してから、もう一度お試しください。自動保存は行っていません。');return;}
  if (pendingStemChanges) {
    setEasyStatus('素材の変更を反映してミックスを作り直し、そのあと自動仕上げとWAV保存へ進みます…');
    // Only this exact successful rebuild may continue. Cancellation/failure and queued additions drop its callback.
    void assembleStems(stemEntries, stemMode.value as StemMode, finishCommittedSource);
  } else finishCommittedSource();
});
element('finish-preferences-apply').addEventListener('click', () => runProcessing('auto'));
element('finish-preferences-reset').addEventListener('click', () => {
  for (const id of Object.keys(DEFAULT_FINISH_CONTROLS)) element<HTMLSelectElement>(`finish-${id}`).value = '0';
  for (const field of element('studio-finish-controls').querySelectorAll('input')) {
    field.value = field.defaultValue; field.checked = field.defaultChecked; field.dispatchEvent(new Event('input'));
  }
  element<HTMLSelectElement>('grain-mode').value = 'off';
  element<HTMLSelectElement>('treble-repair').value = 'auto';
  outputProfile.value = 'auto'; updateOutputProfile();
  element('preferences-result').textContent = '調整をリセットしました。現在のBは保持しています。AUTOなどを押すと新しい設定で作り直します。';
  updatePendingFinishSettings();
});
element('sound-color-apply').addEventListener('click', () => runProcessing('color'));
colorSelect.addEventListener('change', updateColorSelection);
colorIntensity.addEventListener('change', updateColorSelection);
updateColorSelection();
element('live-venue').addEventListener('change', updateLiveSelection);
element('live-intensity').addEventListener('change', updateLiveSelection);
updateLiveSelection();
element('process-button').addEventListener('click', () => runProcessing('process'));
element('wav-button').addEventListener('click', () => runProcessing('export'));
element('master-button').addEventListener('click', () => runProcessing('master'));
element('master-settings').addEventListener('input', updateMasteringPlan);
for (const mode of ['AUTO', 'IMPACT', 'LIVE'] as const) element(`mode-${mode}`).addEventListener('click', () => {
  if (importingSingle || stemImportActive) return;
  if (!sources.a) return;
  if (busy) cancel();
  autoMode = mode; runProcessing('auto');
});
element('clear-b').addEventListener('click', () => { setAcceptedFinishSettings(); element('finish-applied-summary').textContent = ''; });
element('undo-finish').addEventListener('click', () => element('clear-b').click());
element('finish-report-button').addEventListener('click', () => {
  if ((!finishReport && !colorReport) || busy) return;
  const anonymous = element<HTMLInputElement>('report-anonymous').checked;
  const report = finishReport ?? colorReport!;
  const url = URL.createObjectURL(new Blob([JSON.stringify(anonymous ? anonymizeFinishingReport(report) : report, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = anonymous ? 'music-sync-finishing-report-anonymous.json' : 'music-sync-finishing-report.json'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
});
for (const id of ['dsp-heading', 'master-heading']) document.querySelector<HTMLAnchorElement>(`a[href="#${id}"]`)?.addEventListener('click', () => {
  element<HTMLDetailsElement>('advanced-settings').open = true;
});
new ResizeObserver(paint).observe(canvas);

function revealOptionalWorkspace(hash:string) {
  const panelId=hash==='#reference-heading'?'reference-panel':hash==='#batch-heading'?'batch-panel':undefined;
  if(!panelId)return;
  element<HTMLDetailsElement>(panelId).open=true;
  requestAnimationFrame(()=>document.getElementById(hash.slice(1))?.scrollIntoView({block:'start'}));
}
for(const link of document.querySelectorAll<HTMLAnchorElement>('a[href="#reference-heading"], a[href="#batch-heading"]'))
  link.addEventListener('click',()=>revealOptionalWorkspace(link.hash));
window.addEventListener('hashchange',()=>revealOptionalWorkspace(location.hash));
revealOptionalWorkspace(location.hash);


const referenceWorkspace=bindReferenceWorkspace({
  busy:()=>busy,hasSource:()=>!!sources.a,load:loadSoundReference,changed:()=>updatePendingFinishSettings(),error:showError,
  finish(){autoMode='AUTO';void runProcessing('auto');},
});
const batchWorkspace=bindBatchWorkspace({
  begin(cancelBatch){
    if(busy)return false;
    const controller=new AbortController();sessionAbort=controller;generation++;worker?.terminate();worker=undefined;
    externalJobCancel=()=>{controller.abort();cancelBatch();};
    player?.pause();paint();errorBox.hidden=true;setBusy(true);setStatus('一括仕上げを準備しています…');return true;
  },
  progress(fraction,text){setProgress(fraction);setStatus(text);},
  end(outcome,text){
    externalJobCancel=undefined;sessionAbort=undefined;setBusy(false);setStatus(text);paint();
    if(outcome==='success')sounds.success();else if(outcome==='error')showError(text);else sounds.cancel();
  },
  options(){return {mode:autoMode,output:finishingPreferences().output,controls:finishingPreferences().controls,repairControls:repairControls(),treble:trebleSelection(),
    aggression:studioNumber('master-aggression'),soundColor:colorSelection(),live:liveSelection(),reference:referenceWorkspace.selection()};},
  exportOptions:()=>exportSettings.options(),
  async decode(file){
    const signal=sessionAbort?.signal;if(!signal)throw new DOMException('Cancelled','AbortError');
    await waitForFlacSlot(signal);signal.throwIfAborted();
    const buffer=await file.arrayBuffer();signal.throwIfAborted();
    const decoding=decodeFlac(buffer,AUTO_ENGINE_LIMITS.maxInputBytes);flacDecodeInFlight=decoding.then(()=>undefined,()=>undefined);
    const audio=await decoding;signal.throwIfAborted();return audio;
  },
  preview:previewBatch,download:downloadBlob,
});

window.addEventListener('pagehide', event => { batchWorkspace.cancel(); sounds.cancel(); sessionAbort?.abort(); if (!event.persisted) { sounds.destroy(); exportSettings.dispose(); referenceWorkspace.dispose(); batchWorkspace.destroy(); } stemSolo.close(); stemAudition.close(); player?.stop(); if (!event.persisted) { stemAudition.set(); void mixFile?.discard(); discardPendingFile(); discardAcceptedFile(); worker?.terminate(); void context?.close(); } });
setBusy(false);

function formatFinishingDetails(report: Omit<AutoFinishResult, 'processed'>): string {
  const last = report.attempts.at(-1);
  return [
    'Perceptual Analysis (experimental estimates, not semantic recognition)', JSON.stringify(report.perceptual, null, 2),
    'Detected Issues', JSON.stringify(last?.mix.perceptual?.detectedIssues ?? [], null, 2),
    'Processing Decisions', JSON.stringify(last?.mix.perceptual?.decisions ?? [], null, 2),
    'Skipped Processing', JSON.stringify(last?.mix.perceptual?.skippedProcessing ?? [], null, 2),
    'Quality Evaluation', JSON.stringify(last?.objectiveQuality ?? {}, null, 2),
    'Complete report / all attempts', JSON.stringify(report, null, 2),
  ].join('\n\n');
}
