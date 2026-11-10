# Security policy

Music Sync Web is pre-release. Security fixes target the latest source version; there is
no legacy-support or response-time guarantee yet.

Report vulnerabilities through [GitHub private vulnerability reporting](https://github.com/luarietakamiya-dotcom/music-sync/security/advisories/new).
This repository has private reporting enabled. Do not publish exploit details or
private music in a public issue. No response-time guarantee is offered.

## Data handling

Files are read locally, decoded to PCM and analyzed in a Worker. There is no upload
API, analytics, account, external font or remote audio request. Audio is not stored
in localStorage/IndexedDB. SE enable/volume preferences use localStorage when
available. Long candidates and large project saves can use origin-private
temporary files. Refreshing/closing clears the live session; an explicit project
download is needed for later restoration. Original audio is
not modified. Selected-source analysis JSON contains measurements without filenames.
Finishing reports default to an anonymous sharing version: source names and IDs are
aliased, free-text strings are redacted, and numerical measurements are retained.
Unchecking the anonymous option exports a detailed report that includes STEM filenames
and explanations. Neither report is uploaded automatically. Hosting providers can
still see ordinary page/asset requests; don't describe the service as anonymous.

Portable `.musicsync.zip` projects include audio, filenames, settings, metadata and
any jacket image. They are private working files, not anonymized reports. Sharing
one shares those contents; projects are not encrypted. MP3 metadata and embedded
images can also identify the creator, and image metadata is not guaranteed to be
removed. Project and audio export remain local; neither is uploaded automatically.

## Boundaries and risks

- In-memory finishing and FLAC/STEM paths retain their 100 MiB input, 10-minute and 192 MiB
  combined A/B PCM bounds. Single-WAV chunked finishing permits
  a 512 MiB file up to 20 minutes, reads at most 65,536 frames per chunk and
  bounds metadata chunk count. Both paths accept 1–2 channels and 8–192 kHz.
  Validate chunk lengths, encodings, frames and finite sample values; reject
  unsupported layouts. The 512 MiB file bound is not a RAM bound.
- Long candidates use origin-private storage and per-file Web Locks. Free space must accommodate the candidate in Float32 and any retained prior B. The next render can reclaim abandoned candidate files.
- WAV decoding and analysis happen in a terminable Worker. Long WAV preview uses
  a file-backed media element and may depend on browser codec support. Native FLAC decode
  cannot be interrupted; metadata is checked first and results revalidated.
  Metadata can lie: a hostile codec stream may still consume temporary resources
  before rejection. FLAC decodes are serialized to avoid unbounded concurrent work.
- PCM may exist twice during playback, plus native decoder overhead. The PCM cap
  is not a total memory cap. Desktop browser coverage does not guarantee mobile
  robustness. Keep the browser patched; do not process adversarial corpora casually.
- Use textContent for filenames/errors; no HTML interpretation. Project import
  accepts only a validated versioned JSON schema and restricted ZIP STORE entries,
  never code, plugins, arbitrary OS paths or remote asset URLs. It checks declared
  sizes, CRCs, path/entry consistency, data-only JSON depth and setting ranges before
  committing the restored session; included audio is decoded/re-measured again.
- Project archives allow at most 64 assets, 512 MiB per asset, 2 GiB combined asset
  bytes and an 8 MiB manifest. Compressed/encrypted/ZIP64/split archives, symlinks,
  duplicate or unexpected paths and malformed/truncated entries are rejected.
  Blob-only export is capped at 256 MiB; larger saves require temporary storage.
  These are I/O limits, not promises of total RAM consumption or render capacity.
- MP3 metadata is bounded, plain text; the JPEG/PNG jacket is capped at 2 MiB and
  8,192 pixels per side after browser image decoding. Keep image/codec parsers
  patched. Browser-native image decoding may allocate temporary memory before
  rejecting dimensions; the compressed-byte cap is not a decoded-memory cap.
- MP3's optional unmodified LGPL encoder is loaded from the same-origin static
  vendor directory, not a CDN. Preserve its source/license/replacement files when
  hosting. Core SDK packages do not include it. SE uses a separate playback stream
  and must never enter exported PCM or suspend processing when autoplay is blocked.
- Production has a strict meta CSP. Add frame-ancestors and nosniff via deployment
  headers. Do not expose the Vite development server; HMR relaxes the meta CSP.
- Static app changes can change privacy behavior. Review new dependencies,
  fetch calls, telemetry, WASM imports and service workers before merging.
- Dependency versions are locked, CI uses a read-only token and no deployment
  secrets. Untrusted PR code is never run with pull_request_target.

Legacy desktop review remains separate: native plugins/DLLs, PowerShell calls,
session paths and crash logs are outside the Web sandbox. No legacy executables
or plugins are loaded by this repository.

Phase 2 applies the 192 MiB decoded PCM cap to the combined A/B pair before
allocating the second source. Playback and decoder copies still require additional
memory. All comparison gain decisions remain local and do not modify uploaded files
(the app performs no audio uploads).

Phase 3 processing allows at most 96 MiB for A in the Web app, making the final
A/B pair at most 192 MiB. Retaining old B during a job, Worker clones, output PCM,
playback buffers and export buffers increase peak memory beyond this figure.
Processing parameters are validated again inside the Worker/Core. Cancellation
terminates the Worker; no job can publish results after its generation is replaced.

Phase 4 never relies on the displayed mastering proposal for validation. Core
validates options and re-measures actual PCM in the Worker, returns candidate PCM
only when quality checks pass, and retains the same input memory limits. No
network API, model execution, arbitrary plugin loading or automatic publish step
is introduced by mastering.

Phase 6 mode rendering is single-Worker, maximum three sequential attempts, each
from Original. A 96 MiB decoded input cap is checked before copying. Reports retain
no audio arrays; candidate PCM is discarded on failed gates. User mode changes
terminate older Workers and generation-check returned results. No arbitrary scripts,
models, plugins or remote requests are introduced. Memory caps do not equal total
process memory; Worker copies and GC behavior remain relevant on small devices.

Version 0.11.1 imports commit only after successful decoding/analysis. Failed or
cancelled single-file replacements retain previous A/B and reports. The nominal
committed A/B PCM budget remains 192 MiB; an in-flight replacement may temporarily
require up to another 192 MiB, plus browser/decoder copies. This is bounded data
retention, not a guarantee against browser OOM. STEM additions are staged and
queued sequentially; failed additions remain editable without changing A/B.
Automatic STEM processing must use finishStemMix/masterStemMix so original-source
clipping evidence is not lost after sum attenuation. Bare-PCM APIs cannot infer
the history of their input. See docs/stem-input.md for the source-report contract.

Phase 7 spectral analysis uses fixed FFT/histogram storage and remains in the Worker.
It does not upload audio or load models. DSP still uses bounded offline candidate
PCM; the 96 MiB automatic limit is not increased. Perceptual estimates are heuristic
and must not be presented as a quality certification or vocal/reverb recognition.
