import type { AudioData } from '@music-sync/core';
import { separateFile, separationAvailableOnDevice, type SeparatedFiles, type SeparationMode } from './separation-client';

export interface SeparationWorkspaceHost {
  busy(): boolean;
  source(): File | undefined;
  begin(): {
    signal: AbortSignal;
    progress(fraction?: number, text?: string): void;
    end(text: string, error?: unknown): void;
  };
  /** Retain the result's files before returning; the panel keeps its own lease. */
  stage(result: SeparatedFiles): void;
  pause(): void;
  /** Share the host's native FLAC decoder queue, when available. */
  decode?(file: File, signal: AbortSignal): Promise<AudioData>;
}

type Job = {
  controller: AbortController;
  handle: ReturnType<SeparationWorkspaceHost['begin']>;
  onHostAbort: () => void;
  ended: boolean;
};
type Audition = { audio: HTMLAudioElement; url: string; save: HTMLButtonElement };
type Download = { release: () => void; timer: ReturnType<typeof setTimeout> };
const abortError = () => new DOMException('Cancelled', 'AbortError');

/** A separation result is only auditioned here; staging it is an explicit action. */
export function bindSeparationWorkspace(host: SeparationWorkspaceHost) {
  const get = <T extends HTMLElement>(id: string) => {
    const element = document.getElementById(id);
    if (!element) throw new Error('Missing separation control: ' + id);
    return element as T;
  };
  const drop = get('separation-dropzone'), input = get<HTMLInputElement>('separation-input');
  const sourceName = get('separation-source-name'), useSource = get<HTMLButtonElement>('separation-use-source');
  const mode = get<HTMLSelectElement>('separation-mode'), run = get<HTMLButtonElement>('separation-run');
  const modeDescription = get('separation-mode-description'), resourceNote = get('separation-resource-note');
  const inputTitle = get('separation-input-title');
  const clear = get<HTMLButtonElement>('separation-clear'), stage = get<HTMLButtonElement>('separation-stage');
  const status = get('separation-status'), results = get('separation-results');
  let selected: File | undefined, result: SeparatedFiles | undefined, job: Job | undefined, destroyed = false;
  const auditions: Audition[] = [], downloads = new Map<string, Download>();
  const listeners: (() => void)[] = [];

  function on<K extends keyof HTMLElementEventMap>(element: HTMLElement, type: K, handler: (event: HTMLElementEventMap[K]) => void) {
    element.addEventListener(type, handler);
    listeners.push(() => element.removeEventListener(type, handler));
  }
  function unavailable() { return destroyed || !separationAvailableOnDevice() || !!job || host.busy(); }
  function pauseAuditions() { for (const { audio } of auditions) audio.pause(); }
  function clearAuditions() {
    for (const { audio, url } of auditions) {
      audio.pause(); audio.removeAttribute('src'); audio.load(); URL.revokeObjectURL(url);
    }
    auditions.length = 0; results.replaceChildren();
  }
  function dispose(value?: SeparatedFiles) {
    // Temporary-file cleanup must not turn a finished job into an unhandled rejection.
    if (value) void value.dispose().catch(() => undefined);
  }
  function fileToUse() { return selected ?? host.source(); }
  function refreshModeDescription() {
    const fine = mode.value === 'drums' || mode.value === 'detailed';
    inputTitle.textContent = mode.value === 'drums' ? 'ドラムだけの音源を1つドロップ' : '分離する完成曲を1曲ドロップ';
    input.setAttribute('aria-label', mode.value === 'drums' ? 'AIで分離するドラム音源を選択' : 'AIで分離する完成曲を選択');
    if (mode.value === 'drums') {
      modeDescription.textContent = 'ドラムだけの音源を選んでください。キック・スネア・ハイハット・タム・パーカッションと、残りのドラムに分けます。完成曲から分ける場合は「曲＋ドラムの各パーツ」を選んでください。';
    } else if (mode.value === 'detailed') {
      modeDescription.textContent = '完成曲をボーカル・ドラム・ベース・その他に分け、さらにドラムを6素材に分けます。ドラム全体は重ねず、合計9素材として使えます。';
    } else if (mode.value === 'two') {
      modeDescription.textContent = '完成曲をボーカルと伴奏の2素材に分けます。';
    } else {
      modeDescription.textContent = '完成曲からボーカル・ドラム・ベース・その他を取り出します。ドラムは1素材です。';
    }
    const models = mode.value === 'drums' ? 'ドラム用AIモデル約92MB'
      : mode.value === 'detailed' ? 'AIモデル約13MBとドラム用モデル約92MB' : 'AIモデル約13MB';
    resourceNote.textContent = `初回は${models}と実行プログラムを取得します。空きメモリは約${fine ? '3' : '1.5'}GB以上が目安です。`
      + (fine ? ' GPUを利用できる場合は自動で使用します。CPUでは長時間かかる場合があります。' : '');
  }
  function refresh() {
    if (destroyed) return;
    const blocked = unavailable(), current = fileToUse();
    refreshModeDescription();
    if (!separationAvailableOnDevice()) status.textContent = 'AI STEM分離はPCでご利用ください。スマホでは分離済み素材の読み込みなどを利用できます。';
    input.disabled = blocked; mode.disabled = blocked;
    useSource.disabled = blocked || !host.source();
    run.disabled = blocked || !current;
    clear.disabled = blocked || (!selected && !result);
    stage.disabled = blocked || !result;
    sourceName.textContent = current
      ? (selected ? '分離する曲：' : '現在のOriginalを分離：') + current.name
      : '分離する曲を選ぶか、上のOriginalに曲を読み込んでください。';
    drop.setAttribute('aria-disabled', String(blocked));
    drop.classList.toggle('is-busy', blocked);
    for (const audition of auditions) {
      audition.save.disabled = blocked;
      audition.audio.controls = !blocked;
      audition.audio.setAttribute('aria-disabled', String(blocked));
      audition.audio.tabIndex = blocked ? -1 : 0;
      if (blocked) audition.audio.pause();
    }
  }
  function validation(file: File): string | undefined {
    if (!/\.(wav|flac)$/i.test(file.name) || !file.size) return '空でないWAV / FLACを1曲選んでください。';
    const limit = /\.flac$/i.test(file.name) ? 100 : 512;
    if (file.size > limit * 1024 ** 2) return `${/\.flac$/i.test(file.name) ? 'FLAC' : 'WAV'}は${limit} MiB以内のファイルを選んでください。`;
  }
  function select(files: File[]) {
    if (unavailable()) return;
    if (files.length !== 1) {
      if (files.length) status.textContent = '分離する音源を1つだけ選んでください。分離済みの複数素材はSTEMリストへ追加できます。';
      return;
    }
    const error = validation(files[0]);
    if (error) { status.textContent = error; return; }
    selected = files[0];
    status.textContent = result
      ? '曲を選びました。「AIで素材に分ける」で新しく分離します。下には前回の結果を保持しています。'
      : '曲を選びました。「AIで素材に分ける」を押してください。';
    refresh();
  }
  function finish(current: Job, text: string, error?: unknown) {
    if (current.ended) return;
    current.ended = true;
    current.handle.signal.removeEventListener('abort', current.onHostAbort);
    if (job === current) job = undefined;
    if (!destroyed) status.textContent = text;
    // The host owns generation checks and the common progress display / notification sounds.
    current.handle.end(text, error);
    refresh();
  }
  function cancel() {
    pauseAuditions();
    const current = job;
    if (!current || current.ended) return;
    current.controller.abort();
    finish(current, '分離をキャンセルしました。原音と、前回の分離結果は保持しています。', abortError());
  }
  function closeDownload(url: string) {
    const download = downloads.get(url);
    if (!download) return;
    downloads.delete(url); clearTimeout(download.timer); URL.revokeObjectURL(url); download.release();
  }
  function saveTrack(owner: SeparatedFiles, track: SeparatedFiles['tracks'][number]) {
    if (unavailable() || result !== owner) return;
    let release: (() => void) | undefined, url: string | undefined;
    try {
      release = owner.retain(); url = URL.createObjectURL(track.file);
      const original = owner.original.name.replace(/\.(wav|flac)$/i, '').replace(/[<>:"/\\|?*]/g, '_');
      const name = (original || 'MusicSync') + '_' + track.id.replace(/[^a-z\d_-]/gi, '_') + '.wav';
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.hidden = true;
      document.body.append(anchor); try { anchor.click(); } finally { anchor.remove(); }
      const activeUrl = url;
      downloads.set(url, { release, timer: setTimeout(() => closeDownload(activeUrl), 60_000) });
      status.textContent = track.label + 'のWAV保存を開始しました。分離後の素材をそのまま保存します。';
    } catch {
      if (url) URL.revokeObjectURL(url); release?.();
      status.textContent = 'WAVの保存を開始できませんでした。もう一度お試しください。';
    }
  }
  function renderResult(owner: SeparatedFiles) {
    const fragment = document.createDocumentFragment(), nextAuditions: Audition[] = [];
    const heading = document.createElement('h3'); heading.textContent = '分離した素材';
    const description = document.createElement('p');
    description.textContent = `${owner.original.name} → ${owner.tracks.length}素材。聴いて確認し、必要ならSTEMリストに入れてください。`;
    const playback = document.createElement('p'); playback.className = 'comparison-footnote';
    playback.textContent = '試聴はピーク保護のため全素材に共通の音量で再生します。保存するWAVの音量は変えません。';
    fragment.append(heading, description, playback);
    try { for (const track of owner.tracks) {
      const row = document.createElement('article'); row.className = 'batch-track separation-track'; row.dataset.stemId = track.id;
      const name = document.createElement('strong'); name.textContent = track.label;
      const audio = document.createElement('audio'); audio.controls = true; audio.preload = 'none';
      audio.volume = Math.min(1, .95 / Math.max(1, owner.report.maxPeak));
      audio.setAttribute('aria-label', track.label + 'を試聴');
      const url = URL.createObjectURL(track.file); audio.src = url;
      audio.addEventListener('play', () => {
        if (unavailable() || result !== owner) { audio.pause(); return; }
        for (const other of auditions) if (other.audio !== audio) other.audio.pause();
        host.pause();
      });
      audio.addEventListener('error', () => {
        if (result === owner && !destroyed) status.textContent = track.label + 'の試聴を開始できませんでした。WAVを保存して確認できます。';
      });
      const save = document.createElement('button'); save.type = 'button'; save.className = 'button';
      save.textContent = track.label + 'をWAV保存'; save.addEventListener('click', () => saveTrack(owner, track));
      const actions = document.createElement('div'); actions.className = 'dsp-actions'; actions.append(audio, save);
      row.append(name, actions); fragment.append(row); nextAuditions.push({ audio, url, save });
    } } catch (reason) {
      for (const { audio, url } of nextAuditions) { audio.removeAttribute('src'); URL.revokeObjectURL(url); }
      throw reason;
    }
    clearAuditions(); results.append(fragment); auditions.push(...nextAuditions);
  }
  async function separate() {
    if (unavailable()) return;
    const source = fileToUse();
    if (!source) return;
    const error = validation(source);
    if (error) { status.textContent = error; return; }
    const requestedMode = mode.value;
    const pickedMode: SeparationMode = requestedMode === 'two' || requestedMode === 'drums' || requestedMode === 'detailed' ? requestedMode : 'four';
    let handle: Job['handle'];
    try { handle = host.begin(); }
    catch (reason) {
      status.textContent = reason instanceof Error ? reason.message : 'ほかの処理が終わってから分離してください。';
      refresh(); return;
    }
    const controller = new AbortController();
    const current: Job = { controller, handle, onHostAbort: () => cancel(), ended: false };
    job = current; handle.signal.addEventListener('abort', current.onHostAbort, { once: true });
    if (handle.signal.aborted) { cancel(); return; }
    pauseAuditions(); status.textContent = '分離の準備をしています。初回はAIの実行ファイルを取得します。'; refresh();
    let candidate: SeparatedFiles | undefined;
    try {
      host.pause(); handle.progress(undefined, status.textContent);
      candidate = await separateFile(source, pickedMode, controller.signal, (fraction, text) => {
        if (job !== current || current.ended || destroyed) return;
        status.textContent = text; handle.progress(fraction, text);
      }, host.decode);
      if (controller.signal.aborted || current.ended || job !== current || destroyed) {
        dispose(candidate); return;
      }
      // Construct every audition URL before replacing a previously successful result.
      const previous = result;
      renderResult(candidate);
      result = candidate; candidate = undefined; dispose(previous);
      finish(current, `${result.tracks.length}素材に分離しました。まず素材ごとに聴いて確認できます。OriginalとA/Bは保持しています。`);
    } catch (reason) {
      dispose(candidate);
      if (current.ended) return;
      const cancelled = controller.signal.aborted || (reason instanceof Error && reason.name === 'AbortError');
      finish(current, cancelled
        ? '分離をキャンセルしました。原音と、前回の分離結果は保持しています。'
        : (reason instanceof Error ? reason.message : '分離できませんでした。原音と、前回の分離結果は保持しています。'),
      cancelled ? abortError() : reason);
    }
  }

  on(input, 'change', () => { const files = Array.from(input.files ?? []); input.value = ''; select(files); });
  on(drop, 'dragover', event => { event.preventDefault(); event.stopPropagation(); if (!unavailable()) drop.classList.add('drag-over'); });
  on(drop, 'dragleave', () => drop.classList.remove('drag-over'));
  on(drop, 'drop', event => { event.preventDefault(); event.stopPropagation(); drop.classList.remove('drag-over'); select(Array.from(event.dataTransfer?.files ?? [])); });
  on(useSource, 'click', () => {
    if (unavailable()) return;
    const source = host.source(); if (source) select([source]);
  });
  on(mode, 'change', () => {
    if (unavailable()) return;
    refreshModeDescription();
    status.textContent = result ? '分け方を変更しました。もう一度分離すると更新されます。下には前回の結果を保持しています。' : '分け方を選びました。「AIで素材に分ける」を押してください。';
  });
  on(run, 'click', () => { void separate(); });
  on(clear, 'click', () => {
    if (unavailable()) return;
    const previous = result; result = undefined; selected = undefined;
    clearAuditions(); dispose(previous); input.value = '';
    status.textContent = 'この欄の分離結果をクリアしました。Original・A/B・STEMリストは保持しています。'; refresh();
  });
  on(stage, 'click', () => {
    if (unavailable() || !result) return;
    try {
      host.stage(result);
      status.textContent = '分離素材をSTEMリストに入れました。「ミックスを作る」で合成できます。現在のOriginal・A/Bは保持しています。';
    } catch (reason) {
      status.textContent = reason instanceof Error ? reason.message : 'STEMリストに追加できませんでした。分離結果は保持しています。';
    }
    refresh();
  });
  refresh();
  return {
    refresh,
    cancel,
    destroy() {
      if (destroyed) return;
      cancel(); destroyed = true;
      for (const remove of listeners) remove();
      clearAuditions(); const previous = result; result = undefined; selected = undefined; dispose(previous);
      // A download can still be reading after this panel closes. Its independent
      // lease and URL expire together after 60 seconds, even across clear/destroy.
    },
  };
}
