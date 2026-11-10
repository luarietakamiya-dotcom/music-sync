# STEM and vocal + instrumental input (0.13.0)

Drop several WAV/FLAC files onto the main import area, or add them together/one
at a time in **STEM / ボーカル＋伴奏**. Select STEM (2–16 files) or vocal +
instrumental (exactly two roles) before adding. One staged file waits for another;
a valid group is imported automatically. Filename-based role suggestions are
editable. In paired mode, unrecognized names are provisionally assigned the
missing vocal/instrumental roles in list order; check them in the visible list.
Roles do not classify the audio or guarantee that a file actually contains vocals.
The paired view also offers explicit vocal/instrumental drop targets to override
filename guesses. Negated names such as no_vocals are suggested as instrumental.
Failed imports stay in the editable staging list so roles can be corrected or
bad files removed. Additional drops during import are queued, not used to cancel
and replace the previous addition. The complete group commits only after success.

The imported mix becomes **A**. Choose AUTO / IMPACT / LIVE and finishing/output
preferences to create **B**, compare with loudness matching, then export. Role,
gain and include/remove changes are staged until **ミックスを作り直す**.
A successful rebuild replaces A and clears its old B; failure/cancellation retains
A and B, with all staged files still editable. Cancellation stops queued work;
**ミックスを作り直す** retries the current list. Clearing that list retains A/B.
Importing a new single finished song/demo replaces the STEM workspace only after
successful analysis. Failed single-A and B replacements also preserve prior audio
and finishing reports.

In explicit vocal + instrumental mode, **声と伴奏の重なりを自動で整える** is on by
default. Core measures upper-mid and presence energy in the two user-labelled
sources. If evidence is sufficient and the vocal is clearly lower or higher than
the accompaniment in those bands, it adjusts only vocal gain by at most +3/-2 dB.
If the vocal remains well below the accompaniment after this adjustment, Core may
propose a narrow, gentle -1 to -2 dB accompaniment dip around 1.8 or 3.2 kHz.
The filtered source is measured before it is mixed. The dip is accepted only if
presence energy falls measurably without material low/high, dynamics or stereo
change, and without source clipping. Otherwise the Worker mixes the untouched
source. Balanced, silent, muted or uncertain pairs are left alone. These are
bounded spectral/level heuristics, not vocal detection or a guarantee of
intelligibility. Decisions and evaluation evidence appear in `sourceMix.autoBalance`
and `sourceMix.masking`, alongside a plain-language explanation after import.
Turn the option off and rebuild to use only the manual gain controls. Changing
the checkbox does not replace the committed A/B until the rebuild succeeds.

## Alignment, mix and what this phase means

- All tracks must have the same sample rate. Mixed rates are rejected explicitly;
  no silent browser resampling is applied.
- Start time is zero for every track. Length is the longest track, with silent
  padding at shorter tails. There is no beat detection/automatic temporal alignment.
- Mono tracks enter the stereo bus centrally; stereo channels preserve their
  mapping. Defaults use unity gain. Individual gain (-24…+6 dB), pan (-1…1) and
  mute are supported by Core; Web offers role, a small gain menu and include/remove.
- Sum protection is uniform attenuation to an estimated -3 dBTP ceiling when
  needed. It does not compress or normalize each source independently. Relative
  track levels, timing and dynamics are retained.
- Source clipping is recorded separately from the protected bus. A clipped source
  is not repaired by lowering the bus. Core blocks automatic finishing/mastering
  of an included clipped source; muted clipped sources do not block the clean mix.
  Web and external callers use finishStemMix/masterStemMix with the mix report.

This is aligned multi-file import/summing with per-track analysis and controls,
followed by the existing stereo bus finishing engine. A bounded pair level
adjustment and localized accompaniment dip are the first role-aware corrections.
A new bounded multitrack correction is available as described below. Broader
source-aware EQ and full multitrack automation remain future work. Existing global
vocal controls still adjust the mixed spectrum; to change only a supplied vocal
track's level manually, use its gain menu.
It does not separate stems from a finished song or modify performances.

## Listen to individual materials

After a successful import, each material has **この素材を聴く**. The dialog plays
the retained **元の素材・補修前** File, even when that material is excluded from
the staged mix. Names and role hints do not prove the contents of AI-generated
STEMs: use the material selector to hear what is actually present, then change the
role outside the dialog if needed.

**この素材だけ** and **全体ミックス A** switch at the current listening position.
The dedicated timeline lets you find a passage beyond a silent intro; a shorter
material stays at its end rather than jumping to the intro. Whole-mix A includes
its accepted STEM restoration/corrections. With STUDIO_RESTORE committed, the
same dialog can now generate the selected material's repair-only candidate.
Its volume is monitoring-only. **ミックスへ戻る**
or Escape stops preview and leaves the main A/B selection, position, loudness
match, material controls, analysis and export unchanged. Main playback remains
paused. Uncommitted materials without a successful source analysis cannot be
previewed until the import succeeds.

