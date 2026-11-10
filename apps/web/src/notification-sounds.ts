export interface NotificationSoundSettings { enabled: boolean; volume: number }
export const NOTIFICATION_SOUND_STORAGE_KEY = 'music-sync-notifications-v1';

interface SoundAudio {
  src: string; loop: boolean; volume: number; preload: string; currentTime: number;
  play(): Promise<void>; pause(): void; load(): void; removeAttribute(name: string): void;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}
interface SoundStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }
interface ManagerOptions {
  baseUrl: string;
  audioFactory?: (url: string) => SoundAudio;
  storage?: SoundStorage;
  onSettings?(settings: NotificationSoundSettings): void;
  onStatus?(text: string): void;
}

function readSettings(storage?: SoundStorage): NotificationSoundSettings {
  const settings = { enabled: true, volume: 25 };
  try {
    const stored = storage?.getItem(NOTIFICATION_SOUND_STORAGE_KEY);
    const value: unknown = stored ? JSON.parse(stored) : undefined;
    if (value && typeof value === 'object') {
      if ('enabled' in value && typeof value.enabled === 'boolean') settings.enabled = value.enabled;
      if ('volume' in value && typeof value.volume === 'number' && Number.isFinite(value.volume) && value.volume >= 0 && value.volume <= 100)
        settings.volume = value.volume;
    }
  } catch { /* Storage restrictions do not prevent processing or local SE settings. */ }
  return settings;
}

/** UI-only playback; these voices never enter the song graph, DSP buffers or exported audio. */
export function createNotificationSoundManager(options: ManagerOptions) {
  let settings = readSettings(options.storage), working = false, destroyed = false, sequence = 0;
  let loop: SoundAudio | undefined, shot: SoundAudio | undefined;
  let loopOwner: number | undefined, shotOwner: number | undefined;
  const factory = options.audioFactory ?? (url => new Audio(url));
  const listeners: { audio: SoundAudio; type: string; listener: () => void }[] = [];
  const url = (name: string) => new URL('sfx/' + name, options.baseUrl).href;
  const audible = () => !destroyed && settings.enabled && settings.volume > 0;
  const level = () => settings.volume / 100;

  function stop(audio?: SoundAudio) {
    if (!audio) return;
    audio.pause();
    try { audio.currentTime = 0; } catch { /* The media header may not be ready yet. */ }
  }
  function stopLoop() { loopOwner = undefined; stop(loop); }
  function stopShot() { shotOwner = undefined; stop(shot); }
  function reportFailure() {
    if (!destroyed) options.onStatus?.('SEを再生できませんでした。「完了音を試聴」などを押して、ブラウザの音声設定を確認してください。');
  }
  function make(name: string, looping: boolean) {
    const audio = factory(url(name)); audio.loop = looping; audio.preload = 'metadata'; audio.volume = level();
    const failed = () => {
      const owned = looping ? loopOwner !== undefined : shotOwner !== undefined;
      if (!owned) return;
      if (looping) stopLoop(); else stopShot();
      reportFailure();
    };
    audio.addEventListener('error', failed); listeners.push({ audio, type: 'error', listener: failed });
    if (!looping) {
      const ended = () => { shotOwner = undefined; };
      audio.addEventListener('ended', ended); listeners.push({ audio, type: 'ended', listener: ended });
    }
    return audio;
  }
  function play(audio: SoundAudio, token: number, looping: boolean) {
    const owner = () => looping ? loopOwner : shotOwner;
    try {
      void Promise.resolve(audio.play()).then(() => {
        // A cancelled native play request may settle after stop(). Do not stop a newer owner.
        if (owner() === undefined) stop(audio);
        else if (owner() === token && !destroyed) options.onStatus?.(looping ? '処理中SEを再生中です。' : 'SEを再生しました。');
      }, () => {
        if (owner() !== token || destroyed) return;
        if (looping) stopLoop(); else stopShot();
        reportFailure();
      });
    } catch {
      if (owner() === token && !destroyed) {
        if (looping) stopLoop(); else stopShot();
        reportFailure();
      }
    }
  }
  function startLoop() {
    if (!audible() || !working || loopOwner !== undefined) return;
    try {
      loop ??= make('processing_loop.wav', true);
      loop.volume = level(); loopOwner = ++sequence; play(loop, loopOwner, true);
    } catch { stopLoop(); reportFailure(); }
  }
  function outcome(name: 'success.wav' | 'error.wav') {
    if (destroyed) return;
    working = false; stopLoop(); stopShot();
    if (!audible()) return;
    try {
      if (!shot) shot = make(name, false);
      else if (shot.src !== url(name)) { shot.src = url(name); shot.load(); }
      shot.volume = level(); shotOwner = ++sequence; play(shot, shotOwner, false);
    } catch { stopShot(); reportFailure(); }
  }
  function cancel() { working = false; stopLoop(); stopShot(); }
  return {
    get settings(): NotificationSoundSettings { return { ...settings }; },
    setSettings(next: Partial<NotificationSoundSettings>) {
      if (destroyed) return;
      if ((next.enabled !== undefined && typeof next.enabled !== 'boolean') ||
        (next.volume !== undefined && (!Number.isFinite(next.volume) || next.volume < 0 || next.volume > 100)))
        throw new Error('SEの音量またはON/OFF設定が不正です。');
      settings = { enabled: next.enabled ?? settings.enabled, volume: next.volume ?? settings.volume };
      try { options.storage?.setItem(NOTIFICATION_SOUND_STORAGE_KEY, JSON.stringify(settings)); }
      catch { options.onStatus?.('SE設定をこのブラウザに保存できません。この画面では設定した音量を使えます。'); }
      if (loop) loop.volume = level(); if (shot) shot.volume = level();
      if (!audible()) { stopLoop(); stopShot(); } else startLoop();
      options.onSettings?.({ ...settings });
    },
    working(active: boolean) {
      if (destroyed) return;
      if (!active) { working = false; stopLoop(); return; }
      if (!working) stopShot();
      working = true; startLoop();
    },
    success() { outcome('success.wav'); },
    error() { outcome('error.wav'); },
    cancel,
    destroy() {
      if (destroyed) return;
      cancel(); destroyed = true;
      for (const { audio, type, listener } of listeners) audio.removeEventListener(type, listener);
      for (const audio of [loop, shot]) { audio?.removeAttribute('src'); audio?.load(); }
      loop = undefined; shot = undefined;
    },
  };
}

