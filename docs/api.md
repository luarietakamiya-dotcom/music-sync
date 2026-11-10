# Music Sync Core API (0.15.x)

## Reference finishing and batch loudness (0.15.0)

`analyzeReference(audio)` produces a gain-normalized profile. Pass
`reference: { profile, strength: 0.65 }` to `autoMixMaster` or `finishStemMix`.
The result's `reference` report distinguishes accepted, skipped and rejected changes;
a rejected reference stage retains the accepted base candidate. Reference LUFS is not a target.
`planBatchLoudness([{ id, analysis }], { targetLufs: -16, ceilingDb: -1 })`
returns a safe common target and per-track gain/exclusion reasons, without changing PCM.
Apply the plan to independent copies and analyze the saved audio again.

See [the complete guide](reference-and-batch.md). The source checkout includes the
executable example at `examples/reference-and-batch.mjs`. The Web file/ZIP coordinator is
separate from these reusable, browser-independent Core APIs.


## STEM input (0.11.0)

`STEM_ROLES`, `STEM_LIMITS` and `suggestStemRole(name)` expose file-role/bound
metadata. `planStemMix(descriptors, mode?)` validates formats/budgets without
allocating PCM. `mixStems([{ descriptor, audio }, ...], mode?, options?)` returns
an immutable-input stereo bus with track/bus analysis. Streaming hosts use
`createStemMixSession(descriptors, mode?, signal?)`, add tracks in descriptor
order and finish the bus. Use `finishStemMix(mixed, mode?, options?)` or
`masterStemMix(mixed, masteringOptions, onProgress?)` to retain source quality
evidence. These accept `{ audio, report }`, reject malformed/mismatched reports or
included clipped sources before processing, and return `sourceMix` with the result.
The automatic options are the existing AutoFinishOptions, including cancellation.
Bare-PCM APIs cannot infer pre-sum source history. See [contract and example](stem-input.md).

`anonymizeFinishingReport(summary)` returns a JSON-compatible sharing copy without
changing the input. Numeric evidence and fixed public enum values remain; source
names/IDs become aliases and free-text values are redacted. Use a summary without
PCM; processed/audio fields and typed buffers are omitted defensively. This is for
MusicSync-generated reports, not arbitrary user-defined schema keys. Full reports
may contain filenames and are not anonymized by default at the Core API boundary.

## Finishing preferences (0.10.0)

`AutoFinishOptions.preferences` accepts `{ controls, output }`. Combine levels
0–3 from `DEFAULT_FINISH_CONTROLS` (`vocal`, `bass`, `clarity`, `warmth`, `punch`,
`width`, `density`) with an `OUTPUT_PROFILES` key. Automatic results expose
`preferences` with attempts, requested/actual LUFS, target attainment and human
explanations. `finalAfter` measures the exported PCM, after all selected effects.
`planFinishControls` and `applyFinishingPreferences` work independently of Web.
See [parameters, bounds, compatibility and example](finishing-preferences.md).

`@music-sync/core` exports `analyzeAudio`, `validateAudio`, `LIMITS`, `capabilities`,
and the `AudioData`, `AnalysisResult`, `AudioProcessor` TypeScript types.

```ts
import { analyzeAudio, type AudioData } from '@music-sync/core';

const input: AudioData = {
  sampleRate: 48000,
  channels: [new Float32Array(48000)],
};
const report = analyzeAudio(input, {
  waveformBins: 800,                // integer 1–4096; default 1000
  onProgress: fraction => console.log(fraction),
});
```

Planar PCM: each channel has the same positive frame count and owns finite Float32
samples. Magnitudes above 1 are retained and counted, not normalized away; magnitudes
above 32 are rejected as outside this release's supported input range. Sample
rates are integer 8–192 kHz; mono/stereo only. Duration and decoded memory caps are
also enforced for library callers. Validation throws `Error` on invalid input.

`analyzeAudio` is synchronous and never changes input. The return value contains
only numbers, nulls, strings and arrays; safe for JSON. It includes `schemaVersion`
and `algorithmVersion`; consumers must not assume they are interchangeable.
See [measurement definitions](measurement.md). Reports intentionally omit local
paths and filenames. The UI renders names as text.

For a browser host, copy/transfer planar PCM to a Worker before calling Core.
Transferring detaches sender buffers: callers must decide ownership. The Web app
returns the PCM to the main thread after analysis for playback. Cancelling a
synchronous analysis call requires terminating its worker; `onProgress` is not
an asynchronous yield or a signal check.

Core has no browser decoder or filesystem reader. Decode at the adapter boundary,
then pass PCM. With Web Audio, `decodeAudioData` resamples to context rate, so choose
the correct context rate or use a source-preserving decoder.

`AudioProcessor` remains a reserved async adapter interface. The implemented
`processAudio` function is synchronous; hosts manage cancellation via Workers.
`capabilities` enables analysis, A/B, matching, DSP, automatic loudness mastering
and audio export. Mastering is an experimental rule engine with explicit limits.

## Packaging