Native browser media playback uses one File object URL without creating another
full-track PCM copy. Browser support for FLAC/WAV variants is separate from the
import parser; an unsupported native format reports an error while retaining the
mix. Removing the selected material, clearing the list, starting processing or
leaving the page closes the preview and releases its URL/player. No audio is
uploaded.

## Per-material repair comparison and bypass

When **STUDIO_RESTORE** was used to build A, **補修後** prepares one whole material
with the exact saved import settings, using the same Core grain/treble path that
feeds the mix. Changing the current finishing knobs does not alter this preview.
It excludes manual track gains, Human Double, masking and bus mastering, so you
can judge restoration separately. Grain/treble candidates still pass their normal
measurement gates; when no repair is accepted, the candidate stays dry.

**補修前 / 補修後** retains the current listening position. Once prepared,
**音量をそろえて比較** defaults on and uses whole-material LUFS plus peak-safe
monitoring gains. An unavailable match is explained instead of claimed.
**この素材の補修を使う** stages a per-track bypass. The current A/B does not change
until **この設定でミックスを作り直す** succeeds. Cancelled/failed rebuilds retain the
prior A/B and the editable selection. OFF is additive descriptor metadata
`restorationEnabled: false`; omitted values retain old behavior. It disables
only that material's grain/high-band restoration, preserving the material itself.

Included OFF materials also suppress whole-mix grain/treble reprocessing in the
normal AUTO finishing path, so later mastering does not silently undo the choice.
Ordinary EQ/dynamics/mastering remain available. The explicit Advanced whole-mix
repair override (`repeatGrain: true`) deliberately permits reprocessing.

The heavy preparation/rendering runs in the versioned processing Worker. One
selected repaired material is retained, using a leased temporary Float32 WAV
when browser storage is available. It is discarded on close, material change
or rebuild. Short in-memory fallback is bounded by the existing 96 MiB preview
budget; large material previews require browser temporary storage.
Closing, switching or **準備をキャンセル** aborts pending work. Original File objects,
the source PCM, accepted A/B and exports are never overwritten by preview.

Core APIs: `prepareStemRestoration(source, settings, options)` returns repeatable
accepted readers and raw evidence; `renderStemRestoration(source, settings,
{ write, signal, progress })` produces the same repair-only chunks and independent
post-analysis. Both accept a repeatable chunked `GrainSource`.

## Adaptive multitrack clarity

For **3 or more STEMs**, **複数STEMの歌と低音の重なりを自動で整える** is on by
default. Filename hints distinguish **メインボーカル** and **コーラス**, and remain
editable in each role menu. Hints do not identify voices from audio. There must be
one explicit lead, or just one unmarked vocal. Ambiguous duets are mixed without
this correction; label the intended lead and rebuild. Two-file paired processing
keeps its existing gain/dip workflow.

Core measures 50 ms presence/low-band energy, RMS activity and attacks. Only
active, masked lead windows allow cuts around 2.6 kHz on competing material:
up to 2 dB accompaniment, 1 dB explicit backing vocals or 0.7 dB non-attacking
drums. Lead and unmarked duet vocals are untouched. Intro/instrumental breaks
remain dry. A strong simultaneous kick/bass low-band collision during singing
may allow at most a 1 dB bass cut around 110 Hz.

**自動ミックスの詳細 → フレーズの途中で小さくなる歌声を控えめに支える** is on
by default. A separate vocal-support strategy looks for 150–800 ms weak islands,
3–10 dB below the surrounding local vocal level, with healthy singing before and
after. It requires measured midbody-band evidence, a comparable local spectral
shape and remaining accompaniment masking after the planned band cuts. It may
add up to 1.5 dB on that lead-only interval, with up to 100 ms internal ramps.
Silence, attacks, long quiet sections, phrase endings and low-confidence/breath-like
energy are skipped by this heuristic. It is not a breath or voice classifier;
contextual evidence can still be ambiguous. Listen and disable/rebuild if preferred.
Both band attenuation and vocal support share the same whole-mix quality gate.
The optional Core `vocalSupport: false` preserves the band-cut-only path, and
legacy feature objects without `bodyEnergy` never enable vocal support.
Applied report fields are `supportSeconds` and `maxSupportGainDb` on the lead
in `sourceMix.clarity.tracks`.

This is a role-guided band-energy
heuristic, not source separation or proof of improved intelligibility.

