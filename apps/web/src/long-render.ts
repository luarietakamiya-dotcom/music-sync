import {finishReferenceFile} from './reference-file';
import { validateReferenceSelection, resolveStemGrainRestoration, type StemMixReport, prepareGrainRestoration, createFinishingDifferenceMeter, createLongPreferences, DEFAULT_FINISH_CONTROLS, type FinishControls, type TrebleRepairReport, FinishRepair, type RepairControls, type TrebleMode, StreamingAudioAnalyzer, createLongMix, longMasterGain, checkLongCandidate, floatWavHeader, writeFloatSamples, type AnalysisResult, type AutoMode, type LiveSelection, type OutputProfileId } from '@music-sync/core';
import { readWavFileMetadata, streamWavChunks } from './wav-stream';

export interface LongRenderRequest {
  reference?:import('@music-sync/core').ReferenceSelection;
  kind: 'long-render'; sourceMix?: StemMixReport; file: File; destination: FileSystemFileHandle; before: AnalysisResult;
  treble?: TrebleMode; repairControls?: RepairControls; controls?: FinishControls; aggression?: number; mode: AutoMode; live: LiveSelection; output: OutputProfileId;
}

export async function renderLong(request: LongRenderRequest, reportProgress: (fraction: number, stage: string) => void) {
  if(request.reference)validateReferenceSelection(request.reference);
  const progress=(fraction:number,stage:string)=>reportProgress(request.reference?fraction*.65:fraction,stage);
  const { file, destination, before, mode, live, output } = request;
  const controls = request.controls ?? DEFAULT_FINISH_CONTROLS;
  const info = await readWavFileMetadata(file);
  const meter = () => new StreamingAudioAnalyzer(info.sampleRate, info.channels, info.frames);
  const rawSource = () => streamWavChunks(file, info);
  const decision = resolveStemGrainRestoration(request.sourceMix, request.repairControls);
  const preparedGrain = await prepareGrainRestoration({sampleRate:info.sampleRate,channels:info.channels,frames:info.frames,open:rawSource},decision.controls,
    {onProgress:fraction=>progress(fraction * 0.08,'Grain analysis')});
  const grain = { ...preparedGrain, report: decision.report ?? preparedGrain.report };
  const repair = new FinishRepair(info.sampleRate, info.channels, decision.suppressTreble ? 'off' : request.treble ?? 'off', { ...decision.controls, grain:'off' });
  if (repair.needsAnalysis) {
    let scanned = 0;
    for await (const chunk of grain.open()) {
      repair.analyze(chunk); scanned += chunk.channels[0].length;
      progress(0.08 + 0.04 * scanned / info.frames, 'Treble analysis');
    }
  }
  let useRepair = repair.plan();
  if (useRepair) {
    let scanned = 0;
    const filter = repair.previewer();
    for await (const chunk of grain.open()) {
      filter(chunk); scanned += chunk.channels[0].length;
      progress(0.12 + 0.03 * scanned / info.frames, 'Treble evaluation');
    }
    useRepair = repair.evaluate();
  }
  for (const strength of [1, 0.5]) {
    if (strength < 1) progress(0.15, 'Readjusting');
    const source = strength === 1 ? grain.open : rawSource;
    const grainReport = grain.report.status === 'applied' && strength < 1 ? { ...grain.report,status:'reverted' as const,seconds:0,estimatedResidualReductionDb:0,explanation:'全体の判定に合わせ、ジャリつき補修を外して再調整しました。' } : grain.report;
    const applyRepair = useRepair && strength === 1;
    const mixRepair = applyRepair ? repair.renderer() : undefined;
    const intermediate = meter();
    const mix = createLongMix(before, mode, live, strength);
    const preferences = createLongPreferences(before, controls, strength);
    let frames = 0;
    for await (const chunk of source()) {
      mixRepair?.(chunk); mix.processOwned(chunk); if (preferences.applied) preferences.processOwned(chunk);
      intermediate.push(chunk);
      frames += chunk.channels[0].length;
      progress(0.15 + 0.85 * frames / info.frames / 3, 'Analyzing');
    }
    const { target, gainDb } = longMasterGain(intermediate.finish(), mode, output, request.aggression, preferences.density);
    const renderRepair = applyRepair ? repair.renderer() : undefined;
    const render = createLongMix(before, mode, live, strength);
    const renderPreferences = createLongPreferences(before, controls, strength);
    const gain = 10 ** (gainDb / 20);
    const stream = await destination.createWritable();
    try {
      await stream.write(floatWavHeader(info.sampleRate, info.channels, info.frames));
      frames = 0;
      for await (const chunk of source()) {
        renderRepair?.(chunk); render.processOwned(chunk); if (renderPreferences.applied) renderPreferences.processOwned(chunk);
        for (const channel of chunk.channels) for (let i = 0; i < channel.length; i++) channel[i] *= gain;
        const buffer = new ArrayBuffer(chunk.channels[0].length * info.channels * 4);
        writeFloatSamples(chunk, new DataView(buffer));
        await stream.write(buffer);
        frames += chunk.channels[0].length;
        progress(0.15 + 0.85 * (1 + frames / info.frames) / 3, 'Creating candidate');
      }
      await stream.close();
    } catch (error) { await stream.abort().catch(() => {}); throw error; }
    const candidate = await destination.getFile();
    if (candidate.size !== 56 + info.frames * info.channels * 4) throw new Error('候補WAVの長さが一致しません。');
    const resultMeter = meter();
    const difference = createFinishingDifferenceMeter();
    const original = streamWavChunks(file, info);
    frames = 0;
    for await (const chunk of streamWavChunks(candidate, { ...info, bits: 32, format: 3, dataOffset: 56, align: 4 * info.channels })) {
      const dry = await original.next();
      if (dry.done) throw new Error('原音と候補の長さが一致しません。');
      difference.push(dry.value, chunk);
      resultMeter.push(chunk);
      frames += chunk.channels[0].length;
      progress(0.15 + 0.85 * (2 + frames / info.frames) / 3, 'Evaluating');
    }
    if (!(await original.next()).done) throw new Error('原音と候補の長さが一致しません。');
    const differenceDb = difference.finishDb();
    const result = resultMeter.finish();
    if (checkLongCandidate(before, result, target)) {
      let repairReport: TrebleRepairReport = useRepair && !applyRepair
        ? { ...repair.report, status: 'reverted', seconds: 0, highReductionDb: 0, clarityUsed: false, explanation: '全体の再評価で高域補修を外しました。' } : repair.report;
      if (decision.preservationExplanation) repairReport={...repairReport,explanation:decision.preservationExplanation};
      const referenced=request.reference?await finishReferenceFile({file:candidate,analysis:result,original:before},request.reference,destination,(fraction,text)=>reportProgress(.65+.35*fraction,text)):undefined;
      return { file: referenced?.file??candidate, result:referenced?.analysis??result, reference:referenced?.reference, gainDb, target, grain:grainReport, repair: repairReport, differenceDb, toneApplied:referenced?.reference.status==='accepted'|| differenceDb > -50 && (render.toneChanged || renderPreferences.applied || grainReport.status === 'applied'),
        preferences: { requested: { ...controls }, appliedControls: renderPreferences.appliedControls, strength, skipped: renderPreferences.skipped, explanations: renderPreferences.explanations },
        explanations: [...new Set([...(decision.preservationExplanation ? [decision.preservationExplanation] : []),grainReport.explanation, ...render.explanations, ...renderPreferences.explanations, ...renderPreferences.skipped, repairReport.explanation,...(referenced?.reference.explanations??[]),...(referenced?.reference.reasons??[])])] };
    }
  }
  throw new Error('再調整後も品質条件を満たさなかったため候補を保留しました。');
}
