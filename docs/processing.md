# Phase 3: manual offline processing

Load A, choose settings, and press **AからBを生成**. This replaces B only after
processing and analysis succeed. A is never changed; reapplying always starts
from A, so gain does not accumulate. Existing B remains available after failure
or cancellation. Editing settings alone does not change or invalidate the last B;
the result text records its applied settings. Processing stops playback.

## Chain version 1

| Stage | Bounds / behavior |
| --- | --- |
| Whole-chain bypass | Exact independent PCM copy, all stages and guard skipped |
| Gain | -24 to +12 dB |
| Peaking EQ | Optional; 20 Hz to min(20 kHz, 0.45 × sample rate), -12 to +12 dB, Q 0.1–10 |
| Linked limiter | Optional; -12 to -0.1 dB ceiling, release 10–500 ms; fixed 5 ms lookahead |

EQ is one second-order peaking band using the normalized
[RBJ/W3C cookbook formulas](https://www.w3.org/TR/audio-eq-cookbook/).
Each channel starts with zero filter state. Original length is retained; an IIR
tail is not appended, so ending while the filter rings truncates that tail.

The limiter detects the largest absolute sample in either channel over a future
5 ms window. A monotonic ring deque gives linear processing cost and bounded
detector storage. Attack is immediate and release exponential; both channels use
the same gain. Offline lookahead does not shift audio or insert delay samples.
This conservative design can audibly reduce transients or pump; it is not a
transparent commercial mastering limiter or a realtime processor.

After limiting, the existing 4× true-peak estimator measures output. If its peak
exceeds the ceiling, a shared static attenuation (with a float rounding margin)
is applied to the entire file. UI reports maximum dynamic reduction and this
additional attenuation separately. This protects that estimate, not all possible
reconstruction filters or broadcast compliance. Output is fully re-analyzed.

Disabling the limiter skips both stages of peak protection. Values above full scale
are retained in Float32 WAV; other players/converters may clip them. Non-finite or
absolute sample values above 32 are rejected instead of silently clipped.

## Export and memory

**処理済みBをWAV保存** writes the last successfully generated B, even if A is
currently selected. Export never applies volume-slider or loudness-match gain.
Format is IEEE Float32 RIFF/WAVE with a fact chunk, original sample rate, channel
count and frame count. No resampling, integer quantization or dither is performed.
Imported external B is not labelled as processed and has no DSP export button.
The Phase 1 file picker cap remains 100 MiB; an exported file larger than that
cannot be re-imported without splitting it.

Processing A is capped at 96 MiB in the Web app to fit A+B in 192 MiB. Retained
old B, Worker copies, AudioBuffers, WAV buffer and Blob consume extra memory.
Long-file/low-memory-device stress testing remains outstanding. No network audio
request or paid service is used. Worker termination cancels synchronous Core work.

## Library example

```js
import { defaultProcessingChain, processAudio, analyzeAudio, encodeFloatWav } from '@music-sync/core';
const chain = defaultProcessingChain();
chain.gainDb = 3;
chain.eq = { enabled: true, frequencyHz: 1000, gainDb: -2, q: 0.707 };
const output = processAudio(inputAudioData, chain);
const report = analyzeAudio(output.audio);
const wavArrayBuffer = encodeFloatWav(output.audio);
// The host saves wavArrayBuffer; inputAudioData is still unchanged.
```

`npm run example` executes a complete Node consumer. APIs are experimental,
covered by the [0.5.x compatibility policy](compatibility.md). Phase 4 adds [automatic loudness mastering](mastering.md);
local SDK distribution is available; public registry publication remains pending.
