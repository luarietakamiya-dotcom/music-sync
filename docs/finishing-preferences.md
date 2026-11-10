# Finishing controls and destination loudness (0.10.0)

The usual workflow is import → choose desired sound/destination → AUTO, IMPACT
or LIVE → matched A/B → export. Seven independent intent controls use four levels:
unchanged, a little, clear, stronger. No EQ frequency, threshold or release setting
is required. The apply button re-renders from Original with the selected mode,
colour and venue. Changing a select or resetting settings does not replace B.

## Responsibilities and order

UI → processing Worker → `autoMixMaster` → adaptive Mix/Master and quality gates
→ optional sound colour → `planFinishControls` → generic DSP `renderMix`
→ final destination gain/limiter → analysis → existing automatic quality gates.

`packages/core/src/finishing-preferences.ts` owns intent metadata, planning,
bounded retries and final evaluation. DSP kernels stay in `packages/dsp`.
The seven controls are independent of the exclusive sound-colour preset and LIVE
venue. A fixed destination target takes precedence over density's extra loudness;
density can still add limited dynamics processing when the input has headroom.

| Control | Bounded strategy |
| --- | --- |
| Vocal presence | 2.6 kHz presence and a small 450 Hz cut; reduced on high-mid-heavy input |
| Bass | Up to 2 dB at 95 Hz; reduced when existing broad bass energy exceeds 0.55 |
| Clarity | Up to 1.6 dB at 6.5 kHz, with source-rate/bright-input bounds |
| Warmth | Up to 1.4 dB at 220 Hz; reduced on low-mid-heavy input |
| Punch | Linked, RMS-relative transient enhancement up to 1 dB; skipped with little crest headroom |
| Width | Up to 6% above 220 Hz, preserving bass; skipped on mono/unstable/wide inputs |
| Density | Up to 1.2 dB linked compression if dynamics allow; auto target lift up to 4.5 LU |

These are conservative whole-mix adjustments. Vocal presence does not separate
stems or identify a singer. Input-dependent bounds and measured gates can reduce
the actual effect; the report records the requested controls, exact applied stages,
retry strength and skipped processing. No subjective quality guarantee is made.

## Output profiles

| Profile | Integrated LUFS goal | Estimated true-peak ceiling |
| --- | --- | --- |
| Auto | Accepted base candidate, optionally increased by density | -1 dBTP |
| YouTube (guide) | -14 | -1 dBTP |
| Music streaming | -14 | -1 dBTP |
| CD (loudness guide) | -12 | -1 dBTP |
| Retain dynamics | -18 | -1 dBTP |

YouTube and CD targets are MusicSync design choices, not mandatory platform/CD
standards. [YouTube's encoder guidance](https://support.google.com/youtube/answer/2853702?hl=en)
documents transport, codec and rate settings; that page does not specify a fixed
integrated-LUFS delivery requirement. The streaming profile follows the current
[Spotify mastering tips](https://support.spotify.com/au/artists/article/loudness-normalization/)
(-14 LUFS and below -1 dBTP). Services/devices may apply different playback gain.
The profiles do not perform uploads, real-time streaming, encoding or CD authoring.
Export remains Float32 WAV at the original rate; a CD-format conversion/dither
step is not implemented. Peak measurement/limiting remain experimental estimates.

The target is applied **after** LIVE, colour and additional preferences. Its
attainment flag is based on **final rendered PCM**, within 0.5 LU. UI and JSON show
both requested and actual loudness. A safely accepted candidate may fall short;
the UI explains that the target was limited to protect dynamics and peaks.
Export saves the exact accepted PCM and excludes A/B monitoring compensation.

## Safety, ownership and cancellation

Each of at most three preference attempts starts from the same accepted base
candidate, at strengths 1 / 0.5 / 0.25; settings never accumulate. Final gain is
bounded by peak headroom, remaining 3 dB whole-chain attenuation budget, and the
original automatic lift bound (6 LU). Existing automatic shape, DC, clipping,
stereo, spectral and dynamics gates are retained. Rejection exposes no processed
buffer; the UI keeps Original and prior B. The corrected base candidate must pass
its own objective gates before preferences are applied.

Default zero controls/Auto output do not add a preference render inside the
automatic engine. Audio/report schemas and legacy APIs retain their versions.
Buffers are copied for DSP; all analysis and rendering run in the Worker. There
is no long impulse response or song-length scratch addition. The existing 96 MiB
decoded input limit applies; total process memory is larger than this input limit
and long-song/low-memory stress testing is not claimed. Terminating the Worker
cancels browser jobs; library users can pass `signal`, checked at progress/stage
boundaries. Synchronous Core cancellation cannot interrupt a single sample loop.

## Core example

```js
import { autoMixMaster, DEFAULT_FINISH_CONTROLS } from '@music-sync/core';
const result = autoMixMaster(audio, 'LIVE', {
  live: { venue: 'live-house', intensity: 'standard' },
  preferences: {
    controls: { ...DEFAULT_FINISH_CONTROLS, vocal: 2, bass: 1, density: 1 },
    output: 'youtube',
  },
});
if (result.processed) {
  // Use result.processed.audio, result.finalAfter and result.preferences together.
}
```

`applyFinishingPreferences(audio, selection, { signal, onProgress })` also works
independently. `planFinishControls(report, features, controls)` exposes the generic
stage plan. The automatic engine supplies a whole-chain gate reference; standalone
calls measure their input and gate against that input. Named presets, metadata
and default controls are frozen. See `examples/finish-preferences.mjs` and the
unit/E2E tests for final loudness, ownership, combinations and cancellation.
