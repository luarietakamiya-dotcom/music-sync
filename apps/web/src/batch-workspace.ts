import { OUTPUT_PROFILES, type AnalysisResult, type AudioData } from '@music-sync/core';
import type { BatchFinishOptions, BatchRequest, BatchResponse } from './batch-protocol';
import { BATCH_STORAGE_LIMITS } from './batch-protocol';
import type { AudioExportOptions, AudioExportResult } from './audio-export';
import { batchDownloadName, batchTrackExportOptions } from './batch-download';
import { CandidateFile } from './candidate-file';
import { readWavFileMetadata } from './wav-stream';
import { openAudioWorker } from './worker-client';
import batchWorkerUrl from './batch.worker.ts?worker&url';
import exportWorkerUrl from './audio-export.worker.ts?worker&url';
import batchExportWorkerUrl from './batch-download.worker.ts?worker&url';

export interface BatchPreview {
  original: File; originalFile: File; processed: File;
  before: AnalysisResult; after: AnalysisResult; name: string; notes?:string[];
}
export interface BatchWorkspaceAdapter {
  /** Reserve the host's single job slot and register its cancel action. */
  begin(cancel: () => void): boolean;
  progress(fraction: number, text: string): void;
  end(outcome: 'success' | 'cancelled' | 'error', text: string): void;
  options(): BatchFinishOptions;
  exportOptions(): AudioExportOptions;
  /** Shares the host's serial native FLAC decode queue and cancellation checks. */
  decode(file: File): Promise<AudioData>;
  /** Copy file-backed sources into host-owned leases before resolving. */
  preview(value: BatchPreview): Promise<void>;
  download(blob: Blob, name: string, onRelease?: () => void): void;
}
type Finished = {
  file: File; analysis: AnalysisResult; original: File; originalAnalysis: AnalysisResult;
  temp: CandidateFile; rawTemp?: CandidateFile; aligned: boolean; notes: string[];
};
type Row = { id: string; input: File; state: 'queued' | 'working' | 'ready' | 'error' | 'cancelled';
  text: string; fraction: number; result?: Finished };
type CompleteResponse = Exclude<BatchResponse, { type: 'progress' } | { type: 'error' }>;
const cancelled = () => new DOMException('Cancelled', 'AbortError');

