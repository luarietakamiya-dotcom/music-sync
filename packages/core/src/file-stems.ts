import { PerceptualAnalyzer, StreamingAudioAnalyzer, type PerceptualFeatures } from '@music-sync/audio-analysis';
import { prepareStemRestoration } from './stem-restoration.js';
import type { RepairControls } from './studio-settings.js';
import { StemAuditionSelector } from './stem-audition.js';
import { ReferenceStabilizer, type StabilizationSettings } from './reference-stabilizer.js';
import { createStemGain, createStemDuck, humanDouble, createStemAccumulator, createBiquad, peakingCoefficients, TruePeakEstimator } from '@music-sync/dsp';
import type { AudioData } from '@music-sync/shared';
import { createStemClarityAnalyzer, planStemClarity, type StemClarityFeatures } from './stem-clarity.js';
import { evaluateStemClarityQuality } from './stem-clarity-quality.js';
import { planStemBalance } from './stem-balance.js';
import { evaluateStemMasking, planStemMasking } from './stem-masking.js';
import { planStemMix, STEM_LIMITS, type StemDescriptor, type StemMode, type StemTrackReport, type StemMixReport } from './stems.js';

interface FileStem {
  descriptor: StemDescriptor;
  /** Reopen from frame zero on each pass. All non-final chunks have blockFrames frames. */
  open(): AsyncIterable<AudioData>;
}
export interface StemStudioSettings { restore: boolean; treble?: import('./treble-repair.js').TrebleMode; repair: RepairControls; doubleAmount: number; doubleMs: number; stabilize?: StabilizationSettings }
interface FileMixOptions {
  audition?: boolean;
  studio?: StemStudioSettings;
  reference?: () => AsyncIterable<AudioData>;
  mode: StemMode;
  autoBalance: boolean;
  clarity?: boolean;
  vocalSupport?: boolean;
  blockFrames: number;
  write(audio: AudioData): Promise<void>;
  progress?(fraction: number, message: string, indeterminate?: boolean): void;
  signal?: AbortSignal;
}

