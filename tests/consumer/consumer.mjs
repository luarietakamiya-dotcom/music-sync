import assert from 'node:assert/strict';
import * as core from '@music-sync/core';

const expected = ['REFERENCE_BANDS','BATCH_LOUDNESS_LIMITS','analyzeReference','profileFromMeasurements','validateReferenceProfile','validateReferenceSelection','referenceDistance','planReferenceCorrection','evaluateReferenceQuality','applyReferenceFinishing','planBatchLoudness','createFinishingDifferenceMeter', 'createLongPreferences', 'StreamingAudioAnalyzer', 'createLongMix', 'longMasterGain', 'checkLongCandidate', 'floatWavHeader', 'writeFloatSamples', 'COMPARISON_POLICY', 'LIMITS', 'MASTERING_POLICY', 'analyzeAudio', 'capabilities', 'createComparisonPlan',
  'defaultProcessingChain', 'encodeFloatWav', 'masterAudio', 'planMastering', 'processAudio', 'singleSourceGainDb',
  'validateAudio', 'validateMasteringOptions', 'validateProcessingChain', 'AUTO_MODES', 'AUTO_ENGINE_LIMITS',
  'autoMixMaster', 'planMixCorrection', 'detectProblems', 'evaluateAutoQuality', 'analyzeAdaptiveFeatures', 'analyzePerceptualFeatures', 'PerceptualAnalyzer', 'PERCEPTUAL_BANDS', 'detectPerceptualProblems', 'evaluatePerceptualQuality', 'createBlindComparison',
  'SOUND_COLOR_INTENSITIES', 'SOUND_COLOR_POLICY', 'SOUND_COLOR_PRESETS', 'applySoundColor', 'evaluateSoundColorQuality', 'planSoundColor', 'validateSoundColorSelection',
  'LIVE_SPACES', 'LIVE_INTENSITIES', 'DEFAULT_LIVE_SELECTION', 'validateLiveSelection',
  'DEFAULT_FINISH_CONTROLS', 'FINISH_CONTROL_LABELS', 'OUTPUT_PROFILES', 'validateFinishingPreferences', 'planFinishControls', 'applyFinishingPreferences',
  'STEM_LIMITS', 'STEM_ROLES', 'suggestStemRole', 'planStemMix', 'createStemMixSession', 'mixStems', 'finishStemMix', 'masterStemMix', 'anonymizeFinishingReport', 'planStemBalance', 'mixStemsWithBalance', 'planStemMasking', 'evaluateStemMasking', 'mixStemsWithCorrection', 'renderFileStems', 'TrebleRepair', 'FinishRepair', 'applyGrainRestoration', 'prepareGrainRestoration', 'prepareStemRestoration', 'renderStemRestoration', 'resolveStemGrainRestoration', 'createStemClarityAnalyzer', 'planStemClarity', 'planStemVocalSupport', 'evaluateStemClarityQuality', 'suggestStemVocalRole'];