export function bindBatchWorkspace(adapter: BatchWorkspaceAdapter) {
  const get = <T extends HTMLElement>(id: string) => {
    const element = document.getElementById(id); if (!element) throw new Error('Missing batch control: ' + id); return element as T;
  };
  const drop = get('batch-dropzone'), input = get<HTMLInputElement>('batch-input'), list = get('batch-list');
  const run = get<HTMLButtonElement>('batch-run'), clear = get<HTMLButtonElement>('batch-clear');
  const all = get<HTMLButtonElement>('batch-download-all'), status = get('batch-status');
  const target = document.getElementById('batch-target');
  let rows: Row[] = [], nextId = 0, busy = false, blocked = false, destroyed = false, epoch = 0;
  let worker: Worker | undefined, rejectPending: ((reason: unknown) => void) | undefined;
  let frame = 0;
  const pendingFiles = new Set<CandidateFile>();
  const downloads = new Map<CandidateFile, number>();
  const cleanups = new Set<Promise<void>>();
  const discard = (file?: CandidateFile) => {
    if (!file) return;
    const cleanup = file.discard(); cleanups.add(cleanup); void cleanup.finally(() => cleanups.delete(cleanup));
  };
  const fresh = () => { const file = new CandidateFile(); pendingFiles.add(file); return file; };
  const check = (token: number) => { if (token !== epoch || destroyed) throw cancelled(); };
  const disposeResult = (result?: Finished) => { if (result) { discard(result.temp); discard(result.rawTemp); } };
  const storedBytes = () => rows.reduce((sum, row) => sum + (row.result?.file.size ?? 0) + (row.result?.rawTemp ? row.result.original.size : 0),
    [...downloads.values()].reduce((sum, bytes) => sum + bytes, 0));
  const storageCheck = async (additional: number) => {
    await Promise.all(cleanups);
    if (storedBytes() + additional > BATCH_STORAGE_LIMITS.maxOutputBytes)
      throw new Error('一括処理の一時音声が4 GiBを超えます。曲を減らすかリストをクリアしてから実行してください。');
  };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; render(); }); };
  function render() {
    const unavailable = busy || blocked;
    run.disabled = unavailable || !rows.some(row => /\.(wav|flac)$/i.test(row.input.name));
    clear.disabled = unavailable || !rows.length; input.disabled = unavailable;
    all.disabled = unavailable || !rows.some(row => row.result?.aligned);
    list.replaceChildren(...rows.map((row, index) => {
      const item = document.createElement('article'); item.className = 'batch-track'; item.dataset.batchId = row.id; item.dataset.state = row.state;
      const title = document.createElement('strong'); title.textContent = `${index + 1}. ${row.input.name}`;
      const message = document.createElement('p'); message.className = 'batch-track-status'; message.textContent = row.text;
      const notes = row.result?.notes ?? [];
      const reference = document.createElement('p'); reference.className = 'batch-track-reference';
      reference.textContent = notes.filter(note => /お手本|参考|リファレンス/.test(note)).join(' '); reference.hidden = !reference.textContent;
      const details = document.createElement('details'), summary = document.createElement('summary'), explanations = document.createElement('ul');
      summary.textContent = 'この曲に行ったこと';
      explanations.append(...notes.map(note => { const text = document.createElement('li'); text.textContent = note; return text; }));
      details.append(summary, explanations); details.hidden = !notes.length;
      const progress = document.createElement('progress'); progress.max = 1; progress.value = row.fraction;
      progress.setAttribute('aria-label', row.input.name + ' の進捗');
      const actions = document.createElement('div'); actions.className = 'dsp-actions';
      const preview = document.createElement('button'); preview.type = 'button'; preview.className = 'button';
      preview.textContent = '原音と仕上がりを聴く'; preview.disabled = unavailable || !row.result;
      preview.addEventListener('click', () => { void previewRow(row); });
      const save = document.createElement('button'); save.type = 'button'; save.className = 'button';
      save.textContent = 'この曲を保存'; save.disabled = unavailable || !row.result?.aligned;
      save.addEventListener('click', () => { void downloadRow(row); });
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'button subtle';
      remove.textContent = '外す'; remove.disabled = unavailable;
      remove.addEventListener('click', () => { if (busy || blocked) return; disposeResult(row.result); rows = rows.filter(value => value !== row); render(); });
      actions.append(preview, save, remove); item.append(title, message, reference, progress, actions, details); return item;
    }));
  }
  function add(files: File[]) {
    if (busy || blocked || destroyed) { status.textContent = '処理が終わってから曲を追加してください。'; return; }
    const available = 20 - rows.length;
    let bytes = rows.reduce((sum, row) => sum + row.input.size, 0), sizeLimited = false;
    for (const file of files.slice(0, available)) {
      if (bytes + file.size > BATCH_STORAGE_LIMITS.maxInputBytes) { sizeLimited = true; continue; }
      bytes += file.size;
      const valid = /\.(wav|flac)$/i.test(file.name) && file.size > 0 && file.size <= 512 * 1024 ** 2;
      rows.push({ id: 'batch-' + ++nextId, input: file, state: valid ? 'queued' : 'error', fraction: 0,
        text: valid ? '待機中' : '空でないWAV / FLAC（512 MiB以内）を選んでください。' });
    }
    status.textContent = sizeLimited ? '素材の合計は2 GiBまでです。上限を超えた曲は追加していません。' : files.length > available ? '20曲まで追加できます。上限を超えた曲は追加していません。' : `${rows.length}曲を追加しました。完成曲を1曲ずつ仕上げ、最後に音量をそろえます。`;
    render();
  }
  function start(): number | undefined {
    if (busy || blocked || destroyed || !adapter.begin(cancel)) return;
    busy = true; const token = ++epoch; render(); return token;
  }
  function end(token: number, outcome: 'success' | 'cancelled' | 'error', text: string) {
    if (token !== epoch || destroyed) return;
    worker?.terminate(); worker = undefined; rejectPending = undefined; busy = false;
    status.textContent = text; render(); adapter.end(outcome, text);
  }
  function cancel() {
    if (!busy) return;
    const token = epoch; ++epoch; worker?.terminate(); worker = undefined;
    rejectPending?.(cancelled()); rejectPending = undefined;
    for (const file of pendingFiles) discard(file); pendingFiles.clear();
    for (const row of rows) if (row.state === 'working' || row.state === 'queued') {
      row.state = 'cancelled'; row.text = row.result ? 'キャンセルしました。直前までの候補を保持しています。' : 'キャンセルしました。原音を保持しています。';
    }
    busy = false; status.textContent = '一括処理をキャンセルしました。メインのA/Bと原音は保持しています。';
    render(); if (token + 1 === epoch && !destroyed) adapter.end('cancelled', status.textContent);
  }
  async function task<T extends { type: string }>(kind: 'batch' | 'export' | 'batch-export', request: unknown,
    expected: T['type'], token: number, progress: (fraction: number, text: string) => void, transfer: Transferable[] = []): Promise<T> {
    const url = kind === 'batch' ? batchWorkerUrl : kind === 'export' ? exportWorkerUrl : batchExportWorkerUrl;
    const active = await openAudioWorker(kind, new URL(url, document.baseURI));
    try { check(token); } catch (error) { active.terminate(); throw error; }
    worker = active;
    return new Promise<T>((resolve, reject) => {
      const finish = (error?: unknown, value?: T) => {
        active.terminate(); if (worker === active) { worker = undefined; rejectPending = undefined; }
        if (error) reject(error); else resolve(value!);
      };
      rejectPending = error => finish(error);
      active.onerror = () => finish(new Error('一括処理のWorkerが停止しました。原音は保持しています。'));
      active.onmessage = ({ data }) => {
        if (token !== epoch || destroyed) { finish(cancelled()); return; }
        if (data.type === 'progress') { progress(data.fraction, data.text); return; }
        if (data.type === 'error') { finish(new Error(data.message)); return; }
        if (data.type !== expected) { finish(new Error('一括処理の応答が対応していません。画面を再読み込みしてください。')); return; }
        finish(undefined, data as T);
      };
      active.postMessage(request, transfer);
    });
  }
  async function finishTracks() {
    if (!rows.length) return;
    let options: BatchFinishOptions;
    try { options = structuredClone(adapter.options()); } catch (error) { status.textContent = String(error); return; }
    const token = start(); if (token === undefined) return;
    const finished: Row[] = [];
    try {
      // Retain old candidates for listening, but never mix a previous album target into this run's ZIP.
      for (const row of rows) { if (row.result) row.result.aligned = false; row.state = 'queued'; }
      if (target) target.textContent = '各曲を解析しています…';
      for (const [index, row] of rows.entries()) {
        check(token);
        row.state = 'working'; row.fraction = 0; row.text = 'Analyzing / 曲を解析しています…'; render();
        let temp: CandidateFile | undefined, rawTemp: CandidateFile | undefined;
        try {
          if (!/\.(wav|flac)$/i.test(row.input.name) || !row.input.size || row.input.size > 512 * 1024 ** 2)
            throw new Error('空でないWAV / FLAC（512 MiB以内）を選んでください。');
          let audio: AudioData | undefined;
          if (/\.flac$/i.test(row.input.name)) {
            if (row.input.size > 100 * 1024 ** 2) throw new Error('FLACは100 MiB以内にしてください。');
            audio = await adapter.decode(row.input); check(token);
            const bytes = audio.channels.reduce((sum, channel) => sum + channel.byteLength, 0);
            if (bytes > BATCH_STORAGE_LIMITS.maxPcmBytes) throw new Error('FLACは展開後96 MiB以内にしてください。');
            await storageCheck(2 * (bytes + 56)); check(token);
          } else {
            const info = await readWavFileMetadata(row.input); check(token);
            const projected=info.frames*info.channels*4+56;
            const fileBacked=row.input.size>100*1024**2||info.frames*info.channels*4>BATCH_STORAGE_LIMITS.maxPcmBytes||info.frames/info.sampleRate>600;
            // File-backed reference evaluation temporarily holds both the base and a scratch candidate.
            await storageCheck(projected*(fileBacked&&options.reference?2:1)); check(token);
          }
          temp = fresh();
          const request: BatchRequest = { kind: 'batch-finish', id: row.id, file: row.input, ...options, destination: await temp.handle };
          const transfer: Transferable[] = [];
          if (audio) {
            rawTemp = fresh();
            delete request.file; request.audio = audio; request.rawDestination = await rawTemp.handle;
            transfer.push(...audio.channels.map(channel => channel.buffer as ArrayBuffer));
          }
          const response = await task<Extract<CompleteResponse, { type: 'batch-finished' }>>('batch', request, 'batch-finished', token,
            (fraction, text) => { row.fraction = fraction * .8; row.text = text; schedule(); adapter.progress((index + fraction) / rows.length * .75, `${index + 1}/${rows.length} ${row.input.name}：${text}`); }, transfer);
          check(token);
          disposeResult(row.result);
          row.result = { file: response.file, analysis: response.analysis, original: response.originalFile ?? row.input,
            originalAnalysis: response.originalAnalysis, temp, rawTemp, aligned: false, notes: [...new Set(response.notes)] };
          pendingFiles.delete(temp); if (rawTemp) pendingFiles.delete(rawTemp);
          temp = undefined; rawTemp = undefined; row.text = '仕上げ候補を用意しました。共通の音量を確認中…'; row.fraction = .8;
          finished.push(row);
        } catch (error) {
          check(token); row.state = 'error'; row.text = (error instanceof Error ? error.message : 'この曲を処理できませんでした。') +
            (row.result ? ' 前回の候補は試聴できますが、今回の一括保存には含めません。' : '');
        } finally {
          if (temp && pendingFiles.delete(temp)) discard(temp);
          if (rawTemp && pendingFiles.delete(rawTemp)) discard(rawTemp);
          render();
        }
      }
      if (!finished.length) { end(token, 'error', '仕上げられる曲がありませんでした。各曲の説明を確認してください。'); return; }
      const profile = OUTPUT_PROFILES[options.output ?? 'auto'];
      const planned = await task<Extract<CompleteResponse, { type: 'batch-plan-result' }>>('batch', {
        kind: 'batch-plan', tracks: finished.map(row => ({ id: row.id, analysis: row.result!.analysis })),
        ...(profile.targetLufs === null ? {} : { targetLufs: profile.targetLufs }), ceilingDb: profile.ceilingDb,
      } satisfies BatchRequest, 'batch-plan-result', token, (fraction, text) => adapter.progress(.75 + fraction * .02, text));
      if (target) target.textContent = planned.plan.commonTargetLufs === null ? '共通音量を決められませんでした。' : `共通の目安：${planned.plan.commonTargetLufs.toFixed(1)} LUFS（ピークと強弱を保護）`;
      let accepted = 0;
      for (const [index, row] of finished.entries()) {
        check(token); const plan = planned.plan.tracks.find(track => track.id === row.id);
        if (!plan || plan.status !== 'ready' || plan.gainDb === null) { row.state = 'error'; row.text = plan?.reason ?? '共通音量を決められませんでした。'; continue; }
        let temp: CandidateFile | undefined;
        try {
          row.text = 'Finalizing / ピークを保ちながら音量をそろえています…'; render();
          const result = row.result!;
          if (Math.abs(plan.gainDb) > 1e-8) {
            await storageCheck(result.file.size); check(token);
            temp = fresh();
            const leveled = await task<Extract<CompleteResponse, { type: 'batch-level-result' }>>('batch', {
              kind: 'batch-level', id: row.id, file: result.file, analysis: result.analysis,
              gainDb: plan.gainDb, destination: await temp.handle, ceilingDb: planned.plan.ceilingDb,
            } satisfies BatchRequest, 'batch-level-result', token, (fraction, text) => {
              row.fraction = .8 + .2 * fraction; row.text = text; schedule(); adapter.progress(.77 + .23 * (index + fraction) / finished.length, `${index + 1}/${finished.length} ${row.input.name}：${text}`);
            });
            check(token); discard(result.temp); result.temp = temp; pendingFiles.delete(temp); temp = undefined;
            result.file = leveled.file; result.analysis = leveled.analysis;
          }
          result.aligned = true; row.state = 'ready'; row.fraction = 1; accepted++;
          row.text = `完了：${result.analysis.integratedLufs?.toFixed(1) ?? '—'} LUFS / 推定True Peak ${result.analysis.truePeakDbtp?.toFixed(1) ?? '—'} dBTP。原音と比較して確認できます。`;
        } catch (error) { check(token); row.state = 'error'; row.text = error instanceof Error ? error.message : '音量をそろえられませんでした。'; }
        finally { if (temp && pendingFiles.delete(temp)) discard(temp); render(); }
      }
      const errors = rows.length - accepted;
      end(token, accepted ? 'success' : 'error', `${accepted}/${rows.length}曲を用意しました。${errors ? errors + '曲は各行の説明を確認してください。' : '音量は測定上の目安です。曲ごとに聴いて確認してください。'}`);
    } catch (error) { if (token === epoch) end(token, 'error', error instanceof Error ? error.message : '一括仕上げを完了できませんでした。'); }
  }
  async function previewRow(row: Row) {
    if (!row.result) return;
    const token = start(); if (token === undefined) return;
    try {
      const result = row.result; adapter.progress(0, '比較用の音源を準備しています…');
      await adapter.preview({ original: result.original, originalFile: row.input, processed: result.file,
        before: result.originalAnalysis, after: result.analysis, name: row.input.name,notes:result.notes });
      check(token); end(token, 'success', `${row.input.name} をメインのA/Bへ読み込みました。音量をそろえて聴き比べられます。`);
    } catch (error) { if (token === epoch) end(token, 'error', error instanceof Error ? error.message : '比較を準備できませんでした。'); }
  }
  async function downloadRow(row: Row) {
    if (!row.result?.aligned) return;
    let options: AudioExportOptions;
    try { options = batchTrackExportOptions(adapter.exportOptions(), row.input.name); } catch (error) { status.textContent = String(error); return; }
    const token = start(); if (token === undefined) return;
    try {
      const result = await task<AudioExportResult & { type: 'audio-export-result' }>('export', {
        kind: 'audio-export', source: { file: row.result.file }, options,
      }, 'audio-export-result', token, adapter.progress);
      check(token); adapter.download(result.blob, batchDownloadName(row.input.name, result.extension));
      end(token, 'success', '音声の保存を開始しました。ブラウザのダウンロード一覧を確認してください。');
    } catch (error) { if (token === epoch) end(token, 'error', error instanceof Error ? error.message : '音声を保存できませんでした。'); }
  }
  async function downloadAll() {
    const tracks = rows.filter(row => row.result?.aligned).map(row => ({ file: row.result!.file, name: row.input.name }));
    if (!tracks.length) return;
    let options: AudioExportOptions;
    try { options = structuredClone(adapter.exportOptions()); } catch (error) { status.textContent = String(error); return; }
    const token = start(); if (token === undefined) return;
    const temp = fresh(); let handedOff = false;
    try {
      await storageCheck(1); check(token);
      const result = await task<{ type: 'batch-export-result'; file: File }>('batch-export', {
        kind: 'batch-export', tracks, options, destination: await temp.handle,
        maximumBytes: Math.min(2 * 1024 ** 3, BATCH_STORAGE_LIMITS.maxOutputBytes - storedBytes()),
      }, 'batch-export-result', token, adapter.progress);
      check(token); downloads.set(temp, result.file.size);
      adapter.download(result.file, 'MusicSync-finished-songs.zip', () => { downloads.delete(temp); discard(temp); });
      pendingFiles.delete(temp); handedOff = true;
      end(token, 'success', `${tracks.length}曲のZIPの保存を開始しました。ブラウザのダウンロード一覧を確認してください。`);
    } catch (error) { if (token === epoch) end(token, 'error', error instanceof Error ? error.message : 'ZIPを保存できませんでした。'); }
    finally { if (!handedOff) { downloads.delete(temp); if (pendingFiles.delete(temp)) discard(temp); } }
  }
  const changed = () => { const files = [...input.files ?? []]; input.value = ''; add(files); };
  const over = (event: DragEvent) => { event.preventDefault(); if (!busy && !blocked) drop.classList.add('drag-over'); };
  const leave = () => drop.classList.remove('drag-over');
  const dropped = (event: DragEvent) => { event.preventDefault(); leave(); add([...event.dataTransfer?.files ?? []]); };
  const runClicked = () => { void finishTracks(); }, allClicked = () => { void downloadAll(); };
  const clearClicked = () => { if (!busy && !blocked) { rows.forEach(row => disposeResult(row.result)); rows = []; status.textContent = '曲リストをクリアしました。メインのA/Bは保持しています。'; if (target) target.textContent = ''; render(); } };
  input.addEventListener('change', changed); drop.addEventListener('dragover', over); drop.addEventListener('dragleave', leave); drop.addEventListener('drop', dropped);
  run.addEventListener('click', runClicked); clear.addEventListener('click', clearClicked); all.addEventListener('click', allClicked);
  render();
  return { cancel, setBlocked(value: boolean) { blocked = value; render(); }, get busy() { return busy; }, destroy() {
    if (destroyed) return; cancel(); destroyed = true; if (frame) cancelAnimationFrame(frame);
    input.removeEventListener('change', changed); drop.removeEventListener('dragover', over); drop.removeEventListener('dragleave', leave); drop.removeEventListener('drop', dropped);
    run.removeEventListener('click', runClicked); clear.removeEventListener('click', clearClicked); all.removeEventListener('click', allClicked);
    rows.forEach(row => disposeResult(row.result)); rows = [];
  } };
}
