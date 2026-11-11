# Changelog

## 0.16.0 — PC STEM and drum-part separation

- Pin the development glob matcher to the patched 11.0.1 release for
  GHSA-g3hv-75wg-m249, with targeted overrides for ESLint and TypeScript-ESLint.

- Add local, cancellable, GPU-assisted SCNet music separation and a compact
  five-head Mega53 drum model, with same-origin assets, fixed hashes and author license notices.
- Offer four/two music outputs, six drum parts including the unassigned remainder,
  and a two-stage nine-material result without mixing the parent Drums twice.
- Add reusable bounded Core segmentation/rendering and stereo-linked DSP ratio
  masks; retain original phase/pan and keep source files and prior A/B unchanged.
- Add individual part audition/WAV saving, explicit STEM staging, retained file
  ownership, disk preflight and PC-only guards. Preserve ordinary mobile features.
- Preserve each separated material’s original recording across portable-project
  save, restoration, rebuilding and subsequent saves; deduplicate shared originals.
- Close bounded OPFS writes before inference so cancellation removes provisional
  files even while native WASM inference is being terminated.
- Validate actual model inference, reconstruction and cancellation; document
  synthetic-test, quantization, short-context and instrument-identification limits.


- Publish the browser workspace on HTTPS GitHub Pages with a checked build,
  pinned deployment actions and only the app distribution and OSS notices.

- Label the main processing status independently of visible STEM value outputs.
- Show the actual STEM duration and memory limit before rejecting an oversized
  mixed WAV/FLAC import, without decoding PCM or allocating a mix buffer.
- Update browser regressions for open STEM controls and enabled restoration defaults.

## 0.15.2 — STEM defaults and first GitHub publication

- Open automatic-mix and STEM restoration controls initially. Enable per-material
  STUDIO_RESTORE and guitar Human Double by default; retain optional controls for opting out.
- Keep reference-dependent stabilization opt-in and retain raw original files.
- Prepare the public GitHub source repository with complete runtime sounds,
  owner-confirmed sound attribution, real repository metadata and private vulnerability reporting.

## 0.15.1 — workspace visibility

- Start reference direction and batch finishing collapsed; open them through their headings or direct navigation links without resetting audio or settings.
- Move notification sound controls above audio import, with a visible independent volume slider and header/sidebar shortcuts.

## 0.15.0 — reference direction and album finishing

- Add reusable reference-profile analysis, adaptive tone/bass/density planning, continuous DSP,
  bounded retries and measured adoption gates. Reference LUFS never becomes the output target.
- Connect reference finishing to AUTO/STEM/long-WAV routes. Preserve the accepted base candidate
  when reference correction is unnecessary or rejected; retain matched A/B and cancel support.
- Add a completed-song batch workspace, sequential Workers, safe common-loudness plans,
  per-song errors, independent original/result audition and individual or ordered ZIP export.
- Reuse WAV/MP3 quality, metadata and jacket settings. Bound source and temporary storage and
  keep batch files independent of the single-song/STEM workspace.
- Save original reference files and settings in portable projects; recompute profiles before
  atomic restore. Keep version-1 projects without sound references compatible.
- Add public Core/DSP APIs, an executable reference/batch example and regression tests.
  Record non-destructive timeline editing as a future direction, without adding an editor.

## 0.14.0 — project and delivery workspace

- Add local, portable project save/reopen with original materials, current A/B,
  staged/committed STEM settings, export choices, metadata and jacket. Validate
  imported state/audio before replacing the session; re-measure included audio
  without automatically mastering it again.
- Add Worker-based WAV Float32 / PCM24 / PCM16 and optional local MP3 export,
  selectable bitrate, integer dither, ID3v2.3 text metadata and JPEG/PNG front
  covers bounded to 2 MiB and 8,192 pixels per side.
- Add the supplied desktop processing-loop/completion/error sounds with separate
  enable/volume/trial controls and local preferences; exclude SE from A/B and
  exported audio, and tolerate blocked autoplay.
- Document the restricted project container, privacy and storage limits, Web-only
  codec/archive dependencies, LGPL encoder source/replacement notices and pending
  desktop sound-set redistribution clearance.