assert.deepEqual(Object.keys(core).sort(), expected.sort());
const input = { sampleRate: 48000, channels: [Float32Array.from({ length: 24000 }, (_, i) => 0.1 * Math.sin(2 * Math.PI * 1000 * i / 48000))] };
const before = input.channels[0].slice(), analysis = core.analyzeAudio(input);
assert.equal(analysis.schemaVersion, 1); assert.equal(analysis.algorithmVersion, '0.1.0');
assert.equal(core.defaultProcessingChain().version, 1);
const result = core.masterAudio(input, { targetLufs: -14, ceilingDb: -1 });
assert.equal(result.status, 'accepted');
assert.ok(Math.abs(result.after.integratedLufs + 14) < 0.5);
const pair = core.createComparisonPlan(analysis, result.after); assert.equal(pair.match.available, true);
assert.equal(new DataView(core.encodeFloatWav(result.processed.audio)).getUint16(20, true), 3);
assert.deepEqual(input.channels[0], before);
const silence = core.masterAudio({ sampleRate: 48000, channels: [new Float32Array(24000)] }, { targetLufs: -14, ceilingDb: -1 });
assert.equal(silence.status, 'rejected'); assert.equal(silence.processed, undefined);
assert.equal(typeof globalThis.window, 'undefined');
await assert.rejects(import('@music-sync/core/dist/index.js'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
assert.equal(core.suggestStemVocalRole('Lead Vocals.wav'), 'lead');
assert.equal(core.suggestStemVocalRole('Backing Vocals.wav'), 'backing');
const clarityRate=16000, clarityFrames=clarityRate;
const clarityInputs=[['lead','vocal','lead',.02,2300],['guitar','guitar',undefined,.2,2600],['chorus','vocal','backing',.04,2700]].map(([id,role,vocalRole,amplitude,hz])=>{
  const audio={sampleRate:clarityRate,channels:[Float32Array.from({length:clarityFrames},(_,n)=>amplitude*Math.sin(2*Math.PI*hz*n/clarityRate))]};
  return {descriptor:{id,name:id+'.wav',role,vocalRole,sampleRate:clarityRate,channels:1,frames:clarityFrames,gainDb:0,pan:0,muted:false},
    async *open(){yield audio;}};
});
const supportFeatures=core.createStemClarityAnalyzer(clarityRate,1,clarityFrames);
supportFeatures.push({sampleRate:clarityRate,channels:[new Float32Array(clarityFrames).fill(.001)]});
const measuredSupport=supportFeatures.finish();
assert.ok(measuredSupport.bodyEnergy instanceof Float32Array);
assert.equal(core.planStemVocalSupport(measuredSupport,new Float32Array(measuredSupport.bodyRms.length)).seconds,0);
const mixedClarity=await core.renderFileStems(clarityInputs,{mode:'stems',autoBalance:false,clarity:true,blockFrames:clarityFrames,async write(){}});
assert.equal(mixedClarity.report.clarity.status,'applied');
assert.equal(mixedClarity.report.clarity.evaluation.accepted,true);
assert.equal(mixedClarity.analysis.clippedSamples,0);
console.log('Installed Core public API, adaptive STEM mix, schema, master, WAV, ownership and deep-import boundary passed.');
const finishing = core.autoMixMaster(input, 'LIVE');
assert.equal(finishing.status, 'accepted');
assert.equal(finishing.attempts.at(-1).after.clippedSamples, 0);
assert.equal(finishing.perceptual.version, 1);
assert.equal(finishing.attempts.at(-1).objectiveQuality.accepted, true);
const chunkAnalyzer = new core.PerceptualAnalyzer(input.sampleRate, 1);
chunkAnalyzer.push([input.channels[0].subarray(0, 137)]);
chunkAnalyzer.push([input.channels[0].subarray(137)]);
assert.deepEqual(chunkAnalyzer.finish(), core.analyzePerceptualFeatures(input));
const colour = core.applySoundColor(input, { preset: 'cassette', intensity: 'vivid' });
assert.equal(colour.status, 'accepted');
assert.equal(colour.attempts.at(-1).after.clippedSamples, 0);
assert.ok(core.createComparisonPlan(analysis, colour.attempts.at(-1).after).match.available);
assert.deepEqual(input.channels[0], before);
assert.equal(core.capabilities.soundColor, true);
const venue = core.autoMixMaster(input, 'LIVE', { live: { venue: 'arena', intensity: 'standard' } });
assert.equal(venue.status, 'accepted');
assert.equal(venue.attempts.at(-1).mix.liveSelection.venue, 'arena');
const output = core.autoMixMaster(input, 'AUTO', { preferences: { controls: { ...core.DEFAULT_FINISH_CONTROLS, vocal: 1 }, output: 'youtube' } });
assert.equal(output.status, 'accepted');
assert.equal(output.preferences.selection.output, 'youtube');
assert.deepEqual(core.analyzeAudio(output.processed.audio), output.finalAfter);
const descriptor = id => ({ id, name: `${id}.wav`, role: id === 'voice' ? 'vocal' : 'instrumental', sampleRate: input.sampleRate, channels: 1, frames: input.channels[0].length, gainDb: 0, pan: 0, muted: false });
const stems = core.mixStems([{ descriptor: descriptor('voice'), audio: input }, { descriptor: descriptor('music'), audio: input }], 'vocal-instrumental');
const balancedStems = core.mixStemsWithBalance([{ descriptor: descriptor('voice'), audio: input }, { descriptor: descriptor('music'), audio: input }]);
assert.ok(balancedStems.report.autoBalance);
const correctedStems = core.mixStemsWithCorrection([{ descriptor: descriptor('voice'), audio: input }, { descriptor: descriptor('music'), audio: input }]);
assert.ok(['unchanged', 'skipped'].includes(correctedStems.report.masking.status));
assert.equal(correctedStems.report.plan.tracks[1].presenceDip, undefined);
assert.equal(stems.report.plan.mode, 'vocal-instrumental');
assert.equal(stems.audio.channels.length, 2); assert.equal(stems.analysis.clippedSamples, 0);
const stemFinish = core.finishStemMix(stems);
assert.equal(stemFinish.status, 'accepted');
assert.equal(core.masterStemMix(stems, { targetLufs: stems.analysis.integratedLufs, ceilingDb: -1 }).status, 'accepted');
assert.ok(!JSON.stringify(core.anonymizeFinishingReport(stemFinish)).includes('voice.wav'));
assert.deepEqual(input.channels[0], before);

const referenceRate=24000;
const referencePcm=Float32Array.from({length:referenceRate*3},(_,i)=>
  [.016,.022,.020,.018,.015,.012].reduce((sum,gain,k)=>sum+gain*Math.sin(2*Math.PI*[80,280,700,1800,3500,7000][k]*i/referenceRate),0));
const referenceAudio={sampleRate:referenceRate,channels:[referencePcm]};
const referenceOriginal=referencePcm.slice();
const profile=core.analyzeReference(referenceAudio);
assert.equal(profile.version,1);assert.equal(profile.frequencyCeilingHz,10000);
assert.ok(profile.confidence>=.5);core.validateReferenceSelection({profile,strength:.65});
const referencePlan=core.planReferenceCorrection(core.analyzeAudio(referenceAudio),core.analyzePerceptualFeatures(referenceAudio),profile);
assert.equal(referencePlan.bands.length,0);
const album=core.planBatchLoudness([{id:'one',analysis:analysis},{id:'two',analysis:core.analyzeAudio({sampleRate:input.sampleRate,channels:input.channels.map(channel=>Float32Array.from(channel,x=>x*.5))})}]);
assert.equal(album.tracks.filter(track=>track.status==='ready').length,2);
assert.ok(album.tracks.every(track=>track.gainDb<=3&&track.expectedTruePeakDbtp<=-1+1e-6));
assert.deepEqual(referencePcm,referenceOriginal);
console.log('Installed reference profile and safe batch-loudness API passed.');
