import { expect, it } from 'vitest';
import { createNotificationSoundManager, NOTIFICATION_SOUND_STORAGE_KEY } from '../../apps/web/src/notification-sounds';

class FakeAudio extends EventTarget {
  src: string; loop = false; volume = 1; preload = ''; currentTime = 0; active = false;
  plays = 0; pauses = 0; loads = 0;
  playResult?: () => Promise<void>;
  constructor(url: string) { super(); this.src = url; }
  play() { this.plays++; this.active = true; return this.playResult?.() ?? Promise.resolve(); }
  pause() { this.pauses++; this.active = false; }
  load() { this.loads++; }
  removeAttribute(name: string) { if (name === 'src') this.src = ''; }
}
function fixture(value?: string, brokenStorage = false) {
  const audio: FakeAudio[] = [], statuses: string[] = [], values = new Map<string, string>();
  if (value !== undefined) values.set(NOTIFICATION_SOUND_STORAGE_KEY, value);
  const storage = {
    getItem(key: string) { if (brokenStorage) throw new Error('storage blocked'); return values.get(key) ?? null; },
    setItem(key: string, next: string) { if (brokenStorage) throw new Error('storage blocked'); values.set(key, next); },
  };
  const manager = createNotificationSoundManager({ baseUrl: 'https://local.test/music-sync/index.html', storage,
    audioFactory: url => { const voice = new FakeAudio(url); audio.push(voice); return voice; },
    onStatus: text => statuses.push(text) });
  return { manager, audio, statuses, values };
}
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };

it('starts only for processing, loops once, and switches to distinct completion/error sounds without mixing voices', async () => {
  const { manager, audio } = fixture();
  expect(audio).toHaveLength(0);
  manager.working(false); expect(audio).toHaveLength(0);
  manager.working(true); manager.working(true);
  expect(audio).toHaveLength(1); expect(audio[0].plays).toBe(1);
  expect(audio[0].src).toBe('https://local.test/music-sync/sfx/processing_loop.wav');
  expect(audio[0].loop).toBe(true); expect(audio[0].volume).toBe(0.25);
  manager.working(false); expect(audio[0].active).toBe(false); expect(audio).toHaveLength(1);
  manager.working(true); manager.success(); await settle();
  expect(audio).toHaveLength(2); expect(audio[0].active).toBe(false);
  expect(audio[1].active).toBe(true); expect(audio[1].loop).toBe(false); expect(audio[1].src).toMatch(/success\.wav$/);
  manager.error(); await settle();
  expect(audio).toHaveLength(2); expect(audio[1].src).toMatch(/error\.wav$/);
  expect(audio.filter(voice => voice.active)).toHaveLength(1);
  manager.working(true); expect(audio[1].active).toBe(false); expect(audio[0].active).toBe(true);
  manager.cancel(); expect(audio.every(voice => !voice.active)).toBe(true);
});

it('updates dedicated SE volume, immediately mutes all voices, persists settings and resumes only an active processing loop', () => {
  const { manager, audio, values } = fixture();
  manager.working(true); manager.setSettings({ volume: 40 }); expect(audio[0].volume).toBe(0.4);
  manager.setSettings({ enabled: false }); expect(audio[0].active).toBe(false);
  const plays = audio[0].plays;
  manager.error(); expect(audio).toHaveLength(1);
  manager.setSettings({ enabled: true }); expect(audio[0].plays).toBe(plays);
  manager.working(true); manager.setSettings({ volume: 0 }); expect(audio[0].active).toBe(false);
  manager.setSettings({ volume: 60 }); expect(audio[0].active).toBe(true); expect(audio[0].volume).toBe(0.6);
  expect(JSON.parse(values.get(NOTIFICATION_SOUND_STORAGE_KEY)!)).toEqual({ enabled: true, volume: 60 });
  manager.success(); manager.setSettings({ volume: 35 }); expect(audio[1].volume).toBe(0.35);
  manager.setSettings({ enabled: false }); expect(audio.every(voice => !voice.active)).toBe(true);
  const copied = manager.settings; copied.enabled = true; copied.volume = 100;
  expect(manager.settings).toEqual({ enabled: false, volume: 35 });
});