- Add a beginner finish-and-save flow, optional output destination at the top, clearer mode placement and generation-bound automatic downloads after accepted short/long candidates; rebuild staged STEM changes before finishing.

- Add matched per-material restoration previews, saved-setting replay, cancellation and per-STEM repair OFF that survives normal later mastering.

- Add raw individual-STEM listening, aligned solo/whole-mix switching, independent monitoring volume and explicit filename/role uncertainty, while preserving A/B state and avoiding extra full-track decoding.

- Add context-limited support for short masked vocal dips, independent smooth gain DSP, reusable midbody-band analysis, per-track evidence and an optional switch; retain the existing measured safety gate and legacy no-support behavior.

- Add adaptive multi-STEM lead/chorus clarity, time-local accompaniment cuts and limited kick/bass overlap control, with measured safety checks, one weaker retry, original preservation and matched listening.

- Record and display per-STEM repair outcomes, reuse accepted material restoration during finishing, and allow deliberate additional mix repair through Advanced Settings.

- Replace the Web finishing grain EQ with harmonic-aware streaming spectral attenuation, independent candidate analysis and aligned short/long/STEM paths.

- Enable all seven finishing preferences on file-backed inputs, measure gain-invariant before/after change, and explain limited repair coverage and pending setting changes.

- Add loudness-matched blind listening for the current A/B pair and an automatically selected dry/studio stem excerpt, including file-backed sessions.

- Add measured mid-high grain and independent high-frequency repair controls, per-stem studio restoration, reference-guided reconstruction stabilization, guitar doubling and a bounded loudness-aggression control.

- Add locally measured treble restoration to short and file-backed automatic finishing with protected attacks and a post-repair quality check.

- Add file-backed aligned WAV stem mixing with measured vocal/instrumental balance, global peak protection, matched A/B and export.

- Add chunked single-WAV basic analysis and file-backed Original preview, bounded
  to 20 minutes / 512 MiB without loading the complete PCM into the app.
- Render long WAVs in chunks with adaptive gain, conditional IMPACT EQ and stateful LIVE venues. Re-read the temporary Float32 file for a whole-song quality check before matched listening and export.
- Add exact-across-chunks true-peak estimation and unit/browser coverage for
  streaming meters, decoding, eleven-minute import and short-file regression.

## 0.13.0 — 2026-10-04

- Extend explicit vocal/accompaniment mode with a measured, bounded accompaniment
  presence dip when a vocal remains low after automatic gain balancing. A per-track
  quality gate checks actual band reduction, collateral changes, dynamics, stereo
  and clipping; failed candidates are mixed dry.
- Keep source PCM and staged Files unchanged. The Worker performs the heavy analysis
  and DSP, while Core exposes reusable planning/evaluation and a batch adapter.
- Preserve staged STEM files after a temporary Worker delivery failure so the same
  page can retry after the local service resumes. Add browser coverage for recovery.

## 0.12.0 — 2026-10-02

- Add a conservative, role-aware vocal/accompaniment balance plan based on each
  source's measured upper-mid/presence energy and evidence confidence. It adjusts
  only the vocal level by at most +3/-2 dB, or leaves the source ratio alone.
- Enable this option by default for the explicit vocal + instrumental input mode.
  A checkbox restores manual summing; changes apply on the next rebuild.
- Keep the existing sequential Worker memory budget with a two-pass import:
  measure each source, release PCM, then decode and mix each source in turn.
- Expose planStemBalance/mixStemsWithBalance as Core APIs. The source report records
  the decision and measured relative levels; default anonymous export retains
  numeric evidence while hiding private names and free text.
- Preserve original files, current A/B on failed import, source clipping policy
  and final bus peak protection. This is level correction, not source separation,
  vocal detection, masking EQ or a guarantee of a better mix.

## 0.11.1 — 2026-09-30

- Preserve committed A/B, reports and STEM context when single-file imports fail
  or are cancelled; only successful imports replace the current audio.
- Retain failed STEM additions in an editable staging list; recognize negated
  vocal filenames and offer explicit vocal/instrumental input targets.
- Queue additions during STEM import without dropping earlier files, and commit
  only the complete requested group. Cancel stops queued work but retains the list.
