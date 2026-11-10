# Phase 2: A/B comparison

Load the original in A / Before and an independently prepared version in B / After.
Manual DSP or automatic loudness mastering can generate B from A. The paired demo uses a synthetic tone
and a copy 6.02 dB louder. Both inputs remain unchanged in memory.

Select A or B while playing. Both sources share a start time, offset and audio clock;
pause, seek and stop affect their shared timeline. Source switching and monitoring
gain changes use 20 ms linear ramps, including interrupted rapid changes.

## RAW and loudness match

RAW preserves the original relative loudness. Both slots receive the same attenuation
if needed to keep the larger measured/estimated peak at -1 dB. The volume slider
then changes listening volume for both. RAW therefore does not mean unity gain.

Loudness match attenuates the louder source toward the lower integrated LUFS,
then attenuates both equally if extra peak headroom is needed. It never boosts
either input. Gains are shown separately from the original analysis values.
Undefined LUFS (silence, below-gate or very short clips) and differences above
24 LU disable matching; RAW playback stays available.

Matching is a full-file LUFS estimate, not a guarantee of equal perceived loudness
at every instant. Gating may change after attenuation. True peak is estimated;
this monitoring safeguard is not a certified limiter. Opposite-phase sources can
cancel briefly during a crossfade. Listening tests on real material are still useful.

## Pair constraints and ownership

- Same sample rate and channel count are required. No automatic resampling or
  time alignment occurs: choose files with corresponding content at the same origin.
- Unequal lengths play only the shorter common interval. Measurements and matching
  still use each full file; the UI explains this distinction.
- Combined decoded A/B PCM is capped at 192 MiB. Decoder/AudioBuffer copies and
  other allocations mean total browser memory is higher.
- Replacing A clears B. Invalid or cancelled B loading preserves A.
- JSON export contains the selected source's original report. Monitoring gain is
  not applied to PCM or exported measurements. Phase 3 exports DSP-generated B as Float32 WAV without monitoring gains.

## Reuse Core

```js
import { analyzeAudio, createComparisonPlan } from '@music-sync/core';
const plan = createComparisonPlan(analyzeAudio(before), analyzeAudio(after));
const gains = plan.match.available ? plan.match.gainsDb : plan.rawGainsDb;
// A host adapter applies 10 ** (gains.a / 20) and 10 ** (gains.b / 20).
// Use plan.durationSeconds for the common timeline; retain original PCM.
```

Run `npm run example` for executable analysis and comparison consumers. Core is
available through local SDK tarballs and browser ESM; see [compatibility](compatibility.md).
