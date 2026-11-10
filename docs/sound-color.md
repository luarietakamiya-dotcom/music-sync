# 音色・演出イコライザー

v0.8.0 adds name-based choices without requiring EQ/DSP knowledge. It is an
intentional colour layer, independent of AUTO / IMPACT / LIVE correction.

| Choice | Processing |
| --- | --- |
| 原音の音色 | No colour; a standalone candidate is an independent bit-exact copy |
| 暖かい音 | Broad low-mid lift and softer presence/highs |
| クリア | Low-mid reduction and presence/high-band lift |
| ボーカルを聴きやすく | Reduce masking-prone bands and lift voice presence; no stem separation |
| 低音に厚み | Bass lift and low-mid reduction |
| AMラジオ | High/low cuts, presence, mild saturation, activity-gated noise, partial mono |
| 古いレコード | Softer highs, mild saturation, needle crackle/noise, linked fractional wow |
| カセットテープ | Softer highs, mild saturation, activity-gated hiss and linked wow/flutter |
| 電話の向こう | Narrow band, presence, mild saturation and partial mono |
| 隣の部屋 | Low-pass shading and narrower image; no additional reverb |

These are synthesized effects, not hardware emulations. No desktop code, IR,
noise recordings or third-party audio assets are copied. LIVE venue processing
remains a separate strategy; this update does not add arena/outdoor venue choices.

v0.9.0 subsequently adds live-house/hall/arena selection through [Venue LIVE](live-venues.md),
independent of the colour choices below.

## UI and signal path

Select a type and 控えめ / 標準 / はっきり. Selection alone preserves current B.
Use **この音色でBを作る** to render from Original A, or press AUTO / IMPACT / LIVE
to correct/master A first and add the selected colour. Each new job starts from A;
repeated clicks or preset changes do not accumulate effects. Advanced manual DSP
and numeric mastering remain independent and do not apply the colour selection.
Applied type/strength are displayed separately from pending dropdown selections.

Core owns preset metadata, measured-input planning and candidate evaluation. DSP
owns EQ, band cuts, fractional time warp, soft saturation, deterministic activity
noise/crackle and stereo narrowing. The Web UI talks to the existing cancellable
processing Worker, not DSP kernels.

Standalone: Analysis → ColourPlan → ColourDSP → PeakProtection → PostAnalysis →
IntentQualityGate. Up to three attempts use scales 1, 0.5, 0.25 from the same input.
AUTO: existing Mix/Master gates pass first; colour has its own gate, and final
combined output is checked against Original A. Rejection preserves prior B.
`AutoFinishResult.finalAfter` is the final coloured measurement; `attempts[].after`
still describes corrective Mix/Master, and `soundColor` records the colour stage.

Noise/crackle scale with measured RMS and activity. Wow scratch is one channel
at a time; there are no impulse buffers sized to song duration. Existing input
limits remain, with 96 MiB maximum PCM per candidate job. Worker termination is
the browser cancellation mechanism. Core callers may use an AbortSignal; progress
callbacks and kernel chunks check cancellation. These remain synchronous Core
functions and should run in a Worker for long audio.

## Gate and limits

- Reject clipped, silent or unmeasurable input; do not claim to repair existing clipping.
- Same sample rate, frame count and channel count; finite measured values.
- For coloured candidates: estimated True Peak ≤ −1 dBTP, no samples at/above full scale.
- Total limiter/peak attenuation ≤ 4 dB, crest loss ≤ 4 dB.
- LUFS/RMS increase ≤ 6 dB, decrease ≤ 24 dB; loudness match stays subject to the existing comparison policy.
- DC ≤ max(0.003, original absolute DC + 0.001); correlation drop ≤ 0.1,
  side-energy increase ≤ 8 percentage points. Deliberate narrowing is allowed.

Intentional bandwidth changes and texture are not judged as corrective spectral
improvement. Physical safety checks remain enforced; existing AUTO objective
and corrective gates are unchanged. A passed gate does not establish subjective
quality, faithful hardware emulation or certified metering. Listen with matched A/B.
The neutral standalone choice does not attenuate an already safe source merely
because its estimated peak exceeds −1 dBTP; it remains a copy, not a master.

## Core usage

```ts
import { applySoundColor, autoMixMaster } from '@music-sync/core';

const soundColor = { preset: 'cassette', intensity: 'standard' } as const;
const colourOnly = applySoundColor(originalPcm, soundColor);
if (colourOnly.processed) useCandidate(colourOnly.processed.audio);

const finished = autoMixMaster(originalPcm, 'AUTO', { soundColor });
if (finished.processed) useCandidate(finished.processed.audio);
```

Neither method mutates Original. Rejection returns no `processed` PCM. Keep the
existing candidate until a new result is accepted. See `examples/sound-color.mjs`.
