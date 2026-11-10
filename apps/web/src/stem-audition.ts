import { createBlindComparison, type AnalysisResult, type StemAudition } from '@music-sync/core';
import { ComparisonPlayer } from './comparison-player';

type Choice = 'X' | 'Y';
interface Host {
  song(): ComparisonPlayer;
  context(): AudioContext;
  reports(): { a: AnalysisResult; b: AnalysisResult; aLabel: string; bLabel: string } | undefined;
  restore(): void;
  volume(): number;
  time(seconds: number): string;
}
export function bindListeningTest(host: Host) {
  const id = (name: string) => document.getElementById(name)!;
  const dialog = id('listening-test') as HTMLDialogElement;
  const panel = id('stem-audition'), reveal = id('audition-reveal'), result = id('audition-result');
  const preference = id('audition-preference') as HTMLSelectElement;
  const buttons = { X: id('audition-x'), Y: id('audition-y') };
  const pauseButton = id('audition-stop') as HTMLButtonElement;
  let clip: StemAudition | undefined;
  let playback: ComparisonPlayer | undefined;
  let pair: ReturnType<typeof createBlindComparison> | undefined;
  let scope: 'clip' | 'song' = 'song', choice: Choice = 'X';
  let frame = 0, epoch = 0, startPosition = 0, revealed = false;

  function display() {
    cancelAnimationFrame(frame);
    const playing = !!playback?.playing;
    for (const key of ['X', 'Y'] as const) buttons[key].setAttribute('aria-pressed', String(playing && key === choice));
    pauseButton.disabled = !playing;
    const offset = scope === 'clip' && clip ? clip.startFrame / clip.dry.sampleRate : 0;
    id('audition-time').textContent = host.time(offset + (playback?.positionSeconds ?? 0));
    if (playing) frame = requestAnimationFrame(display);
  }
  function close() {
    if (!playback) return;
    epoch++; cancelAnimationFrame(frame); playback.pause();
    if (scope === 'clip') playback.setSources({}, 0);
    playback = undefined; pair = undefined;
    if (dialog.open) dialog.close();
    host.restore();
  }
  function shuffle() {
    const reports = scope === 'clip' && clip ? { a: clip.before, b: clip.after } : host.reports();
    if (!reports) return;
    epoch++; playback?.pause();
    pair = createBlindComparison(reports.a, reports.b, !!(crypto.getRandomValues(new Uint8Array(1))[0] & 1));
    preference.value = ''; preference.disabled = false; choice = 'X'; revealed = false;
    result.textContent = ''; reveal.textContent = '内訳を見る'; display();
  }
  function open(next: 'clip' | 'song') {
    if (dialog.open || (next === 'clip' ? !clip : !host.reports())) return;
    scope = next;
    const song = host.song();
    song.pause();
    if (scope === 'clip' && clip) {
      playback = new ComparisonPlayer(host.context());
      playback.setSources({ a: { audio: clip.dry }, b: { audio: clip.studio } }, clip.before.durationSeconds);
      id('audition-title').textContent = 'STEMの調整を耳で比較';
      id('audition-description').textContent = id('audition-range').textContent;
    } else {
      playback = song;
      id('audition-title').textContent = '原音と仕上がりを耳で比較';
      id('audition-description').textContent = '現在の再生位置から、音量をそろえて試聴します。';
    }
    startPosition = playback.positionSeconds;
    shuffle(); dialog.showModal();
  }
  async function listen(next: Choice) {
    if (!playback || !pair) return;
    const current = epoch;
    try {
      choice = next;
      playback.configure(pair.mapping[next], pair.gainsDb, host.volume());
      await playback.play();
      if (current === epoch) display();
    } catch {
      if (current === epoch) { playback?.pause(); display(); result.textContent = '試聴を開始できませんでした。もう一度音を選んでください。'; }
    }
  }
  id('blind-song').addEventListener('click', () => open('song'));
  id('blind-stem').addEventListener('click', () => open('clip'));
  buttons.X.addEventListener('click', () => void listen('X'));
  buttons.Y.addEventListener('click', () => void listen('Y'));
  pauseButton.addEventListener('click', () => { epoch++; playback?.pause(); display(); });
  id('audition-restart').addEventListener('click', async () => {
    if (!playback) return;
    const current = ++epoch;
    playback.pause();
    try {
      await playback.seek(startPosition);
      if (current === epoch) await listen(choice);
    } catch {
      if (current === epoch) { display(); result.textContent = '試聴の開始位置に戻れませんでした。'; }
    }
  });
  id('audition-close').addEventListener('click', close);
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  reveal.addEventListener('click', () => {
    if (!pair) return;
    if (revealed) { shuffle(); return; }
    const song = host.reports();
    const names = scope === 'clip' ? { a: 'STEM調整前', b: 'STEM調整後' } : { a: song!.aLabel, b: song!.bLabel };
    const vote = preference.value as Choice | '' | 'same';
    const verdict = vote === 'same' ? ' はっきりした好みの差はありませんでした。' :
      vote ? ' 選んだのは' + names[pair.mapping[vote]] + 'です。' : '';
    result.textContent = '音1は' + names[pair.mapping.X] + '、音2は' + names[pair.mapping.Y] + 'です。' + verdict;
    reveal.textContent = '順番を伏せてもう一度'; preference.disabled = true; revealed = true;
  });
  return {
    close,
    set(next?: StemAudition) {
      close(); clip = next; panel.hidden = !clip;
      if (!clip) return;
      const start = clip.startFrame / clip.dry.sampleRate;
      id('audition-range').textContent = host.time(start) + '〜' + host.time(start + clip.before.durationSeconds) + ' · 調整差のある区間を音量一致で試聴します。';
    },
  };
}