The mix is measured with and without this new correction, using the same
restoration/doubling/reference settings. The safety gate checks RMS change
(-1.5 to +0.15 dB including final headroom gain), crest loss (at most 1 dB),
correlation drop (at most 0.04), side-energy change (at most 3 percentage points),
and final-bus DC offset (at most max(0.003, prior absolute offset +0.001)).
A failure retries once at half strength, then rejects the correction if still
unsafe. The existing uniform -3 dBTP estimated-peak ceiling remains. These
measurements cannot guarantee musical preference.

Per-track applied seconds appear in the list. A changed dry/treated excerpt
offers randomized, loudness-matched listening. Disable the option and rebuild to
recover a dry mix with the same manual settings. This rebuild reads the retained
original files and replaces A only after success; AUTO creates B afterward.
Report metadata is in `sourceMix.clarity`. Its presence-improvement number is a
plan projection, not a measured claim of vocal intelligibility.

Web performs this path in the existing Worker using repeatable bounded WAV
reads, small stereo scratch blocks and O(duration / 50 ms × tracks) feature
curves. Short FLAC files use the existing native decoder and retain source PCM
within the preflight decoded-source budget. Cancelling terminates the Worker;
external Core callers can use AbortSignal.

```js
import { renderFileStems } from '@music-sync/core';
const result = await renderFileStems(inputs, {
  // Each input has descriptor and repeatable open(): AsyncIterable<AudioData>.
  // A lead descriptor can use role: 'vocal', vocalRole: 'lead'.
  mode: 'stems', autoBalance: false, clarity: true, vocalSupport: true, audition: true,
  blockFrames: 65536, signal: controller.signal,
  async write(block) { await sink.write(block); },
});
console.log(result.report.clarity);
```

## Architecture and ownership

`packages/core/src/stems.ts`: frozen role/limit metadata, role suggestions,
metadata preflight, sequential session and per-track/bus reports.
`packages/core/src/stem-balance.ts`: pure measurement-based pair plan and a
batch Core adapter; no file, UI or browser dependency.
`packages/core/src/stem-masking.ts`: pair masking proposal and measured safety gate.
`packages/audio-analysis/src/stem-features.ts`: role-neutral incremental band/activity features.
`stem-clarity.ts`: adaptive multitrack plan using those reusable features.
`stem-vocal-support.ts`: pure local vocal-support strategy, independently replaceable.
`stem-clarity-quality.ts`: measured whole-mix safety evaluation.
`file-stems.ts`: bounded orchestration, one weaker retry and final peak guard.
`packages/dsp/src/stem-duck.ts`: stateful, chunk-independent local band attenuation.
`packages/dsp/src/stem-gain.ts`: owned-buffer, chunk-independent vocal gain curves.
`packages/core/src/stem-correction.ts`: batch orchestration for both decisions.
`packages/dsp/src/stem-mixer.ts`: host-independent aligned summation and final
uniform estimated-peak protection, plus bounded per-track peaking cut.
`apps/web/src/stem-worker.ts`: File/WAV import adapter and sequential processing,
sharing the existing versioned processing Worker entry point.
`apps/web/src/main.ts`: File references, staged controls and transactional commit.

The Worker first inspects every header before allocating the bus. With pair auto
balance enabled, it decodes each source once to measure its bands, releases that
PCM, then reads each source again for the normal validated mix. It retains at most
one decoded source at a time, plus the output bus and small reports. Without pair
auto balance it uses the original one-pass path. WAV parsing, source analysis, summing,
peak evaluation and final analysis run off the UI thread. The optional candidate
filter uses a small scratch chunk during measurement, then replays the same
coefficients into the bus only after the quality gate accepts. FLAC's existing native
`OfflineAudioContext.decodeAudioData` adapter runs asynchronously in the Window,
with only one decode in flight, and transfers its PCM to the Worker. Core has no
DOM/File/AudioContext dependency.

Original File/Blob objects are immutable and retained while the material list is
present. Every rebuild reads those originals again. DSP never writes an input
PCM buffer; the stereo bus is owned separately. Cancelling terminates the Worker.
Native FLAC decoding cannot be interrupted; a generation guard discards stale
results and prevents overlapping native decode jobs. Synchronous Core cancellation
is checked between tracks/progress boundaries and between filter evaluation chunks,
not within each sample loop.

## Studio controls

Open **STEM別の補修・ギターの広がり** before adding tracks or rebuild the mix after changing the controls. STUDIO_RESTORE measures grain and treble on each included source. Human Double adds a 12–45 ms modulated delay to the stereo side of guitar tracks whose existing stereo field permits it. The dry mono sum is retained. The optional reference must be an aligned WAV at the mix rate and length. Stabilization compares the neutral stem sum with the reference in 50 ms windows. It corrects brief level deviations around their typical difference, with limits on duration, gain and the percentage of the song touched. A poorly correlated reference produces no correction.

