# Local AI STEM separation

Music Sync can derive editable materials from one mixed WAV / FLAC on a PC.
Separation is optional and runs locally in a Worker. Existing separated STEMs can
still be imported directly without downloading a model.

## Choose the right mode

| Mode | Input | Result |
| --- | --- | --- |
| Four materials | A complete song | `vocals`, `drums`, `bass`, `other` |
| Vocal + accompaniment | A complete song | `vocals`, `instrumental` |
| Drum parts | A recording containing drums | `kick`, `snare`, `hh`, `toms`, `percussion`, `remaining-drums` |
| Song + detailed drums | A complete song | `vocals`, `bass`, `other`, plus the six drum parts above: **nine** materials |

Four-material and two-material modes use SCNet. The two-material mode keeps the
vocal estimate and derives accompaniment from original minus vocal. Detailed
mode first runs four-material separation, then passes its drum material through
Mega53 Drums. Its nine-material list replaces the coarse drum parent with the six
children. Adding that parent again would double-count the drums.

Mega53 provides five learned estimates: kick, snare, hi-hat (`hh`), toms and
percussion. **Remaining drums is unassigned audio**, not a sixth learned
instrument. It can contain cymbals, bleed and other unresolved content. There are
no learned cymbal, ride or crash heads in this model. A model label is a proposed
content category; listen to it rather than assuming a source name describes every
sound in it. In particular, imported SUNO labels are not proof of instrument identity.

## Use the results

1. Open **曲をボーカルや楽器に分ける**, select one file or use the current Original,
   choose a mode, and start separation. Use an already isolated drum recording
   for the drum-only mode; choose the detailed-song mode for a full song.
2. Check progress in the shared processing display. Cancel there if necessary.
3. Listen to each result or save its Float32 stereo WAV. Output rate and length
   match the source. Preview uses one shared peak-protection gain; saved WAVs keep
   the unmodified separation output, which can exceed full scale.
4. Choose **分離素材をSTEMリストに入れる**. Check roles, inclusion and gain in the
   existing STEM workspace, then choose **ミックスを作る**. All six drum parts have
   the existing `drums` role, with their specific names retained.
5. Use AUTO and the existing loudness-matched Original / Processed comparison,
   then export a result you prefer.

Separation and staging preserve the current A/B. A successful explicit STEM mix
uses the normal mix policy: a new A is committed and the previous B is cleared.
Failure or cancellation preserves committed A/B and the previous separation
result; incomplete temporary outputs are discarded. Separation does not
automatically master, download or approve the sound.

## Local processing and device requirements

The separation controls are PC-only. Mobile devices, including an iPad in desktop
mode, are guarded out of this feature; other supported Music Sync workflows can
still use externally separated materials. A secure browser context (HTTPS or
localhost), origin-private file storage (OPFS) and Web Locks are required. Current
PC Chrome / Edge are the intended browser route. This is not a certification of
Safari, every GPU or every desktop configuration.

The first use of each model downloads same-origin static files:

| Asset | Approximate download |
| --- | ---: |
| SCNet weights, used by four / two / detailed | 13 MB |
| Mega53 Drums weights, used by drums / detailed | 92 MB |
| ONNX Runtime WASM plus its JavaScript loader | 29 MB, plus application code |

There is no audio POST, account, paid API or remote inference service in this
flow. Model downloads still require a connection on first use; browser cache
availability and eviction determine whether a later run can reuse them. Model
bytes are checked against pinned size and SHA-256 before inference. Serving the
Web app does not itself upload a local recording.

The Worker attempts an available hardware WebGPU adapter and falls back to a
single-thread WASM CPU route when GPU initialization or execution fails. Its
reported backend describes selected providers, not a promise that every operator
runs on the GPU. CPU drum inference can take much longer than the recording:
a separate short-window test took about 45 seconds for roughly three seconds of
input. Timings vary substantially by device and cold model loading.

Allow roughly **1.5 GB free memory for ordinary separation**, and **3 GB free for
drum/detailed modes**; an **8 GB or larger PC** is recommended for the latter.
These are starting guidelines, not enforced free-memory measurements or a success
guarantee. Separate short synthetic CPU probes observed about **1.2 GiB for
SCNet** and **2.28 GiB for the drum model in tracked WASM buffers alone**. Those
figures exclude JavaScript heap, decoder/browser/OS overhead and GPU memory.
A 92 MB model download therefore does not imply a 92 MB working set. Keep other
heavy tabs closed and try a short excerpt first.