- Add finishStemMix/masterStemMix Core APIs and use them in the Worker so included
  source-clipping evidence survives bus attenuation and external integration.
- Show format-specific finishing limits and per-project preflight sizes without
  increasing memory caps or claiming longer-file support.
- Default finishing-report downloads to anonymized names/IDs/free text; keep an
  explicit detailed export. Add the reusable anonymizeFinishingReport API.

## 0.11.0 — 2026-09-29

- Multi-file drag/drop and file selection for STEM and vocal + instrumental;
  editable role/gain/include settings and transactional import/rebuild.
- Reusable Core metadata preflight/streaming sessions and generic DSP summation:
  exact common-rate start alignment, tail padding and uniform bus peak protection.
- Sequential Worker WAV/source analysis and native asynchronous FLAC adapter;
  bounded file/decoded/bus budgets, cancellation and failed-import A/B retention.
- Per-source clipping evidence retained despite protected bus peaks; existing
  finishing/output/matched comparison/export accepts the derived stereo A.
- This release does not perform source separation, beat alignment, resampling
  or automatic role-dependent balancing/corrective DSP.

## 0.10.0 — 2026-09-29

- Independent vocal, bass, clarity, warmth, punch, width and density controls with
  plain-language intent levels and input-dependent bounds.
- Auto / YouTube guide / streaming / CD loudness guide / dynamics output choices,
  applied after colour/LIVE; requested versus measured LUFS and honest target limits.
- Reusable Core planning/finishing APIs, Worker integration, original-preserving
  retries, matched comparison and export of final measured PCM.
- Default automatic behavior and existing quality gates retained; no CD-format
  conversion or platform compliance claim. Added Core/consumer/browser regressions.

## 0.9.0 — 2026-09-29 (Venue LIVE)

- Replace the automatic LIVE default with a stronger eight-line cross-coupled
  venue network; retain old intimate-room/small-hall kernels for callers.
- Add live-house, concert-hall and arena choices with three simple strengths,
  relative foreground ducking, filtered wet bass and explicit applied-setting feedback.
- Keep selected venue when ambience evidence is uncertain, reduce confident Wet
  additions and retain all existing corrective/safety gates and bounded retries.
- Add public LiveSelection APIs, response/matched-change and browser regressions.

## 0.8.0 — 2026-09-29 (Sound colour choices)

- Add ten name-based choices: original, warm, clear, vocal presence, bass,
  AM radio, old record, cassette, telephone and next room, with three strengths.
- Separate Core preset/planning/gating from dedicated EQ/texture DSP and Worker UI.
- Support standalone colour from A and optional colour after AUTO / IMPACT / LIVE;
  re-measure final output, preserve Original/prior B and enable matched comparison.
- Bound retries and noise to measured input, guard peaks/DC/stereo, provide reports
  and an external Core example. Corrective AUTO gates remain unchanged.

## 0.7.2 — 2026-09-29 (Clearer LIVE depth)

- Add an adaptive small-hall LIVE venue with later reflections, energy-normalized
  ambience and short all-pass diffusion; retain the previous intimate-room DSP.
- Keep Dry timing and buffers, duck ambience under foreground sound and filter the
  hall's wet low end more strongly. Existing stereo/peak/dynamics gates are unchanged.
- Prefer confident dry temporal evidence over the legacy sustained-level heuristic;
  existing wet/wide or unstable material still receives a shorter, quieter space.
- Explain wet-only stereo dispersion accurately; add hall tail, matched difference,
  bass protection, adaptive selection, parameter validation and browser regressions.

## 0.7.1 — 2026-09-29 (Worker deployment fix)

- Resolve Worker assets from a same-origin, protocol-versioned deployment manifest
  for every job, rather than retaining a deleted build filename in an open page.
- Reject HTML SPA fallbacks before starting DSP; explain startup errors and retain
  Original / prior B. Cancelled pending loads cannot publish stale work.
- Add a compatible loader for the previously served 0.7.0 processing Worker URL,
  allowing already-open tabs to finish without re-importing audio.