/** Repeatable bounded reads allow one peak-protection gain across the entire song. */
export async function renderFileStems(inputs: readonly FileStem[], options: FileMixOptions) {
  const { mode, autoBalance, blockFrames, signal } = options;
  if (!Number.isInteger(blockFrames) || blockFrames < 1 || blockFrames > 65536) throw new Error('Invalid stem block size');
  const tracks = inputs.map(input => ({ ...input.descriptor }));
  const plan = planStemMix(tracks, mode, 'file');
  async function* read(index: number) {
    const track = tracks[index];
    let offset = 0;
    for await (const audio of inputs[index].open()) {
      signal?.throwIfAborted();
      const count = Math.min(blockFrames, track.frames - offset);
      if (count <= 0 || audio.sampleRate !== track.sampleRate || audio.channels.length !== track.channels ||
        audio.channels.some(channel => channel.length !== count)) throw new Error('STEMのチャンク長または形式が一致しません。');
      offset += count;
      yield audio;
    }
    if (offset !== track.frames) throw new Error('STEMが途中で切れています。');
  }

  const reports: StemTrackReport[] = [], features: PerceptualFeatures[] = [];
  const studio = options.studio;
  const clarityFeatures: StemClarityFeatures[] = [];
  const notes: string[] = [];
  const repairs: Awaited<ReturnType<typeof prepareStemRestoration>>[] = [];
  const restorers: ((() => (audio: AudioData) => void) | undefined)[] = [];
  const automatic = autoBalance && mode === 'vocal-instrumental';
  for (const [i, descriptor] of tracks.entries()) {
    const { sampleRate, channels, frames } = descriptor;
    const clarityAnalyzer = options.clarity ? createStemClarityAnalyzer(sampleRate, channels, frames) : undefined;
    const perceptual = automatic ? new PerceptualAnalyzer(sampleRate, channels) : undefined;
    const prepared = await prepareStemRestoration({sampleRate,channels,frames,open:()=>read(i)},
      {restore:!!studio?.restore && !descriptor.muted && descriptor.restorationEnabled !== false,repair:studio?.repair ?? {},treble:studio?.treble},
      {signal,blockFrames,onOriginal:block=>clarityAnalyzer?.push(block),onBase:block=>perceptual?.push(block.channels),
        progress:(fraction,text)=>options.progress?.(0.35*(i+fraction)/tracks.length,descriptor.name+' の'+text,fraction<0.4)});
    repairs[i] = prepared;
    if (prepared.trebleApplied) restorers[i] = () => prepared.renderer()!;
    const restoration = studio?.restore || descriptor.restorationEnabled === false ? prepared.restoration : undefined;
    if (restoration?.grain) notes.push(descriptor.name + '：' + restoration.grain.explanation);
    if (restoration?.treble) notes.push(descriptor.name + '：' + restoration.treble.explanation);
    if (descriptor.restorationEnabled === false && studio?.restore) notes.push(descriptor.name + '：この素材の補修をOFFにしました。');
    const analysis = prepared.analysis;
    reports.push({descriptor,analysis,...(restoration ? {restoration} : {})});
    if (clarityAnalyzer) {
      let measured: StemClarityFeatures;
      if (prepared.changed) {
        const corrected = createStemClarityAnalyzer(sampleRate,channels,frames);
        options.progress?.(0.35*(i+1)/tracks.length,descriptor.name+' の歌との重なりを調べています…',true);
        for await (const block of prepared.open()) corrected.push(block);
        measured = corrected.finish();
      } else measured = clarityAnalyzer.finish();
      measured.clippedSamples = analysis.clippedSamples;
      clarityFeatures.push(measured);
    }
    if (perceptual) features.push(perceptual.finish());
  }
  const balance = automatic ? planStemBalance(tracks, features, 'file') : undefined;
  if (balance) tracks.forEach((track, i) => { track.gainDb = balance.tracks[i].gainDb; });
  let masking = balance ? planStemMasking(tracks, features, balance) : undefined;
  if (masking?.status === 'proposed' && masking.dip) {
    options.progress?.(0.35, '声と伴奏の重なりの補正を検証しています…', true);
    const i = tracks.findIndex(track => track.id === masking!.instrumentalId);
    const track = tracks[i];
    if (reports[i].analysis.clippedSamples) {
      masking = { ...masking, status: 'reverted', explanation: '元素材にクリッピングがあるため、帯域補正を適用しませんでした。' };
    } else {
      const { frequencyHz, gainDb, q } = masking.dip;
      const filters = Array.from({ length: track.channels }, () => createBiquad(peakingCoefficients(track.sampleRate, frequencyHz, gainDb, q)));
      const analyzer = new PerceptualAnalyzer(track.sampleRate, track.channels);
      let peak = 0, clipped = 0;
      options.progress?.(0.35, '声と伴奏の重なりを確認しています…');
      for await (const block of repairs[i].grainOpen()) {
        const filtered = block.channels.map((channel, c) => channel.map(value => filters[c](value)));
        for (const channel of filtered) for (const value of channel) {
          peak = Math.max(peak, Math.abs(value));
          if (Math.abs(value) >= 1) clipped++;
        }
        analyzer.push(filtered);
      }
      masking = evaluateStemMasking(masking, features[i], analyzer.finish(), { samplePeak: peak, clippedSamples: clipped });
      if (masking.status === 'applied') track.presenceDip = masking.dip;
    }
  }

  const clarity = options.clarity ? planStemClarity(tracks, clarityFeatures, { signal, vocalSupport: options.vocalSupport }) : undefined;
  let clarityStrength = 1;
  const doubleTracks = tracks.map((t, i) => !!studio?.doubleAmount && !t.muted && t.role === 'guitar' &&
    (reports[i].analysis.stereoCorrelation ?? 1) >= 0.25 && (reports[i].analysis.sideEnergyPercent ?? 0) < 35);
  async function* mixBlocks(neutral = false, includeDry = false, includeClarityBaseline = false) {
    const readers = tracks.map((track, i) => track.muted && !neutral ? undefined :
      (!neutral ? repairs[i].grainOpen() : read(i))[Symbol.asyncIterator]());
    const dryReaders = tracks.map((track,i) => includeDry && !track.muted && repairs[i].grainApplied ? read(i) : undefined);
    const add = tracks.map(t => createStemAccumulator(t.sampleRate, t.channels, neutral ? 0 : t.gainDb, neutral ? 0 : t.pan, neutral ? undefined : t.presenceDip));
    const addDry = includeDry ? tracks.map(t => createStemAccumulator(t.sampleRate, t.channels, t.gainDb, t.pan, t.presenceDip)) : undefined;
    const scratch = [new Float32Array(blockFrames), new Float32Array(blockFrames)];
    const ducks = tracks.map((track,i) => !neutral && !track.muted && clarity?.report.status === 'applied'
      ? createStemDuck(plan.sampleRate,2,clarity.windowFrames,clarity.tracks[i].presenceDb.map(value=>value*clarityStrength),clarity.tracks[i].lowDb.map(value=>value*clarityStrength)) : undefined);
    const gains = tracks.map((track,i) => !neutral && !track.muted && clarity?.report.status === 'applied' && clarity.tracks[i].gainDb
      ? createStemGain(plan.sampleRate,2,clarity.windowFrames,clarity.tracks[i].gainDb!.map(value=>value*clarityStrength)) : undefined);
    const filters = restorers.map(open => !neutral && open ? open() : undefined);
    const doubles = tracks.map((t, i) => !neutral && studio && doubleTracks[i] ?
      humanDouble(t.sampleRate, studio.doubleMs, studio.doubleAmount) : undefined);
    try {
      for (let offset = 0; offset < plan.frames; offset += blockFrames) {
        signal?.throwIfAborted();
        const length = Math.min(blockFrames, plan.frames - offset);
        const channels = [new Float32Array(length), new Float32Array(length)];
        const beforeClarity = includeClarityBaseline ? [new Float32Array(length), new Float32Array(length)] : undefined;
        const dry = addDry ? [new Float32Array(length), new Float32Array(length)] : undefined;
        for (const [i, reader] of readers.entries()) {
          if (!reader || offset >= tracks[i].frames) continue;
          const { value, done } = await reader.next();
          if (done) throw new Error('STEMが途中で切れています。');
          if (dry && addDry) {
            const raw = dryReaders[i] ? await dryReaders[i]!.next() : undefined;
            if (raw?.done) throw new Error('補修前の素材が途中で切れています。');
            addDry[i](raw ? raw.value : value, dry);
          }
          let block = value;
          if (filters[i]) { block = { ...value, channels: value.channels.map(ch => ch.slice()) }; filters[i]?.(block); }
          if (doubles[i] || ducks[i]?.applied || gains[i]?.applied || beforeClarity) {
            const stereo = scratch.map(channel => { channel.fill(0, 0, length); return channel.subarray(0, length); });
            add[i](block, stereo); doubles[i]?.({ sampleRate: plan.sampleRate, channels: stereo });
            if (beforeClarity) for (let c=0; c<2; c++) for (let n=0; n<length; n++) beforeClarity[c][n] += stereo[c][n];
            ducks[i]?.processOwned({ sampleRate: plan.sampleRate, channels: stereo });
            gains[i]?.processOwned({ sampleRate: plan.sampleRate, channels: stereo });
            for (let c=0; c<2; c++) for (let n=0; n<length; n++) channels[c][n] += stereo[c][n];
          } else add[i](block, channels);
        }
        yield { sampleRate: plan.sampleRate, channels, dry, beforeClarity };
      }
    } finally {
      for (const reader of readers) await reader?.return?.();
      for (const reader of dryReaders) await reader?.return?.();
    }
  }
  let stabilization: ReferenceStabilizer | undefined;
  if (options.reference && studio?.stabilize) {
    options.progress?.(0.4, '原曲とSTEMを照合し、短い音量差を調べています…', true);
    stabilization = new ReferenceStabilizer(plan.sampleRate, studio.stabilize);
    const reader = options.reference()[Symbol.asyncIterator]();
    try {
      for await (const block of mixBlocks(true)) {
        const next = await reader.next();
        if (next.done) throw new Error('原曲がSTEMより短くなっています。');
        stabilization.measure(block, next.value);
      }
      if (!(await reader.next()).done) throw new Error('原曲がSTEMより長くなっています。');
    } finally { await reader.return?.(); }
    stabilization.plan(); notes.push(stabilization.explanation);
  }
  if (studio?.doubleAmount) {
    const count = doubleTracks.filter(Boolean).length;
    notes.push(count ? 'ギター' + count + '素材にHuman Doubleを加えました。' : '対象のギターがないか、すでに広いためダブリングを見送りました。');
  }
  const ceiling = 10 ** (STEM_LIMITS.ceilingDb / 20);
  const outputGain = (peak: number) => peak > ceiling ? ceiling / peak * (1 - 1e-6) : 1;
  const stabilizeOutput = stabilization?.renderer();
  async function measureCandidate(validate: boolean) {
    const peaks = [new TruePeakEstimator(), new TruePeakEstimator()];
    const baselinePeaks = validate ? [new TruePeakEstimator(), new TruePeakEstimator()] : undefined;
    const originalMeter = validate ? new StreamingAudioAnalyzer(plan.sampleRate,2,plan.frames) : undefined;
    const candidateMeter = validate ? new StreamingAudioAnalyzer(plan.sampleRate,2,plan.frames) : undefined;
    const normalize = 1 / (4 * Math.max(1,tracks.filter(t=>!t.muted).reduce((sum,t)=>sum+10**(t.gainDb/20),0)));
    const centerCandidate = stabilization?.renderer(), centerOriginal = stabilization?.renderer();
    let offset = 0;
    for await (const block of mixBlocks(false,false,validate)) {
      centerCandidate?.(block);
      block.channels.forEach((channel,i)=>peaks[i].push(channel));
      if (validate && block.beforeClarity && originalMeter && candidateMeter) {
        const original = {sampleRate:plan.sampleRate,channels:block.beforeClarity};
        centerOriginal?.(original);
        original.channels.forEach((channel,i)=>baselinePeaks![i].push(channel));
        originalMeter.push({sampleRate:plan.sampleRate,channels:original.channels.map(ch=>ch.map(value=>value*normalize))});
        candidateMeter.push({sampleRate:plan.sampleRate,channels:block.channels.map(ch=>ch.map(value=>value*normalize))});
      }
      offset += block.channels[0].length;
      options.progress?.(0.4+0.3*offset/plan.frames,validate ? '自動ミックス後の強弱・広がりを検証しています…' : '曲全体のピークを確認しています…');
    }
    const peak = Math.max(...peaks.map(p=>p.finish()));
    const beforePeak = baselinePeaks ? Math.max(...baselinePeaks.map(p=>p.finish())) : peak;
    return {peak, evaluation:originalMeter && candidateMeter ?
      evaluateStemClarityQuality(originalMeter.finish(),candidateMeter.finish(),clarityStrength,
        {beforeGain:outputGain(beforePeak),afterGain:outputGain(peak),measurementGain:normalize}) : undefined};
  }
  let measured = await measureCandidate(clarity?.report.status === 'applied');
  if (clarity?.report.status === 'applied') {
    if (!measured.evaluation!.accepted) {
      clarityStrength = 0.5;
      options.progress?.(0.4,'自動ミックスの調整量を半分にして、もう一度確認しています…');
      measured = await measureCandidate(true);
    }
    clarity.report.evaluation = measured.evaluation;
    if (!measured.evaluation!.accepted) {
      clarity.report.status = 'reverted';
      clarity.report.reasons = [...measured.evaluation!.reasons];
      clarity.report.explanations = ['全体の強弱・広がりの保護条件を満たさず、自動ミックスを見送りました。'];
      clarity.report.maskedSeconds = 0; clarity.report.projectedPresenceImprovementDb = 0;
      clarity.report.tracks = clarity.report.tracks.map(t=>({...t,presenceSeconds:0,lowSeconds:0,maxPresenceReductionDb:0,maxLowReductionDb:0,...(t.supportSeconds !== undefined ? {supportSeconds:0,maxSupportGainDb:0} : {})}));
      measured = await measureCandidate(false);
    } else {
      clarity.report.tracks = clarity.report.tracks.map(t=>({...t,maxPresenceReductionDb:t.maxPresenceReductionDb*clarityStrength,maxLowReductionDb:t.maxLowReductionDb*clarityStrength,...(t.maxSupportGainDb !== undefined ? {maxSupportGainDb:t.maxSupportGainDb*clarityStrength} : {})}));
      clarity.report.projectedPresenceImprovementDb *= clarityStrength;
      clarity.report.explanations = clarity.report.explanations.map(text=>text.replace('整理する計画を作りました。','整理しました。').replace('少し控える計画を作りました。','少し控えました。').replace('支える計画を作りました。','支えました。'));
      if (clarityStrength < 1) clarity.report.explanations.push('強弱と広がりを保つため、調整量を半分にしました。');
    }
    notes.push(...clarity.report.explanations,...clarity.report.reasons);
  } else if (clarity) notes.push(...clarity.report.reasons);
  const gain = outputGain(measured.peak);
  const meter = new StreamingAudioAnalyzer(plan.sampleRate, 2, plan.frames);
  const hasStudioChanges = stabilization?.applied || restorers.some(Boolean) || repairs.some(repair=>repair.grainApplied) || doubleTracks.some(Boolean) || clarity?.report.status === 'applied';
  const selector = options.audition && hasStudioChanges ? new StemAuditionSelector(plan.sampleRate, plan.frames) : undefined;
  let offset = 0;
  for await (const { dry, ...block } of mixBlocks(false, !!selector)) {
    stabilizeOutput?.(block);
    if (selector && dry) selector.push(dry, block.channels);
    if (gain !== 1) for (const channel of block.channels) for (let i = 0; i < channel.length; i++) channel[i] *= gain;
    meter.push(block);
    await options.write(block);
    offset += block.channels[0].length;
    options.progress?.(0.7 + 0.3 * offset / plan.frames, '試聴用のミックスを保存しています…');
  }
  signal?.throwIfAborted();
  const warnings = [...notes];
  if (tracks.some(t => t.frames !== plan.frames)) warnings.push('短い素材の末尾を無音で補いました。');
  if (reports.some(t => t.analysis.clippedSamples)) warnings.push('元の素材にクリッピングがあります。');
  const attenuationDb = 20 * Math.log10(gain);
  if (gain < 1) warnings.push('合算ピークの保護のため全体を' + (-attenuationDb).toFixed(1) + ' dB下げました。');
  const analysis = meter.finish();
  analysis.warnings.push(...warnings);
  const report: StemMixReport = { version: 1, plan: planStemMix(tracks, mode, 'file'), tracks: reports, warnings, attenuationDb, autoBalance: balance, masking, ...(clarity ? {clarity:clarity.report} : {}) };
  return { analysis, report, audition: selector?.finish() };
}
