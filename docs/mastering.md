# Phase 4: deterministic local mastering

This experimental release automates loudness adjustment with the existing linked
limiter. It does not choose EQ, repair clipping, remove noise or promise a subjective
sound quality. No AI model, account, service or paid API is involved.

## User flow

1. Import A. The mastering panel explains a proposed gain and estimated peak ceiling.
2. Choose target LUFS and peak ceiling. These are user choices, not streaming-service
   requirements. Defaults are -14 LUFS and -1 dB.
3. Select **自動マスタリングしてBへ**. The Worker re-analyzes A, renders once from A,
   then measures the candidate. Manual DSP controls do not affect this operation.
4. Only a candidate passing all gates replaces B. Otherwise the outcome says
   **保留**, lists reasons and (when rendered) candidate measurements. A and any prior
   B remain unchanged; rejected PCM is not offered for playback or export.
5. Compare A/B, optionally enable loudness match, and use the existing B WAV export.
   **Bを解除** removes the processed version; A is always retained.

Changing target fields only changes the next proposal, not the last applied B.
Outcome text records the target and measured result at application time. Cancellation
terminates the Worker and leaves retained sources intact. Importing/replacing sources
clears the previous outcome so it cannot describe an unrelated B.

## Policy version 1

| Check | Bound |
| --- | --- |
| Requested target | -24 to -9 LUFS |
| Requested estimated peak ceiling | -6 to -0.5 dB |
| Required initial gain | -24 to +12 dB; otherwise refuse rather than silently clamp |
| Input loudness | Must be measured (no silence/short/below-gate substitution) |
| Input full-scale samples | Reject any sample with absolute magnitude ≥1 |
| Mean DC offset | Each channel within ±0.05 before and after |
| Final loudness | Within ±0.5 LU of requested target |
| Final estimated peak | At/below ceiling, with 0.0001 dB float tolerance; no full-scale samples |
| Reduction | Maximum linked-limiter reduction plus static peak-guard attenuation ≤3 dB |
| Crest-factor loss | ≤3 dB |
| Stereo correlation change | ≤0.05 when originally defined; undefined output then fails |

These are conservative project policies, not audio standards or a substitute for
listening. Crest factor and correlation are coarse proxies: passing them does not
prove transient or stereo perception is unchanged. Historical clipping below full
scale cannot be detected by counting current samples.

If input is already within the loudness tolerance and below the ceiling, the result
is a bit-exact bypass copy. Otherwise one gain + linked limiter render is attempted
with EQ disabled, 80 ms release and the existing 5 ms lookahead/estimated peak guard.
There is no repeated gain chasing, hidden relaxation of constraints or feedback
loop. A target can remain unavailable even though a more advanced chain could
reach it. Retrying the same settings yields the same result.

The existing 4× true-peak estimator is not certified. The same estimate is used
for protection and final checking. Long-file memory and musical listening tests
remain outstanding; tests use generated rights-cleared signals. Web A input is
limited to 96 MiB for rendering, with extra Worker/playback allocations as described
in [processing](processing.md).

## Core API

```js
import { analyzeAudio, planMastering, masterAudio, encodeFloatWav } from '@music-sync/core';
const options = { targetLufs: -14, ceilingDb: -1 };
const proposal = planMastering(analyzeAudio(input), options);
// Display proposal.reasons, requestedGainDb and chain before rendering.
const result = masterAudio(input, options);
if (result.status === 'accepted' && result.processed) {
  const bytes = encodeFloatWav(result.processed.audio);
  // Save bytes; result.before / result.after hold actual measurements.
} else {
  console.log(result.reasons); // Keep original or previous B.
}
```

`masterAudio` validates options and measures actual input; it never trusts a UI
proposal as authority. It is synchronous and immutable, with an optional progress
callback. Use a Worker for browser calls and terminate it for cancellation.
`MasteringResult.processed` exists only for accepted candidates. `after` is null
when rejected before rendering; otherwise it describes the rejected candidate.
`MASTERING_POLICY` publishes fixed quality thresholds. `master-tone.mjs` is an
executable built-Core consumer included in CI. Local package distribution is available; see [compatibility](compatibility.md).