- Add deployment change, invalid asset/protocol, cancellation and compatibility
  regression tests. Core DSP/analysis algorithms are unchanged.

## 0.7.0 — 2026-09-29 (Phase 7)

- Add chunk-ready temporal eight-band spectral, transient, Mid/Side and ambience features.
- Add issue severity, confidence/evidence and correction budgets; preserve doubtful or healthy material.
- Add conditional linked Dynamic EQ, three-band dynamics and low-side correction.
- Evaluate intended correction objectives against output; remove ineffective correction on bounded retries.
- Explain detected, selected and skipped processing in Advanced; preserve one-click modes and matched A/B.
- Add a blind-comparison presentation adapter and 13 original evaluation fixture profiles.
- Keep original meter schemas, Desktop source and previous workflows intact.

## 0.6.0 — 2026-09-27 (Phase 6)

- Add adaptive analysis, problem detection, separate Mix/Master plans and bounded
  quality-driven retries from immutable Original. No fixed chain for every input.
- Add AUTO/NATURAL, IMPACT and dedicated LIVE strategy/room processor.
- Introduce foreground-safe reflections/ambience, conditional tone/dynamics/width
  corrections and spectral/stereo/level quality comparison.
- Make one-click modes the main flow; move numeric controls into Advanced Settings.
  Enable matched A/B for accepted results; add undo, plain explanations and report export.
- Preserve previous APIs, manual processing and Desktop. No video/lyrics features.


## 0.5.0 — 2026-09-27 (Phase 5 local SDK)

- Add coordinated library tarballs with installed docs, declarations and license.
- Add standalone browser ESM and module Worker example, external offline install,
  Node/TypeScript/bundler contract tests and Chromium/WebKit SDK checks.
- Define 0.5.x compatibility policy; keep schema/algorithm/processing versions intact.
- Add local release/checksum automation and CI gates. Registry/GitHub publication
  remains pending actual owner/scope; packages intentionally remain private.


## 0.4.0 — 2026-09-27 (Phase 4)

- Add deterministic local automatic loudness mastering, explainable proposals and
  immutable Core API; reuse the existing gain/limiter chain with EQ disabled.
- Gate acceptance on measured target/peak, reduction, crest, stereo and DC limits.
  Keep A and prior B on rejection; bypass when already within target tolerance.
- Add Web target controls, applied-result/rejection explanation, tests and Node example.
- No new external runtime dependencies or changes to the legacy desktop source.


## 0.3.0 — 2026-09-27 (Phase 3)

- Add immutable, versioned offline gain / peaking EQ / linked limiter chain.
- Generate and re-analyze B in a cancellable Worker while preserving A and prior B
  until success. Add explicit bypass and processing statistics.
- Export Float32 WAV independent of monitoring volume and loudness match.
- Add Core consumer example and DSP/export regression tests; no new external
  runtime dependencies. Legacy desktop remains unchanged.


## 0.2.0 — 2026-09-22 (Phase 2)

- Add immutable Before/After slots, shared playback/seek, interruptible gain ramps,
  and explicit RAW/loudness-matched monitoring with headroom protection.
- Export host-independent comparison planning from Core. Analysis schema and
  algorithm remain 0.1.0; no new runtime dependencies.
- Bound combined source PCM memory; preserve A on invalid B replacement.
- Add unit, browser-flow and rendered Web Audio output regression tests.
- Keep legacy desktop unchanged; DSP/audio export/mastering remain future phases.


## 0.1.0 — 2026-09-22 (Phase 1)

- Add browser workspace for local WAV/FLAC input, waveform, original preview,
  basic analysis/results and JSON report export.
- Add reusable shared/DSP/analysis/Core/UI workspace boundaries, typed ESM builds
  and a Node consumer example.
- Add K-weighted gated LUFS, estimated true peak, sample peak/RMS/crest/stereo/DC
  metrics with explicit undefined values and method limitations.
- Add validation, cancellation, synthetic reference tests and Chromium flow tests.
- Add architecture/source audit, phase plan, MIT license, contributor/security
  documents, issue/PR templates and lint/test/build CI.
- Preserve legacy impact.67 sources and distribution without modification.

Pending: authorized public registry publication and 1.0 API guarantees.