## Data and storage bounds

| Boundary | Current limit |
| --- | --- |
| Separation input | Mono/stereo, integer 8–192 kHz, at most 20 minutes |
| WAV file | At most 512 MiB |
| Each derived stereo Float32 PCM output | At most 512 MiB, excluding its WAV header |
| FLAC input | At most 100 MiB encoded and 96 MiB decoded PCM |
| Subsequent file-backed WAV STEM mix | At most 16 materials and 1 GiB combined input files |
| Portable project | At most 64 assets, 512 MiB per asset and 2 GiB combined asset bytes |

The strictest applicable limit wins: 20 minutes at a high sample rate may exceed
the per-output limit. FLAC is decoded through the serialized native decoder;
long inputs should use WAV, whose source reads and result writes are chunked.
The in-memory mixed-FLAC STEM path has additional bus/source budgets described in
[STEM input](stem-input.md). Separation can produce a collection too large for a
later mix or project archive; these are distinct budgets, not expanded limits.

Before a job starts, the Web adapter checks reported OPFS space for an immutable
raw Original snapshot, output WAVs and a 128 MiB reserve. Detailed mode also needs
intermediate drum files and the second stage's files. Browser quota estimates
can change, and storage writes can still fail. Existing A/B, previous results and
other live candidates also occupy space.

The separation panel, staged STEM list and an active download each retain their
own leases. Clearing the panel releases its ownership; it does not delete files
still used by the STEM list or comparison. A download keeps an independent lease
for a short grace period. Failed/cancelled jobs release their provisional files. The Worker opens synchronous
OPFS access only for each bounded write and closes it before inference; cancellation
can discard real files without leaving asynchronous writers open across ONNX.
Closing or reloading the page is not a project save.

After staging/mixing, a portable project preserves the actual separated files,
the original mixed recording and current A/B through the existing source
provenance. Restore verifies and re-analyzes saved audio; it does **not** rerun a
neural model to recreate those materials. An unstaged separation-panel result is
transient, so stage it or save the individual WAVs before leaving. See
[project format and restoration](project-and-export.md).

## Reconstruction and musical limits

The five independent drum estimates can overlap. Music Sync converts their
combined stereo magnitudes into linked ratio masks, applies them to the original
complex spectrum, and retains an unassigned remainder. This preserves original
phase and pan per time/frequency bin, prevents duplicated assigned energy and
supports mixture reconstruction within Float32 rounding. It deliberately discards
the estimates' learned phase/stereo changes and can retain bleed. A low
reconstruction error only checks that the outputs still add up; it does not prove
that each instrument was isolated correctly.

Core combines bounded windows with shared overlap-add weights and preserves the
source edges/tail. The adapter folds numerical/resampling remainder into `other`
or `remaining-drums`; it does not clip or individually normalize saved parts.
It rejects non-finite or malformed output and excessive reconstruction residual.
That safety gate is distinct from musical-quality evaluation.

The drum graph uses a shortened roughly three-second context rather than the
upstream 20-second context. Matrix weights are stored as INT8 and dequantized for
Float32 computation (W8/F32); this does not promise INT8 arithmetic or acceleration.
A separate synthetic conversion probe measured **2.8308% relative waveform L2
change** from the full-precision model. This is a numerical difference, **not a
quality score**. Frontend STFT/resampling differences can also amplify relative
errors on quiet individual parts. Exact tensor contracts, provenance, measurements
and limitations are in the [Mega53 model card](../apps/web/public/models/mega53-drums/MODEL_CARD.md)
and [SCNet model documentation](../apps/web/public/models/scnet-small/README.md).

