import { analyzeAudio, processAudio, defaultProcessingChain, masterAudio, applySoundColor, autoMixMaster, type LiveSelection, type SoundColorResult, type AudioData, type MasteringResult } from '@music-sync/core';
const input: AudioData = { sampleRate: 48000, channels: [new Float32Array(48000)] };
const result: MasteringResult = masterAudio(input, { targetLufs: -14, ceilingDb: -1 });
const version: 1 = analyzeAudio(input).schemaVersion;
const samples: readonly Float32Array[] = processAudio(input, defaultProcessingChain()).audio.channels;
void [version, samples];
if (result.status === 'accepted' && result.processed) analyzeAudio(result.processed.audio);
// @ts-expect-error Public PCM contract requires Float32Array, not generic number[].
analyzeAudio({ sampleRate: 48000, channels: [[0, 1]] });
// @ts-expect-error Version-1 chains cannot silently accept a new schema.
processAudio(input, { ...defaultProcessingChain(), version: 2 });
const colour: SoundColorResult = applySoundColor(input, { preset: 'old-record', intensity: 'standard' });
if (colour.processed) analyzeAudio(colour.processed.audio);
// @ts-expect-error Sound colours are named intents, not arbitrary DSP names.
applySoundColor(input, { preset: 'unknown', intensity: 'standard' });
const live: LiveSelection = { venue: 'concert-hall', intensity: 'vivid' };
autoMixMaster(input, 'LIVE', { live });
// @ts-expect-error Venue selection is a bounded named contract.
autoMixMaster(input, 'LIVE', { live: { venue: 'unknown', intensity: 'vivid' } });
import { DEFAULT_FINISH_CONTROLS, applyFinishingPreferences, type FinishingPreferences } from '@music-sync/core';
const preferences: FinishingPreferences = { controls: { ...DEFAULT_FINISH_CONTROLS, vocal: 2, density: 1 }, output: 'cd' };
applyFinishingPreferences(input, preferences);
autoMixMaster(input, 'AUTO', { preferences });
// @ts-expect-error Finishing controls are bounded intent levels.
applyFinishingPreferences(input, { controls: { ...DEFAULT_FINISH_CONTROLS, bass: 4 }, output: 'youtube' });
// @ts-expect-error Output profiles are a named contract.
applyFinishingPreferences(input, { controls: DEFAULT_FINISH_CONTROLS, output: 'unknown' });
import { createStemMixSession, finishStemMix, masterStemMix, anonymizeFinishingReport, planStemBalance, planStemMasking, evaluateStemMasking, mixStemsWithBalance, mixStemsWithCorrection, type StemDescriptor, type StemMixResult } from '@music-sync/core';
declare const stemMix: StemMixResult;
const stemResult = finishStemMix(stemMix, 'AUTO');
anonymizeFinishingReport(stemResult);
masterStemMix(stemMix, { targetLufs: -16, ceilingDb: -1 });
// @ts-expect-error STEM finishing needs source-quality provenance, not bare PCM.
finishStemMix(input);
const track: StemDescriptor = { id: 'voice', name: 'voice.wav', role: 'vocal', sampleRate: input.sampleRate, channels: 1, frames: input.channels[0].length, gainDb: 0, pan: 0, muted: false };
const session = createStemMixSession([track, { ...track, id: 'music', role: 'instrumental' }], 'vocal-instrumental');
session.addTrack('voice', input); session.addTrack('music', input); session.finish();
const balanced = mixStemsWithBalance([{ descriptor: track, audio: input }, { descriptor: { ...track, id: 'music', role: 'instrumental' }, audio: input }]);
const corrected = mixStemsWithCorrection([{ descriptor: track, audio: input }, { descriptor: { ...track, id: 'music', role: 'instrumental' }, audio: input }]);
const correctionStatus: string | undefined = corrected.report.masking?.status;
void correctionStatus;
const balanceAdjustment: number = balanced.report.autoBalance?.tracks[0].adjustmentDb ?? 0;
void balanceAdjustment;
void planStemBalance;
void planStemMasking;
void evaluateStemMasking;
// @ts-expect-error STEM role names are a supported contract.
createStemMixSession([{ ...track, role: 'invented' }, { ...track, id: 'other' }]);

import {analyzeReference,planBatchLoudness,type ReferenceProfile,type ReferenceSelection,type BatchLoudnessPlan} from '@music-sync/core';
const referenceProfile:ReferenceProfile=analyzeReference(input);
const referenceSelection:ReferenceSelection={profile:referenceProfile,strength:.65};
autoMixMaster(input,'AUTO',{reference:referenceSelection});
const albumPlan:BatchLoudnessPlan=planBatchLoudness([{id:'one',analysis:analyzeAudio(input)}],{targetLufs:-16,ceilingDb:-1});
void albumPlan;
// @ts-expect-error Reference requires a measured profile, not a raw audio buffer.
autoMixMaster(input,'AUTO',{reference:{profile:input,strength:.65}});
// @ts-expect-error Batch loudness accepts measured reports, not bare PCM.
planBatchLoudness([{id:'one',analysis:input}]);
