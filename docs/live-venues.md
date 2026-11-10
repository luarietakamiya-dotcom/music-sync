# Venue LIVE / v0.9.0

The user's v0.8.0 song used the intended small-hall plan (wet 0.28, 1.1 s,
24 ms, wet high-pass 360 Hz). It was confidently classified Dry and accepted on
the first attempt. The subtle result was not caused by a fallback or disabled
loudness matching. The venue response itself needed a stronger room field.

## User choices

| Venue | Character | Nominal decay / pre-delay |
| --- | --- | --- |
| ライブハウス / live-house | Close stage, short wall reflections | 0.85 s / 16 ms |
| ホール / concert-hall | Broader audience space and depth | 1.5 s / 24 ms |
| アリーナ / arena | Larger space and longer reflections | 2.1 s / 34 ms |

Each has 控えめ / 標準 / はっきり strength. The default is **ホール・はっきり**.
Selection alone preserves B; pressing LIVE re-renders from A. The applied venue
and requested strength appear with a notice if quality retries reduced the effect.
AUTO/IMPACT, Advanced manual DSP and standalone colour do not apply this selection.
Optional colour remains a separate stage after the LIVE Mix/Master candidate.

## Architecture and processing

`LiveSelection` → Core venue plan → `LiveParameters` → dedicated venue DSP →
intermediate/master analysis → existing corrective and safety gates.

- The new `live-venue.ts` uses eight cross-coupled delay lines per channel with an
  orthogonal Householder feedback transform. Three input all-pass diffusers raise
  density; venue-specific early taps supply stage/wall reflections separately.
- Each delay has damped feedback with a nominal decay coefficient. Delay lengths,
  taps and damping differ from the preserved old room/hall processor.
- Only wet sound gets two high-pass stages and a low-pass. Bass-heavy input raises
  the wet high-pass to 320 Hz. Dry timing, width, sample rate, channels and length
  stay unchanged; no song-sized IR allocation is made. Last 120 ms fades the wet tail.
- Ducking is relative to input RMS rather than absolute sample level. Loudness alone
  should not change the selected venue character. The direct foreground is retained.
- Confident Wet evidence reduces addition to 55% and shortens nominal decay by 20%.
  Moderate or uncertain ambience evidence reduces wet to 85%. It does not silently
  substitute an almost inaudible room for the user-selected venue. Phase instability
  still reduces addition; measured quality failures still halve/quarter the chain.
- Peak/clipping/DC/crest/stereo/spectral and objective gate thresholds are unchanged.
  There are at most three attempts, and rejection preserves A and previous B.

The original `intimate-room` and `small-hall` kernels and parameter bounds remain
available. Their responses are regression tested. Lower-level `planMixCorrection`
without a sixth `LiveSelection` argument keeps the old default planning path;
`autoMixMaster(..., 'LIVE')` now supplies the new venue default. Existing open Web
pages that do not send `live` receive that default through the current Worker.
Worker protocol 1 remains compatible, so audio need not be re-imported just to try
the updated default in an already-open tab.

## Core usage

```ts
import { autoMixMaster, type LiveSelection } from '@music-sync/core';
const live: LiveSelection = { venue: 'live-house', intensity: 'standard' };
const result = autoMixMaster(originalPcm, 'LIVE', { live });
if (result.processed) useCandidate(result.processed.audio);
```

`LIVE_SPACES`, `LIVE_INTENSITIES`, `DEFAULT_LIVE_SELECTION` and
`validateLiveSelection` are public root exports. All three named venues stay
bounded to wet ≤ 0.6 and nominal decay ≤ 2.5 s. These are processing parameters,
not measured physical room sizes or certified RT60 values. DSP remains inside
the Web Worker; host cancellation terminates it and Core also checks AbortSignal
at pipeline boundaries.

## Evidence and limits

New tests compare late impulse-tail energy against the previous small hall at
8/48/192 kHz, check direct timing/source ownership, bass protection, level-relative
response, input validation, venue/strength switching and bounded retries. A rhythmic
synthetic arrangement requires a larger difference after loudness matching than
the former hall. These are numerical regressions, not a subjective quality score.

This simulates venue reflections and a room field on a completed mix. It cannot
reconstruct a different performance, audience response, stage microphones or
the acoustics of a specific actual venue. No applause/crowd recordings are added.
Compare the result against Original using matched loudness.

The general FDN/orthogonal-feedback design reference is Julius O. Smith III,
[Physical Audio Signal Processing — FDN Reverberation](https://www.dsprelated.com/freebooks/pasp/FDN_Reverberation.html).
The TypeScript kernel is new implementation code; no third-party source, IRs,
audio assets or desktop DSP implementation were copied.