Code, runtime and model notices retain their respective MIT attribution. The
weight authors explicitly confirmed redistribution/conversion under MIT for
[SCNet](https://github.com/starrytong/SCNet/issues/35#issuecomment-4999873539) and
[Mega53](https://github.com/ZFTurbo/Music-Source-Separation-Training/issues/245#issuecomment-5834608838).
See the [component notices](../THIRD_PARTY_NOTICES.md) and licenses beside each
model. These grants do not guarantee rights in an input recording, training-data
clearance, ownership of a particular output or professional sound quality.

## Reuse Core without the Web app

`@music-sync/core` exports `planSeparation`, `renderSeparation`,
`SEPARATION_LIMITS` and their types. Core contains no model downloader, ONNX
Runtime, browser storage, File I/O or UI dependency. A host supplies its own
decoder, inference provider and provisional output writer.

```js
import {planSeparation, renderSeparation} from '@music-sync/core';

const plan = planSeparation(
  {sampleRate: 44100, channels: 2, frames: sourceFrames},
  {id: 'your-model', kind: 'music', targets: ['voice', 'rest'],
    segmentSeconds: 11, overlap: 0.25},
);
const summary = await renderSeparation(plan, {
  read: (start, frames) => source.readPlanar(start, frames),
  infer: audio => provider.infer(audio),
  write: (target, audio) => temporaryOutputs.appendPlanar(target, audio),
  signal,
  progress: ({fraction, text}) => reportProgress(fraction, text),
});
// Adopt temporary outputs only after success; discard them on rejection/cancel.
```

`planSeparation` validates metadata and returns a frozen plan without allocating
full-song PCM. It exposes segment starts, segment/step/overlap frames,
`outputChannels: 2`, total output PCM bytes and overlap-window bytes. The latter
excludes source, model, inference outputs and host I/O memory. A host must enforce
its own aggregate storage/device budget; Core's per-output limit is not that budget.

The asynchronous callback contract is:

- `read(start, frames)` returns exactly that source range, at the declared rate and
  original channel count, as planar Float32 PCM.
- `infer(audio)` receives an owned stereo window; mono is duplicated and the tail
  is zero-padded to `segmentFrames`. Return **exactly** the declared target names,
  each with two finite Float32 channels of that window length and sample rate.
  Core reuses its scratch input on the next call; do not retain it. A provider
  that needs the unpadded duration can derive it from the host's sequential plan.
- `write(target, audio)` consumes one finalized stereo prefix before resolving.
  Writes for each target arrive in chronological order and total exactly the
  source frame count. Keep them provisional until the returned promise resolves.
- Abort checks surround every asynchronous callback. A host must cancel its own
  long-running callback or terminate its Worker for prompt interruption; an
  AbortSignal cannot forcibly stop arbitrary model code.

The renderer owns bounded per-target ring windows and shared weights. It validates
all model outputs for a window before writing that window, but earlier provisional
windows may already exist when a later one fails. It returns numeric frame,
segment and peak summaries, not files or instrument-confidence scores. Peaks may
exceed 1; level protection belongs to later mixing/playback, not per-part clipping.

`createMixtureMasks` is available from `@music-sync/dsp` and re-exported by Core.
It accepts `Float32Array` complex spectra plus
`{channels, sources, bins, frames}`: mixture layout is
`[2 * channels, bins, frames]` (real/imaginary planes per channel), estimates are
`[sources, 2 * channels, bins, frames]`, and the returned owned array has
`sources + 1` outputs with the final unassigned remainder. It validates finite
values/dimensions and caps output allocation at 512 MiB. It does not run inference.

Run the standalone callback example after building:

```sh
node examples/source-separation.mjs
```

That deterministic example demonstrates segmentation, owned buffers, incremental
writes and reconstruction checks. It performs **no neural inference or instrument
separation** and downloads nothing.

## Verification boundary

Core unit tests cover metadata/shape checks, overlap edges/tails, bounded writes,
unchanged source PCM and cancellation around read/infer/write. Public-package
consumer checks cover runtime exports and strict TypeScript contracts. Real-model
browser fixtures use original synthetic audio to exercise model loading,
six/four-file output, finite samples, reconstruction and A/B protection. Separate
explicitly mocked Worker tests cover detailed nine-part staging and second-stage
cancellation/cleanup; they are not evidence of neural quality.

These checks do not establish real-vocal isolation, subjective listening quality,
long-song reliability, phone compatibility or broad GPU/Safari support. Evaluate
representative music by ear and preserve the raw recording.
