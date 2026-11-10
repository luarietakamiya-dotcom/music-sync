import { StreamingAudioAnalyzer } from '@music-sync/audio-analysis';
import type { AudioData } from '@music-sync/shared';
import { prepareGrainRestoration, type GrainSource } from './grain-restoration.js';
import { FinishRepair } from './finish-repair.js';
import { bounded, type RepairControls } from './studio-settings.js';
import type { TrebleMode } from './treble-repair.js';
import type { StemTrackReport } from './stems.js';

export interface StemRestorationSettings {
  restore: boolean;
  treble?: TrebleMode;
  repair: RepairControls;
}
export interface StemRestorationOptions {
  signal?: AbortSignal;
  progress?(fraction: number, text: string): void;
  blockFrames?: number;
  /** Borrowed original PCM; observers must not modify the channels. */
  onOriginal?(audio: AudioData): void;
  /** Borrowed accepted-grain PCM before treble repair, preserving the pair planner's evidence. */
  onBase?(audio: AudioData): void;
}

function settingsSnapshot(settings: StemRestorationSettings): StemRestorationSettings {
  if (!settings || typeof settings.restore !== 'boolean' || !settings.repair || typeof settings.repair !== 'object' ||
    (settings.treble !== undefined && !['off','auto','light','standard','strong'].includes(settings.treble)))
    throw new Error('素材の補修設定が不正です。');
  const repair = { ...settings.repair };
  if ((repair.grain !== undefined && !['off','light','standard','strong'].includes(repair.grain)) ||
    (repair.repeatGrain !== undefined && typeof repair.repeatGrain !== 'boolean') ||
    (repair.autoClarity !== undefined && typeof repair.autoClarity !== 'boolean'))
    throw new Error('素材の補修設定が不正です。');
  for (const [value, low, high] of [[repair.amount,0,100],[repair.hissHz,7000,11000],[repair.hissDb,0,6],[repair.clarityDb,0,3.5]] as const)
    if (value !== undefined) bounded(value,low,high);
  return { restore: settings.restore, treble: settings.treble, repair };
}

/** The raw and processed readers own bounded chunks and can be opened repeatedly. */
export async function prepareStemRestoration(input: GrainSource, selection: StemRestorationSettings,
  options: StemRestorationOptions = {}) {
  const settings = settingsSnapshot(selection), { signal, progress } = options;
  const { sampleRate, channels, frames } = input;
  const blockFrames = options.blockFrames ?? 65536;
  if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000 || ![1,2].includes(channels) ||
    !Number.isSafeInteger(frames) || frames < 1 || frames > sampleRate * 1200 || typeof input.open !== 'function' ||
    !Number.isInteger(blockFrames) || blockFrames < 1 || blockFrames > 65536)
    throw new Error('素材の補修形式が不正です。');
  signal?.throwIfAborted();
  async function* raw() {
    let read = 0;
    for await (const audio of input.open()) {
      signal?.throwIfAborted();
      const length = audio.channels[0]?.length ?? 0;
      if (audio.sampleRate !== sampleRate || audio.channels.length !== channels || !length || read + length > frames ||
        audio.channels.some(channel => !(channel instanceof Float32Array) || channel.length !== length))
        throw new Error('素材の補修チャンクが一致しません。');
      for (const channel of audio.channels) for (const value of channel)
        if (!Number.isFinite(value) || Math.abs(value) > 32) throw new Error('素材のサンプル値が不正です。');
      read += length;
      yield audio;
    }
    if (read !== frames) throw new Error('素材が途中で切れています。');
    signal?.throwIfAborted();
  }
  async function* packed(source: AsyncIterable<AudioData>) {
    let output = Array.from({length:channels},()=>new Float32Array(blockFrames)), fill = 0;
    for await (const audio of source) {
      signal?.throwIfAborted();
      for (let offset=0;offset<audio.channels[0].length;) {
        const count = Math.min(blockFrames-fill,audio.channels[0].length-offset);
        audio.channels.forEach((channel,c)=>output[c].set(channel.subarray(offset,offset+count),fill));
        offset += count; fill += count;
        if (fill === blockFrames) {
          yield {sampleRate,channels:output};
          output = Array.from({length:channels},()=>new Float32Array(blockFrames)); fill=0;
        }
      }
    }
    if (fill) yield {sampleRate,channels:output.map(channel=>channel.subarray(0,fill))};
  }
  const source = {sampleRate,channels,frames,open:raw};
  const grain = settings.restore ? await prepareGrainRestoration(source,settings.repair,
    {signal,onProgress:fraction=>progress?.(fraction*0.4,'ジャリつきをスペクトル補修しています…')}) : undefined;
  const grainApplied = grain?.report.status === 'applied';
  const treble = settings.restore ? new FinishRepair(sampleRate,channels,settings.treble ?? 'strong',{...settings.repair,grain:'off'}) : undefined;
  const analyzer = new StreamingAudioAnalyzer(sampleRate,channels,frames);
  let read = 0;
  for await (const audio of raw()) {
    analyzer.push(audio); options.onOriginal?.(audio);
    if (!grainApplied) { treble?.analyze(audio); options.onBase?.(audio); }
    read += audio.channels[0].length; progress?.(0.4+0.2*read/frames,'素材を解析しています…');
  }
  const grainOpen = () => packed(grain?.open() ?? raw());
  if (grainApplied) for await (const audio of grainOpen()) { treble?.analyze(audio); options.onBase?.(audio); }
  let trebleApplied = false;
  if (treble?.plan()) {
    progress?.(0.7,'補修効果を確認しています…');
    const filter = treble.previewer();
    for await (const audio of grainOpen()) { signal?.throwIfAborted(); filter(audio); }
    trebleApplied = treble.evaluate(); treble.releaseMeasurements();
  }
  const analysis = analyzer.finish();
  const restoration: NonNullable<StemTrackReport['restoration']> = {
    enabled:settings.restore,
    ...(grain ? {grain:{...grain.report,reasons:[...grain.report.reasons]}} : {}),
    ...(treble ? {treble:{...treble.report}} : {}),
  };
  const renderer = () => trebleApplied && treble ? treble.renderer() : undefined;
  async function* open() {
    const filter = renderer();
    for await (const audio of grainOpen()) { signal?.throwIfAborted(); filter?.(audio); yield audio; }
  }
  progress?.(1,'素材の補修を準備しました。');
  return { analysis, restoration, settings, changed:grainApplied || trebleApplied, grainApplied, trebleApplied,
    grainOpen, renderer, open };
}

/** Render the same accepted per-material repair used before summing, without mix-side effects. */
export async function renderStemRestoration(source: GrainSource, settings: StemRestorationSettings,
  options: StemRestorationOptions & {write(audio:AudioData):Promise<void>}) {
  const prepared = await prepareStemRestoration(source,settings,{...options,progress:(fraction,text)=>options.progress?.(fraction*0.75,text)});
  const meter = new StreamingAudioAnalyzer(source.sampleRate,source.channels,source.frames);
  let written=0;
  for await (const audio of prepared.open()) {
    options.signal?.throwIfAborted(); meter.push(audio); await options.write(audio);
    written += audio.channels[0].length;
    options.progress?.(0.75+0.25*written/source.frames,'補修後の素材を試聴用に保存しています…');
  }
  options.signal?.throwIfAborted();
  if (written !== source.frames) throw new Error('補修した素材の長さが一致しません。');
  return {analysis:meter.finish(),before:prepared.analysis,restoration:prepared.restoration,settings:prepared.settings};
}