Per-track `restoration.grain` and `restoration.treble` record the actual repair decisions while `analysis` retains raw source evidence. Accepted grain repairs on included tracks cause automatic finishing to skip another whole-mix grain pass by default. The optional `repeatGrain` control explicitly permits a second candidate, which still undergoes the existing quality gates. Older reports without restoration metadata keep the previous workflow.

These controls affect the assembled A. A studio or multitrack-clarity build can also offer a loudness-matched listening test of the dry and treated stems. Both use the same track selection, gain, pan and accepted vocal/accompaniment corrections. The Worker selects one changed excerpt (up to eight seconds, capped at 384,000 frames per channel). Silence, constant gain changes and excerpts without a usable loudness match are skipped. The test randomizes playback labels and reveals them on request. The full-song blind listening button in the comparison section uses the existing original/finished pair and its current playback position. Neither test changes the export. Keep the original source files and rebuild with the controls off for a dry mix. AUTO creates B for the existing matched comparison.

## Bounds

- 2–16 files; paired mode requires one vocal and one instrumental.
- WAV-only projects beyond the memory limits use chunked mixing. Each WAV and the stereo result must fit 512 MiB, the inputs together must fit 1 GiB, and duration must fit 20 minutes. The result supports AUTO, matched comparison and Float32 export. [File-backed workflow](long-audio.md).

In-memory path (including projects containing FLAC):

- WAV/FLAC, each file up to 100 MiB; project encoded-file sum up to 400 MiB.
- Mono/stereo at 8–192 kHz, up to 10 minutes, with stricter decoded-budget limits.
- Combined nominal source PCM up to 384 MiB; stereo bus up to 96 MiB so it fits
  the existing automatic finishing input budget. This permits longer tracks at
  lower rates; high-rate/long tracks may require splitting even below ten minutes.
  For example, the stereo bus limit is 4:22.1 at 48 kHz or 2:11.0 at 96 kHz.
  Worker preflight displays the actual project duration, bus limit and decoded sizes
  before PCM allocation.

These are data budgets, not total process-memory guarantees. The browser also
holds A/B, one encoded track, one decoded track, native decoder scratch and other
temporary work. There is no unlimited track/buffer accumulation. Low-memory phones
and full ten-minute/high-track-count memory stress remain unverified.

## Core usage

```js
import { mixStemsWithCorrection, finishStemMix } from '@music-sync/core';
const tracks = sources.map(({ id, name, role, audio }) => ({
  audio,
  descriptor: {
    id, name, role, sampleRate: audio.sampleRate,
    channels: audio.channels.length, frames: audio.channels[0].length,
    gainDb: 0, pan: 0, muted: false,
  },
}));
const mixed = mixStemsWithCorrection(tracks);
const result = finishStemMix(mixed, 'AUTO');
// result.sourceMix retains provenance. Included source clipping throws before DSP.
```

For streaming import, call `planStemBalance`, `planStemMasking`, then
`createStemMixSession(descriptors, mode, signal?, maskingPlan?)`,
then `addTrack(id, audio)` in descriptor order and `finish()`. Consume/release one
decoded source at a time. `planStemMix` checks metadata without PCM allocation.
Returned plan/track metadata is frozen. The public batch API necessarily leaves
ownership of all caller-supplied source buffers to that caller.

The STEM finishing APIs accept `{ audio, report }` from a mix session and validate
source report dimensions/counts before using the evidence. Do not discard the
report and call a bare-PCM finishing API: PCM alone cannot reveal pre-sum clipping.
`masterStemMix(mixed, { targetLufs: -16, ceilingDb: -1 })` uses the same policy for
numeric mastering. Both APIs leave input buffers untouched; cancellation and the
bounded AUTO iterations remain available through finishStemMix options.

Finishing report export defaults to `anonymizeFinishingReport(summary)`: source
names/IDs become consistent aliases; free-text values are redacted even if a
future explanation contains a path or filename. Numeric evidence, fixed public
enum values and JSON field names remain. It is for generated MusicSync reports,
not arbitrary user-defined schema keys. Full source names/explanations are available
only when the user turns off anonymous export. No reports are uploaded automatically.

See `examples/mix-stems.mjs`, unit tests and browser tests for sample alignment,
padding, roles/gain/pan/mute, peak protection, preflight bounds, malformed/rate
mismatch rollback, native FLAC, cancellation, mobile and finishing/export flows.
Web finishing JSON includes the per-track and bus report as `sourceMix`.