export function bindNotificationSounds() {
  const get = <T extends HTMLElement>(id: string) => {
    const element = document.getElementById(id);
    if (!element) throw new Error('Missing SE control: ' + id);
    return element as T;
  };
  const enabled = get<HTMLInputElement>('se-enabled'), volume = get<HTMLInputElement>('se-volume');
  const output = get<HTMLOutputElement>('se-volume-value'), status = get<HTMLElement>('se-status');
  const success = get<HTMLButtonElement>('se-test-success'), error = get<HTMLButtonElement>('se-test-error');
  let storage: SoundStorage | undefined;
  try { storage = window.localStorage; } catch { /* Storage may be disabled by browser policy. */ }
  const render = (value: NotificationSoundSettings) => {
    enabled.checked = value.enabled; volume.value = String(value.volume); output.textContent = value.volume + '%';
  };
  const manager = createNotificationSoundManager({ baseUrl: document.baseURI, storage,
    onSettings: render, onStatus: text => { status.textContent = text; } });
  render(manager.settings);
  const changeEnabled = () => { manager.setSettings({ enabled: enabled.checked }); };
  const changeVolume = () => { manager.setSettings({ volume: Math.max(0, Math.min(100, Number(volume.value) || 0)) }); };
  const playSuccess = () => { manager.success(); }, playError = () => { manager.error(); };
  const hide = () => { manager.cancel(); };
  enabled.addEventListener('change', changeEnabled); volume.addEventListener('input', changeVolume);
  success.addEventListener('click', playSuccess); error.addEventListener('click', playError); window.addEventListener('pagehide', hide);
  return { working: manager.working, success: manager.success, error: manager.error, cancel: manager.cancel,
    destroy() {
      enabled.removeEventListener('change', changeEnabled); volume.removeEventListener('input', changeVolume);
      success.removeEventListener('click', playSuccess); error.removeEventListener('click', playError); window.removeEventListener('pagehide', hide);
      manager.destroy();
    } };
}
