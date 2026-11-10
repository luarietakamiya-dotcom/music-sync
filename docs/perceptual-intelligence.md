# Phase 7: Perceptual Analysis & Adaptive Mix Intelligence

The AUTO / IMPACT / LIVE workflow remains one click. A local, deterministic
perceptual feature layer now supplements the existing meter. These are engineering
proxies for listening problems, **not semantic recognition, trained AI or a quality
guarantee**. No new runtime service or third-party DSP dependency is required.

## Analysis and responsibility boundaries

`audio-analysis/perceptual.ts` owns `PerceptualAnalyzer` and
`analyzePerceptualFeatures`. `core/auto/perceptual-decisions.ts` detects issues and
refines plans. `dsp/band-dynamics.ts` owns Dynamic EQ and multiband algorithms,
executed through the generic `renderMix` boundary. `core/auto/objective-quality.ts`
compares plan objectives against the output. The UI only sends a mode to the Worker
and displays its returned evidence.

The existing `analyzeAudio` schema 1 / algorithm 0.1.0 is unchanged. New features
have a separate `version: 1`; automatic results include additive `perceptual`,
`mix.perceptual` and `objectiveQuality` fields. Calling the four-argument
`planMixCorrection` remains compatible with Phase 6. The automatic engine always
provides the new optional fifth argument to use Phase 7 decisions.

## Frequency and temporal features

Stereo channels are transformed separately, so anti-phase material does not
disappear through a mono downmix. A 2048-sample Hann window with 1024-sample hop
uses all successive active windows. Each band retains mean energy fraction,
p50/p90 fraction, excess occupancy, average RMS and p90/p10 level range.
Histograms have 1001 fixed bins; no song-sized spectrum/time array is retained.
Windows below -120 dBFS RMS are excluded from active statistics. The final
sub-window remainder after at least one full window is not independently measured.

| Band | Hz |
| --- | --- |
| Sub | below 60 |
| Low | 60–180 |
| Low-Mid | 180–400 |
| Mid | 400–1000 |
| Upper-Mid | 1000–2500 |
| Presence | 2500–5000 |
| High | 5000–10000 |
| Air | above 10000, up to Nyquist |

Additional measured descriptors: spectral centroid, 85% energy rolloff, positive
normalized spectral flux, global crest, RMS-envelope attacks, onset rate and attack
variation, window correlation, total Mid/Side energy, low-frequency Mid/Side energy,
and slow spectrally stable decay occupancy. Resolution is sampleRate / 2048;
low-frequency precision is reduced at high sample rates. This is not a calibrated
psychoacoustic masking, vocal, stem or reverberation meter.

Every inferred feature has `{ value, confidence }` in [0,1]: low-end buildup,
muddiness, boxiness, harshness, brightness, dullness, presence, vocal-range
congestion, transient density, attack, punch, transient consistency, dynamic density,
stereo width/instability, center/side dominance, ambience, dry tendency and masking.
Tonal balance is represented by the eight band distributions.

Confidence weights active evidence duration, spectral breadth and feature-specific
reliability. It is a restraint heuristic, **not a calibrated probability**. Short,
nearly single-frequency or silent material receives lower confidence. Brightness
and dullness confidence is reduced when the sample rate lacks high-band coverage.
Vocal congestion/masking use lower reliability; neither identifies vocals or proves
that one instrument masks another.

## Issue detection and restraint

Detected issues record `issue`, `severity`, `confidence`, `evidence`, `temporal`
and `band`. Spectral issue values combine band occupancy with centroid/rolloff or
other spectral proportions. Temporal excess requires all of:

- excess occupancy >0.06 and <0.6 of active windows;
- p90–p50 band fraction >0.15;
- temporal contrast severity, alongside spectral evidence.

This selects Dynamic EQ for intermittent problems and Static EQ for persistent
problems. Selective low/high dynamics additionally require band range to exceed
another band's range by more than 6 dB and significant band-fraction variability.
Low stereo spread uses both low-side ratio >0.3 and total-side ratio >0.15.
Phase risk combines correlation <0.1 with negative-correlation occupancy >0.1.

Processing requires severity ≥0.28, confidence ≥0.55 and their product ≥0.18.
At most three issue corrections are selected, with one per overlapping band and
a combined 3 dB amount budget. A predicted change below 0.25 dB is skipped.
Static cuts are ≤1.8 dB; cautious dullness lift is ≤0.7 dB. There is no ideal
target spectrum to which all music is forced. Mild issues, doubtful evidence,
overlapping corrections and exhausted budgets are recorded as skipped decisions.

## Dynamic EQ

The public Mix stage is `{ kind: 'dynamic-eq', bands: DynamicEqBand[] }`.
It supports 1–3 independent bell-shaped bands. A constant-peak bandpass is added
in parallel as an attenuated difference from dry audio. A linked RMS-power
sidechain and smoothed gain avoid independent L/R pumping.

Each band specifies frequency, Q, threshold, maximum reduction, attack and release.
Below threshold the unchanged contribution is retained. Threshold is derived from
the input band RMS +2 dB; planned attack/release are 8/120 ms. Planned reduction
is severity × confidence × retry strength, limited to 1.8 dB. DSP hard bounds are
2 dB reduction, Q 0.5–3, attack 2–100 ms and release 30–500 ms. The processor is
reduction-only and introduces no lookahead or timeline shift. It is a parallel
band-attenuation design, not continuously recomputed biquad EQ coefficients.

