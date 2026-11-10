# Incremental migration plan

## Preservation strategy

1. Locate the real impact.67 source and record hashes before edits. Done.
2. Add a separate Web workspace; do not move or modify desktop code. Done.
3. Keep browser-specific I/O outside Core. Establish synthetic reference tests.
4. Import only audited, licensed desktop sources after source ownership and asset
   provenance are established. Keep the original distribution available for rollback.
5. Port one measured function/module per PR with before/after evidence. Do not bulk
   translate the 302 KB UI or replace the full processing chain.

## Phase 1 — implemented

Files first added: root package/config files, shared contracts, DSP measurement
primitives, analysis/Core API, Web import/Worker/UI, tests; then OSS docs and CI.
WAV/FLAC import, waveform, basic analysis/results, original preview, JSON report.
Tests: analytic sine RMS/crest, stereo/anti-phase, silence/DC/short clips, gates,
intersample peaks, sample-rate variants, malformed files, exact input preservation;
independent pyloudnorm references; browser import/drop/FLAC/replacement/cancel,
JSON download, playback, no external requests and mobile overflow.
No mastering/DSP chain, processed audio output or certified metering is claimed.

## Phase 2 — implemented: A/B and loudness matching

Implemented two immutable source slots, one playback clock, synchronized seek, short gain
ramps for switching, explicit raw/matched toggle. Compare before/after at equal
rate and explain length mismatches. Match by integrated LUFS, refuse undefined
loudness; apply a shared attenuation if needed to maintain headroom. Matching is
monitoring gain, not a destructive file change. Reject pathological gain values.
Tests added: aligned impulses, source switch drift, matching within 0.1 LU for
known fixtures, silence handling, no clipping, gain ramps, bypass and source hashes.

## Phase 3 — implemented: DSP and audio export

Implemented gain, one-band peaking EQ and linked 5 ms lookahead limiter with
explicit bounds and whole-chain bypass. Worker rendering preserves A, produces B,
re-analyzes output and exports Float32 WAV with original rate/channels/length.
No 24-bit/dither option, realtime DSP or desktop-equivalence claim.
Tests: bit-exact bypass/unity, gain, EQ center response at five rates, extreme
parameter impulse decay, linked stereo ratios, impulse timing, estimated peak
ceiling, silence, deterministic output, invalid inputs, WAV roundtrip/header and
browser-native decode, cancellation, A preservation and repeated processing.
Profile real long files before adding WASM or an AudioWorklet.

## Phase 4 — implemented: automatic loudness mastering

Added a new, independent deterministic rule engine over the Phase 3 chain. It
proposes bounded gain, renders once, re-measures output and enforces target, peak,
reduction, crest, stereo and DC gates. Rejection retains A and prior B. No desktop
code is imported or equivalence claimed. No external AI API or automatic EQ.
Tests cover quiet/loud/silent/clipped/extreme/DC sources, no-op, determinism,
target/ceiling limits, stereo and crest preservation on known signals, rollback,
cancellation, invalid settings and browser export. Rights-cleared musical listening
evaluation remains a follow-up; synthetic tests do not promise subjective quality.

## Phase 5 — implemented locally; registry publication pending

Added coordinated 0.5.0 tarballs, a direct-browser ESM build, Node/bundler/module
Worker consumers, checksum manifest and local release automation. External tests
install into a fresh temporary app with an empty cache in offline mode, verify
public exports and schema versions, compile strict TypeScript, and execute Core
without DOM. Chromium/WebKit verify both the installed bundle and browser Worker.
The 0.5.x compatibility policy defines supported APIs and unknown-version behavior.
Actual registry/GitHub publication, namespace ownership and URL/contact metadata
remain pending user selection. Packages stay private; no fake URLs are inserted.
Optional Python/desktop bridges and 1.0 guarantees remain future work.

## Merge and rollback gates

Every phase is a separate PR or sequence of focused PRs with its own tests and
changelog entry. Phase 1 CI does not pretend to test unimplemented phases.
Required checks: lint, types, unit/reference tests, build, external-style consumer,
browser flow; check legacy source hashes until a reviewed desktop migration occurs.
No auto-deploy, auto-publish or change to impact.67 is part of Phase 1.


## Phase 6 — adaptive automatic finishing

Implemented separate MixCorrection and Mastering with intermediate re-analysis,
AUTO/IMPACT/LIVE strategies, conservative signal features, bounded three-attempt
quality gates, immutable A and matched comparison. Existing manual functions are
preserved in Advanced Settings. Future stem-aware mixing, stronger reverb/vocal
confidence estimates, dynamic EQ/multiband processing and musical listening
evaluation are follow-up work, not claimed capabilities.

## Phase 7 — perceptual analysis and adaptive decisions

Implemented temporal FFT band distributions, confidence/evidence issues, processing
restraint, Dynamic EQ / selective multiband, low-side analysis/correction and
objective-based gates. Three retries and Original protection remain. API additions
are separate from the original analysis schema. Blind compare preparation is an
adapter; real listening calibration and complete streaming DSP remain future work.
