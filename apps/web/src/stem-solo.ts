import { createComparisonPlan, singleSourceGainDb, type ComparisonPlan, type AnalysisResult } from '@music-sync/core';
import { ComparisonPlayer, type PlaybackSource } from './comparison-player';

interface SoloTrack {
  id: string; name: string; file: File; analysis: AnalysisResult;
  repairAvailable: boolean; repairEnabled: boolean; repairCommitted: boolean; repairPending: boolean;
}
interface RepairPreview {
  source: PlaybackSource; analysis: AnalysisResult; before: AnalysisResult; restoration?: unknown;
  dispose(): void;
}
interface Host {
  song(): ComparisonPlayer;
  context(): AudioContext;
  tracks(): SoloTrack[];
  mix(): { source: PlaybackSource; analysis: AnalysisResult } | undefined;
  volume(): number;
  restore(): void;
  time(seconds: number): string;
  beforeOpen(): void;
  prepareRepair(id: string, signal: AbortSignal, progress: (fraction: number | undefined, message: string) => void): Promise<RepairPreview>;
  setRepairEnabled(id: string, enabled: boolean): void;
  rebuild(): void;
}
type Mode = 'solo' | 'mix';
type RepairSide = 'before' | 'after';

/** One selected material and optional repair candidate; never reconfigures the main A/B player. */
export function bindStemSolo(host: Host) {
  const id = <T extends HTMLElement>(name: string) => document.getElementById(name) as T;
  const dialog = id<HTMLDialogElement>('stem-solo-dialog');
  const tracks = id<HTMLSelectElement>('stem-solo-track');
  const play = id<HTMLButtonElement>('stem-solo-play');
  const stop = id<HTMLButtonElement>('stem-solo-stop');
  const seek = id<HTMLInputElement>('stem-solo-seek');
  const status = id<HTMLElement>('stem-solo-status');
  const monitor = id<HTMLInputElement>('stem-solo-volume');
  const solo = id<HTMLButtonElement>('stem-solo-isolate');
  const mix = id<HTMLButtonElement>('stem-solo-mix');
  const before = id<HTMLButtonElement>('stem-solo-before');
  const after = id<HTMLButtonElement>('stem-solo-after');
  const match = id<HTMLInputElement>('stem-solo-match');
  const repairUse = id<HTMLInputElement>('stem-solo-repair-use');
  const repairControls = id<HTMLElement>('stem-solo-repair-controls');
  const repairState = id<HTMLElement>('stem-solo-repair-state');
  const repairProgress = id<HTMLProgressElement>('stem-solo-repair-progress');
  const repairCancel = id<HTMLButtonElement>('stem-solo-repair-cancel');
  const rebuild = id<HTMLButtonElement>('stem-solo-rebuild');
  let selected: string | undefined, mode: Mode = 'solo', side: RepairSide = 'before';
  let cache: { id: string; result: RepairPreview; comparison: ComparisonPlan } | undefined;
  let repairAbort: AbortController | undefined, repairEpoch = 0, preparingRepair = false;
  let media: HTMLAudioElement | undefined, objectUrl: string | undefined;
  let pcm: ComparisonPlayer | undefined, abort: AbortController | undefined;
  let duration = 0, position = 0, pending = false, prepared = false;
  let epoch = 0, animation = 0, monitoringGainDb = 0, hadPlayback = false;

  const currentPosition = () => prepared && media ? media.ended ? duration : Math.min(duration, media.currentTime || 0) :
    pcm ? hadPlayback && !pcm.playing && pcm.positionSeconds === 0 ? duration : pcm.positionSeconds : position;
  const playing = () => !!pcm?.playing || !!(media && !media.paused && !media.ended);
  const volume = () => Math.max(0, Math.min(1, Number(monitor.value) || 0));
  function configureMonitor() {
    if (media) media.volume = Math.min(1, volume() * 10 ** (monitoringGainDb / 20));
    pcm?.configure('a', { a: monitoringGainDb, b: 0 }, volume());
  }

  function activeTrack() { return host.tracks().find(track => track.id === selected); }

  function sourceGain(analysis: AnalysisResult) {
    if (mode === 'solo' && cache && cache.id === selected) {
      const comparison = cache.comparison;
      const gains = match.checked && comparison.match.available ? comparison.match.gainsDb : comparison.rawGainsDb;
      return gains[side === 'before' ? 'a' : 'b'];
    }
    return singleSourceGainDb(analysis);
  }

  function comparisonNote() {
    if (mode !== 'solo') return '';
    if (!cache || cache.id !== selected) return '';
    if (!cache.comparison.match.available) return ' 音量一致は利用できません：' + cache.comparison.match.reason;
    return match.checked ? ' 補修前後の曲全体の音量をそろえて比較しています。' : ' 補修前後の元の音量差で比較しています。';
  }

  function describeSource(track: SoloTrack) {
    id('stem-solo-description').textContent = mode === 'mix' ?
      '全体ミックス A · 現在採用されているSTEMミックス' : side === 'before' ?
      track.name + ' · 元の素材・補修前。素材名や役割は目安です。' :
      track.name + ' · 補修後プレビュー（ジャリつき・高域補修のみ）。' +
        (track.repairEnabled ? '' : 'この素材の補修はOFFに設定されています。試聴候補は次回のミックスに入りません。');
  }

  function restorationExplanation() {
    const value = cache?.result.restoration;
    if (!value || typeof value !== 'object') return '';
    const values = Object.values(value);
    return values.flatMap(report => report && typeof report === 'object' && 'explanation' in report && typeof report.explanation === 'string'
      ? [report.explanation] : []).join(' ');
  }

  function updateRepairControls() {
    const track = activeTrack();
    const available = !!track?.repairAvailable;
    repairControls.hidden = !available;
    before.disabled = !available;
    after.disabled = !available || preparingRepair;
    before.setAttribute('aria-pressed', String(mode === 'solo' && side === 'before'));
    after.setAttribute('aria-pressed', String(mode === 'solo' && side === 'after'));
    match.disabled = !available || !cache?.comparison.match.available || preparingRepair || mode === 'mix';
    repairUse.disabled = !available;
    if (track) {
      repairUse.checked = track.repairEnabled;
      describeSource(track);
      repairState.textContent = '現在のA：この素材の補修' + (track.repairCommitted ? 'ON' : 'OFF') +
        '。次回のミックス：' + (track.repairEnabled ? 'ON' : 'OFF') +
        (track.repairPending ? '（変更はまだA/Bに反映していません）。' : '。') +
        (mode === 'mix' ? '全体ミックス Aとの切替には補修前後の音量一致を適用しません。' :
          cache?.id === selected ? comparisonNote() : preparingRepair ? '補修後の試聴候補を準備しています。' :
            '補修後を用意すると、曲全体の解析値で補修前後の音量をそろえられます。') +
        (cache?.id === selected ? ' ' + restorationExplanation() : '');
    }
    rebuild.disabled = !available || !track?.repairPending;
    repairProgress.hidden = !preparingRepair;
    repairCancel.hidden = !preparingRepair;
  }

  function cancelRepair() {
    repairEpoch++; repairAbort?.abort(); repairAbort = undefined;
    preparingRepair = false;
  }

  function disposePreview(value: RepairPreview) {
    try { value.dispose(); } catch { /* A superseded preview must not prevent closing. */ }
  }

  function resetRepair() {
    cancelRepair();
    if (cache) { disposePreview(cache.result); cache = undefined; }
  }

  async function prepareAfter() {
    const track = activeTrack();
    if (!track?.repairAvailable || preparingRepair) return;
    const at = currentPosition();
    if (cache?.id === track.id) { side = 'after'; await load('solo', at, true); return; }
    releasePlayback(); cancelRepair(); mode = 'solo'; side = 'after';
    duration = track.analysis.durationSeconds; position = Math.min(duration, Math.max(0, at));
    const current = repairEpoch, trackId = track.id, controller = new AbortController();
    repairAbort = controller; preparingRepair = true;
    repairProgress.removeAttribute('value');
    status.textContent = track.name + ' の補修後プレビューを準備しています…'; display();
    let result: RepairPreview | undefined;
    try {
      result = await host.prepareRepair(trackId, controller.signal, (fraction, message) => {
        if (current !== repairEpoch || !dialog.open || selected !== trackId) return;
        if (fraction === undefined || !Number.isFinite(fraction)) repairProgress.removeAttribute('value');
        else repairProgress.value = Math.min(1, Math.max(0, fraction));
        status.textContent = message || track.name + ' の補修後プレビューを準備しています…';
      });
      if (current !== repairEpoch || controller.signal.aborted || !dialog.open || selected !== trackId) {
        disposePreview(result); return;
      }
      const comparison = createComparisonPlan(result.before, result.analysis);
      if (comparison.lengthMismatch || result.before.frames !== track.analysis.frames ||
        result.before.sampleRate !== track.analysis.sampleRate || result.before.channels !== track.analysis.channels)
        throw new Error('補修前後の長さ・形式が一致しません。');
      cache = { id: trackId, result, comparison }; result = undefined;
      preparingRepair = false; repairAbort = undefined;
      await load('solo', at, true);
    } catch (error) {
      if (result) disposePreview(result);
      if (current !== repairEpoch || !dialog.open || selected !== trackId) return;
      preparingRepair = false; repairAbort = undefined; side = 'before';
      await load('solo', at, false);
      if (current !== repairEpoch || !dialog.open || selected !== trackId) return;
      status.textContent = controller.signal.aborted ? '補修後の準備をキャンセルしました。原音と現在のA/Bは保持しています。' :
        '補修後を準備できませんでした：' + (error instanceof Error ? error.message : '処理に失敗しました。') + ' 原音と現在のA/Bは保持しています。';
      display();
    }
  }

  function display() {
    cancelAnimationFrame(animation);
    const active = playing();
    position = currentPosition();
    seek.max = String(duration); seek.value = String(position);
    seek.disabled = pending || preparingRepair || !prepared || duration <= 0;
    play.disabled = pending || preparingRepair || !prepared || duration <= 0 || (!media && !pcm);
    stop.disabled = pending || preparingRepair || !prepared || duration <= 0;
    play.textContent = active ? '一時停止' : '再生';
    play.setAttribute('aria-pressed', String(active));
    solo.setAttribute('aria-pressed', String(mode === 'solo'));
    mix.setAttribute('aria-pressed', String(mode === 'mix'));
    mix.disabled = !host.mix();
    updateRepairControls();
    id('stem-solo-time').textContent = host.time(position) + ' / ' + host.time(duration);
    if (active && dialog.open) {
      animation = requestAnimationFrame(() => {
        if (currentPosition() >= duration) {
          media?.pause(); pcm?.pause(); position = duration;
          status.textContent = '末尾です。再生位置を戻すか「先頭へ」を押してください。';
        }
        display();
      });
    }
  }

  function releasePlayback() {
    epoch++; abort?.abort(); abort = undefined;
    cancelAnimationFrame(animation);
    if (media) {
      media.onended = null; media.onerror = null;
      media.pause(); media.removeAttribute('src'); media.load(); media = undefined;
    }
    if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = undefined; }
    pcm?.setSources({}, 0); pcm = undefined;
    pending = false; prepared = false; hadPlayback = false;
  }

  function close() {
    const wasOpen = dialog.open;
    releasePlayback(); resetRepair(); selected = undefined; side = 'before';
    if (wasOpen) dialog.close();
    if (wasOpen) host.restore();
  }

  function updateTracks() {
    const items = host.tracks();
    tracks.replaceChildren(...items.map(track => {
      const option = document.createElement('option'); option.value = track.id;
      option.textContent = track.name; return option;
    }));
    if (selected) tracks.value = selected;
    return items;
  }

  function metadata(audio: HTMLAudioElement, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(new DOMException('Cancelled', 'AbortError'));
    if (audio.readyState >= HTMLMediaElement.HAVE_METADATA) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        audio.removeEventListener('loadedmetadata', ready);
        audio.removeEventListener('error', failed);
        signal.removeEventListener('abort', cancelled);
      };
      const ready = () => { cleanup(); resolve(); };
      const failed = () => { cleanup(); reject(new Error('Media decoding failed')); };
      const cancelled = () => { cleanup(); reject(new DOMException('Cancelled', 'AbortError')); };
      audio.addEventListener('loadedmetadata', ready, { once: true });
      audio.addEventListener('error', failed, { once: true });
      signal.addEventListener('abort', cancelled, { once: true });
    });
  }

  function playbackError(error: unknown, fileName: string) {
    if (error instanceof DOMException && error.name === 'NotAllowedError')
      status.textContent = '再生の準備ができました。「再生」を押してください。';
    else status.textContent = fileName + ' を再生できません。このブラウザが音声形式に対応していないか、素材が破損しています。別の素材を選ぶか、PCM WAVをお試しください。';
  }

  async function start(current: number, fileName: string) {
    if (!dialog.open || current !== epoch || !prepared) return;
    if (currentPosition() >= duration) {
      status.textContent = 'この音源の末尾です。再生位置を戻すか「先頭へ」を押してください。';
      display(); return;
    }
    pending = true; display();
    try {
      if (media) await media.play(); else await pcm?.play();
      if (current !== epoch || !dialog.open) return;
      hadPlayback = true;
      status.textContent = mode === 'solo' ? (side === 'after' ? 'この素材の補修後プレビューを再生しています。' : '元の素材を単独で再生しています。素材の音量設定は適用しません。') + comparisonNote() :
        '全体ミックス Aを再生しています。選択中の素材と同じ位置で切り替えられます。';
    } catch (error) {
      if (current === epoch && dialog.open) playbackError(error, fileName);
    } finally {
      if (current === epoch) { pending = false; display(); }
    }
  }

  async function load(nextMode: Mode, at: number, autoplay: boolean) {
    const track = host.tracks().find(track => track.id === selected);
    const full = host.mix();
    if (!track) { close(); return; }
    if (nextMode === 'mix' && !full) return;
    releasePlayback(); mode = nextMode;
    const current = epoch, controller = new AbortController(); abort = controller;
    const candidate = mode === 'solo' && side === 'after' ? cache?.result : undefined;
    if (mode === 'solo' && side === 'after' && !candidate) { side = 'before'; }
    const source = mode === 'solo' ? candidate?.source ?? { file: track.file } : full!.source;
    const analysis = mode === 'solo' ? candidate?.analysis ?? cache?.result.before ?? track.analysis : full!.analysis;
    const name = mode === 'solo' ? track.name : '全体ミックス A';
    duration = analysis.durationSeconds;
    position = Math.min(duration, Math.max(0, at));
    pending = true;
    id('stem-solo-title').textContent = 'STEMを1素材ずつ聴く';
    describeSource(track);
    status.textContent = name + ' の再生を準備しています…';
    display();
    try {
      const attenuation = sourceGain(analysis); monitoringGainDb = attenuation;
      if (source.file) {
        objectUrl = URL.createObjectURL(source.file);
        const audio = new Audio(objectUrl); media = audio; audio.preload = 'metadata';
        audio.volume = Math.min(1, volume() * 10 ** (attenuation / 20));
        audio.onerror = () => {
          if (current !== epoch || !dialog.open) return;
          audio.pause(); pending = false; prepared = false; hadPlayback = false; playbackError(undefined, name); display();
        };
        audio.onended = () => {
          if (current !== epoch || !dialog.open) return;
          position = duration;
          status.textContent = '末尾です。再生位置を戻すか「先頭へ」を押してください。'; display();
        };
        await metadata(audio, controller.signal);
        if (current !== epoch || !dialog.open) return;
        if (!Number.isFinite(audio.duration) || audio.duration <= 0) throw new Error('Invalid media duration');
        duration = Math.min(duration, audio.duration); position = Math.min(position, duration);
        audio.currentTime = position;
      } else {
        pcm = new ComparisonPlayer(host.context());
        pcm.setSources({ a: source }, duration);
        pcm.configure('a', { a: attenuation, b: 0 }, volume());
        await pcm.seek(position);
      }
      if (current !== epoch || !dialog.open) return;
      prepared = true; pending = false;
      status.textContent = position >= duration ? '現在の位置はこの音源の末尾です。再生位置を戻すか「先頭へ」を押してください。' :
        mode === 'solo' ? (side === 'after' ? 'この素材の補修後プレビューです。' : '元の素材・補修前です。試聴してもA/Bや書き出す音声は変わりません。') + comparisonNote() : '全体ミックス Aです。';
      display();
      if (autoplay && position < duration) await start(current, name);
    } catch (error) {
      if (current === epoch && dialog.open && !(error instanceof DOMException && error.name === 'AbortError')) {
        pending = false; prepared = false; playbackError(error, name); display();
      }
    }
  }

  function open(trackId: string) {
    if (!host.tracks().some(track => track.id === trackId)) return;
    const at = dialog.open ? currentPosition() : host.song().positionSeconds;
    if (!dialog.open) {
      host.beforeOpen(); host.song().pause(); monitor.value = String(Math.max(0, Math.min(1, host.volume()))); match.checked = true;
      selected = trackId; updateTracks(); dialog.showModal();
    } else {
      releasePlayback();
      if (selected !== trackId) resetRepair(); else cancelRepair();
      selected = trackId; updateTracks();
    }
    side = 'before'; void load('solo', at, true);
  }

  tracks.addEventListener('change', () => {
    const at = currentPosition(); releasePlayback(); resetRepair(); selected = tracks.value; side = 'before'; void load('solo', at, true);
  });
  solo.addEventListener('click', () => { if (mode !== 'solo') void load('solo', currentPosition(), true); });
  mix.addEventListener('click', () => { if (mode !== 'mix' || preparingRepair) { const at = currentPosition(); cancelRepair(); void load('mix', at, true); } });
  play.addEventListener('click', () => {
    if (pending || preparingRepair) return;
    if (playing()) { hadPlayback = false; media?.pause(); pcm?.pause(); status.textContent = '一時停止中です。'; display(); }
    else void start(epoch, mode === 'solo' ? host.tracks().find(track => track.id === selected)?.name ?? '素材' : '全体ミックス A');
  });
  async function move(seconds: number) {
    if (pending || preparingRepair || !prepared) return;
    const current = epoch, resume = playing();
    hadPlayback = resume;
    try {
      position = Math.min(duration, Math.max(0, seconds));
      if (media) media.currentTime = position; else await pcm?.seek(position);
      if (current !== epoch || !dialog.open) return;
      if (resume && position < duration && !playing()) await start(current, '音源');
      else { status.textContent = '再生位置を移動しました。'; display(); }
    } catch (error) {
      if (current === epoch) { playbackError(error, '音源'); display(); }
    }
  }
  seek.addEventListener('input', () => void move(Number(seek.value)));
  stop.addEventListener('click', () => { hadPlayback = false; media?.pause(); pcm?.pause(); void move(0); });
  monitor.addEventListener('input', configureMonitor);
  before.addEventListener('click', () => {
    const at = currentPosition(); cancelRepair(); side = 'before'; void load('solo', at, true);
  });
  after.addEventListener('click', () => void prepareAfter());
  match.addEventListener('change', () => {
    const track = activeTrack();
    if (!track || mode !== 'solo' || !cache) return;
    monitoringGainDb = sourceGain(side === 'after' ? cache.result.analysis : cache.result.before);
    configureMonitor(); status.textContent = '試聴設定を変更しました。' + comparisonNote(); display();
  });
  repairUse.addEventListener('change', () => {
    const track = activeTrack(); if (!track) return;
    const enabled = repairUse.checked;
    host.setRepairEnabled(track.id, enabled);
    if (!enabled && preparingRepair) {
      const at = currentPosition(); cancelRepair(); side = 'before'; void load('solo', at, false);
    }
    status.textContent = 'この素材の補修を' + (enabled ? 'ON' : 'OFF') + 'に設定しました。「この設定でミックスを作り直す」で反映します。現在のA/Bは保持しています。';
    display();
  });
  repairCancel.addEventListener('click', () => {
    if (!preparingRepair) return;
    const at = currentPosition(); cancelRepair(); side = 'before';
    const current = repairEpoch;
    void load('solo', at, false).then(() => {
      if (current === repairEpoch && dialog.open) {
        status.textContent = '補修後の準備をキャンセルしました。原音と現在のA/Bは保持しています。'; display();
      }
    });
  });
  rebuild.addEventListener('click', () => { if (activeTrack()?.repairPending) host.rebuild(); });

  id('stem-solo-dismiss').addEventListener('click', close);
  id('stem-solo-close').addEventListener('click', close);
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  return { open, close, refresh() {
    if (!dialog.open) return;
    if (!updateTracks().some(track => track.id === selected)) close(); else display();
  } };
}