## Three-band dynamics

`{ kind: 'multiband', parameters }` splits at 180 Hz and min(3500 Hz, 0.4 × rate).
Complementary first-order contributions are low, upper-low and dry-upper; their
unity-gain sum is dry. Only changed contributions are added, so bypass is bit-exact.
Each band's linked power envelope drives reduction-only gain. Normal plans control
only the problematic low or high band; the other bands have zero reduction.

Threshold is band RMS +3 dB; attack/release are 15/120 ms. Planned reduction is
≤1.2 dB, hard DSP limit 1.5 dB. Crossovers are intentionally broad first-order
splits, not steep studio-grade crossover isolation. Normal material does not
receive multiband processing. No make-up gain is added by these processors.

## Modes and ambience

- **AUTO:** confident issue correction only; existing bounded mastering follows.
  Healthy AUTO still returns an exact bypass candidate when level/peak already fit.
- **IMPACT:** uses punch and dynamic-density evidence before transient emphasis.
  Already strong attacks or dense audio suppress boosting. New emphasis is capped
  at 0.8 dB; automatic widening is removed from Phase 7 decisions.
- **LIVE:** keeps the existing independent reflection/room processor. Ambience
  estimates combine stable decay behavior and side energy into Dry / Moderate /
  Wet. Added wet amount scales to 1 / 0.5 / 0.15 respectively when evidence is
  adequate; uncertain evidence uses 0.45. Phase 6 protections for sustained,
  bass-heavy and center-focused material remain in the live strategy as well.

Slow amplitude drift alone is excluded from decay evidence. Nevertheless sustained
notes, modulation, pads and effects can still imitate reverberation; the classifier
does not know actual reverb time. Stereo correction prioritizes modest low-side
attenuation and mono compatibility. Narrow sources are not automatically widened.

## Objective quality evaluation and retries

All Phase 6 level/peak/crest/stereo/DC gates remain. The new gate checks finite
features, unwanted increases >0.08 in confident muddiness/harshness/brightness/
dullness/masking/instability, low-side growth >0.06 and substantial presence loss.

Each issue-driven DSP stage records `reason` and `targetIssue`. Persistent spectral
corrections are compared by the target feature; intermittent ones by target-band
p90 fraction; selective dynamics by target band range; stereo fixes by low-side or
instability. Improvement must exceed max(0.001, 0.5% of the original metric).
Successful rendering alone is insufficient. These are conservative objective
proxies and can miss subjective deterioration or reject worthwhile subtle changes.

The existing three-attempt cap is retained. Retry strengths are 1, 0.5 and 0.25,
each starting from immutable Original. Subsequent attempts remove emphasis/positive
EQ. If objective improvement is still unproven, the third attempt omits corrective
band/width DSP and records that decision, preserving the original timbre. It still
must pass the safety gate. Rejected candidates never replace A or prior B.

Advanced View shows Perceptual Analysis, Detected Issues, Processing Decisions,
Skipped Processing and Quality Evaluation. Download remains valid full JSON with
all attempts. Normal explanations also state which changes were deliberately skipped.

## Chunk analysis, cancellation and blind comparison preparation

`PerceptualAnalyzer.push()` accepts arbitrary consecutive PCM chunks; `finish()`
returns aggregate features. Spectrum, delay and histogram buffers are reused.
Analysis state is bounded independently of song length, approximately hundreds of
kilobytes, rather than storing every FFT frame. The Web Worker feeds zero-copy
subarray views into this layer. Offline DSP still needs whole candidate PCM copies;
96 MiB input / 192 MiB A+B limits remain. This is not end-to-end streaming DSP.

Web cancellation terminates the Worker, and generation IDs prevent stale results.
Core AbortSignal checks remain at synchronous stage boundaries. Original ownership,
Undo/export, and matched A/B use existing adapters.

`createBlindComparison(aReport, bReport, swap)` prepares X/Y labels, a private mapping
and mandatory matched gains. The host must randomize `swap`, hide the mapping until
reveal and build the actual blind UI. No completed blind listening UI is claimed.

## Evaluation fixtures and API example

`tests/fixtures/perceptual.ts` defines 13 original generated multitone arrangements
and expected behavior: balanced, bass-heavy, muddy, harsh, bright, dull, narrow,
excessive-stereo, transient-heavy, overcompressed, wet-like decay, intermittent
harshness and low bursts. They include spectral/temporal counterexamples but are
not real recorded songs or a listening-quality certification corpus.

After building, `npm run evaluate:perceptual` records all plans, objectives and
before/after evidence in `artifacts/evaluation/phase7-fixtures.json`.

```js
import { analyzePerceptualFeatures, planMixCorrection,
  analyzeAudio, analyzeAdaptiveFeatures, autoMixMaster } from '@music-sync/core';

const features = analyzePerceptualFeatures(original);
const plan = planMixCorrection(analyzeAudio(original),
  analyzeAdaptiveFeatures(original), 'AUTO', 1, features);
console.log(plan.perceptual); // issues, decisions and skipped processing
const result = autoMixMaster(original, 'AUTO'); // also performs objective gates
// Keep original and offer result.processed only if status is accepted.
```

Next validation priorities: licensed diverse music and blinded listening, calibrated
confidence/thresholds, better time-frequency localization, reverb/source ambiguity,
steeper crossover comparison and end-to-end chunked processing. Professional
finishing is the design goal; neither the classifier nor the UI guarantees it.