Each package exposes built ESM and declarations from `dist`. Build order is shared,
DSP, audio-analysis, Core, UI, then Web. Development/test aliases point to the same
source. `examples/analyze-tone.mjs` imports built exports via npm workspaces, and
is included in CI. No UI import is needed for Node consumption.

Phase 5 supports external installation from local release tarballs and a standalone
browser ESM build. See [distribution](distribution.md) and [compatibility](compatibility.md).
There is no npm registry publication yet. Do not use internal source imports.

## Comparison planning (Core 0.2.0)

`createComparisonPlan(aReport, bReport)` validates a compatible pair and returns
`durationSeconds`, `lengthMismatch`, `rawGainsDb` and `match`. Match contains
`available`, `reason`, `gainsDb`, `targetLufs` and `sharedAttenuationDb`.
It neither mutates PCM/reports nor plays audio. See [comparison API example](comparison.md).

## Offline processing and export (0.3.0)

`defaultProcessingChain()` returns fresh version-1 settings. `validateProcessingChain`
checks settings against a sample rate. `processAudio(input, chain, onProgress?)`
returns `{ audio, chain, maxReductionDb, peakGuardDb }` without mutating input.
`encodeFloatWav(audio)` returns an ArrayBuffer; the caller handles saving.
See [bounds, algorithm and consumer example](processing.md).

## Automatic loudness mastering (0.4.0)

`planMastering(report, options)` returns an advisory plan. `masterAudio(input,
options, onProgress?)` independently re-measures input and returns an accepted or
rejected result; `processed` is absent on rejection. Options, result fields and
fixed policy gates are documented in [mastering](mastering.md).

## Adaptive finishing (0.6.0)

`autoMixMaster(input, mode, options?)` runs analysis → problems → Mix plan → mix
processing → intermediate analysis → Master plan → processing → final analysis →
quality evaluation, with at most three attempts. See [automatic finishing](auto-finishing.md)
for new types/limits, read-only ownership, rejection and cancellation semantics.
Existing analysis schemas and manual processing APIs remain unchanged.

## Perceptual intelligence (0.7.0)

`analyzePerceptualFeatures(input)` returns version-1 temporal band statistics and
value/confidence estimates. `PerceptualAnalyzer` exposes chunked push/finish.
`detectPerceptualProblems(features)` returns severity/confidence/evidence issues.
Supply features as the optional fifth argument of `planMixCorrection` to obtain
Phase 7 decisions; automatic finishing supplies them by default.
`evaluatePerceptualQuality(before, after, decisions)` evaluates objective improvement.
`createBlindComparison(a, b, swap)` prepares X/Y mapping with mandatory matching.
See [algorithms, bounds and examples](perceptual-intelligence.md).

## Sound colour choices (0.8.0)

`SOUND_COLOR_PRESETS` and `SOUND_COLOR_INTENSITIES` expose frozen named intents.
`planSoundColor(report, selection)` produces measured-input DSP parameters.
`applySoundColor(input, { preset, intensity }, options?)` returns an accepted or
rejected measured candidate without changing input; `processed` is absent on
rejection. Optional `AutoFinishOptions.soundColor` adds colour after corrective
gates; `finalAfter` describes final PCM. See [sound colour](sound-color.md) for
types, physical gates, neutral behavior and example usage.

## Venue LIVE (0.9.0)

Pass `live: { venue: 'live-house' | 'concert-hall' | 'arena', intensity: 'gentle' |
'standard' | 'vivid' }` to `autoMixMaster(input, 'LIVE', options)`. Omitting it
selects concert-hall/vivid. `LIVE_SPACES`, `LIVE_INTENSITIES`,
`DEFAULT_LIVE_SELECTION` and `validateLiveSelection` expose the named contract.
See [venue design and migration boundaries](live-venues.md).

## Vocal/accompaniment balance (0.12.0)

`mixStemsWithBalance(tracks, options?)` measures the two supplied sources,
creates a bounded role-aware level plan, then sums them with the existing peak
protection. It requires exactly one `vocal` and one `instrumental` descriptor.
The returned `report.autoBalance` records `status`, confidence, measured relative
presence-band levels before/after, track adjustments and an explanation.
`planStemBalance(descriptors, perceptualFeatures)` is the pure planning step for
streaming hosts; Core's Web adapter uses it before a second decode/mix pass.
The optional field does not change the version-1 STEM report. Existing
`mixStems` remains an explicitly manual summation API. Neither API classifies
audio content or guarantees a subjective improvement. See [STEM input](stem-input.md).

## Adaptive pair correction (0.13.0)

`mixStemsWithCorrection(tracks, options?)` combines the existing level planner
with `planStemMasking(descriptors, features, balancePlan)`. When the labelled vocal
still measures well below the accompaniment, the plan proposes a small,
localized accompaniment dip. `evaluateStemMasking(plan, before, after, signal)`
accepts it only after the filtered source is measured. A failed gate restores the
unfiltered accompaniment exactly; both outcomes are recorded in
`StemMixReport.masking`. `mixStemsWithBalance` and manual `mixStems` remain available.
The optional `presenceDip` in a `StemDescriptor` is validated against a supplied
masking plan before a streaming session starts. This is a bounded measurement
heuristic, not semantic vocal recognition or a promised perceptual improvement.