it('loads safe saved settings without playing and tolerates invalid or blocked storage', () => {
  const saved = fixture(JSON.stringify({ enabled: false, volume: 54 }));
  expect(saved.manager.settings).toEqual({ enabled: false, volume: 54 });
  saved.manager.working(true); expect(saved.audio).toHaveLength(0);
  for (const value of ['bad JSON', 'null', '[]', '{"enabled":"yes","volume":1000}'])
    expect(fixture(value).manager.settings).toEqual({ enabled: true, volume: 25 });
  const blocked = fixture(undefined, true);
  expect(() => { blocked.manager.working(true); blocked.manager.setSettings({ volume: 12 }); blocked.manager.success(); }).not.toThrow();
  expect(blocked.manager.settings.volume).toBe(12);
  expect(blocked.statuses.some(text => text.includes('保存できません'))).toBe(true);
});

it('stops late play completion after cancellation and releases all media/listeners on destroy', async () => {
  const { manager, audio, statuses } = fixture();
  manager.working(true); await settle(); manager.cancel();
  let resolve!: () => void;
  audio[0].playResult = () => new Promise<void>(done => { resolve = done; });
  manager.working(true); manager.cancel();
  audio[0].active = true; resolve(); await settle();
  expect(audio[0].active).toBe(false);
  manager.success(); await settle(); const count = statuses.length;
  manager.destroy();
  expect(audio.every(voice => !voice.active && voice.src === '')).toBe(true);
  audio[0].dispatchEvent(new Event('error')); audio[1].dispatchEvent(new Event('error'));
  manager.working(true); manager.success(); manager.error(); manager.setSettings({ volume: 70 });
  expect(statuses).toHaveLength(count); expect(audio).toHaveLength(2);
});

it('does not let an old play promise stop a newer operation on the same native voice', async () => {
  const { manager, audio } = fixture();
  manager.working(true); await settle(); manager.cancel();
  let resolve!: () => void;
  audio[0].playResult = () => new Promise<void>(done => { resolve = done; });
  manager.working(true); manager.cancel();
  const first = resolve;
  audio[0].playResult = undefined; manager.working(true); await settle(); first(); await settle();
  expect(audio[0].active).toBe(true);
  manager.cancel(); expect(audio[0].active).toBe(false);
});

it('treats autoplay, decode and construction failures as optional SE failures instead of processing errors', async () => {
  const { manager, audio, statuses } = fixture();
  manager.working(true); await settle(); manager.cancel();
  audio[0].playResult = () => Promise.reject(new DOMException('blocked', 'NotAllowedError'));
  expect(() => manager.working(true)).not.toThrow(); await settle();
  expect(audio[0].active).toBe(false); expect(statuses.some(text => text.includes('再生できません'))).toBe(true);
  manager.success(); audio[1].dispatchEvent(new Event('error')); expect(audio[1].active).toBe(false);
  const failed = createNotificationSoundManager({ baseUrl: 'https://local.test/', audioFactory() { throw new Error('unavailable'); } });
  expect(() => { failed.working(true); failed.success(); failed.error(); failed.destroy(); }).not.toThrow();
});

it('rejects invalid new settings without partially changing persisted or active state', () => {
  const { manager, audio } = fixture(); manager.working(true);
  for (const volume of [-1, 101, NaN, Infinity]) expect(() => manager.setSettings({ enabled: false, volume })).toThrow();
  expect(manager.settings).toEqual({ enabled: true, volume: 25 }); expect(audio[0].active).toBe(true);
  manager.setSettings({ enabled: undefined, volume: undefined });
  expect(manager.settings).toEqual({ enabled: true, volume: 25 });
});
