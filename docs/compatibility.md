# API and compatibility policy (0.13.x)

The five library packages use a coordinated 0.13.0 release. Analysis report
`schemaVersion: 1`, `algorithmVersion: '0.1.0'`, processing chain version 1 and
mastering plan version 1 remain unchanged. A package version is not a report version.

## Supported surface

0.13.0 adds `planStemMasking`, `evaluateStemMasking` and
`mixStemsWithCorrection`. `StemDescriptor.presenceDip` and
`StemMixReport.masking` are optional additions; the version-1 report shape and
manual STEM APIs remain supported. Explicit paired Web input enables the bounded
correction together with automatic balance. The quality gate may revert the
filtered accompaniment; it does not guarantee subjective vocal clarity.

0.12.0 adds `planStemBalance` and `mixStemsWithBalance`. The optional
`StemMixReport.autoBalance` contains the conservative pair-level decision.
Existing `mixStems` and one-pass streaming sessions keep their prior behavior;
Web alone opts in by default when the user selects explicit vocal + instrumental
mode. The optional report field is additive to the version-1 report schema.
Core does not infer whether a labelled source truly contains vocals.

0.11.1 adds finishStemMix/masterStemMix and anonymizeFinishingReport. Generic PCM
APIs retain their contract; the STEM-specific wrappers validate source provenance
and block included clipped sources. Web imports now retain failed staged files
for editing and commit single replacements only on success. Anonymous report
downloads use a distinct filename and redact free text; detailed reports retain
their existing schema through an explicit opt-out in the Web UI.

0.11.0 adds STEM metadata, planning, streaming and batch mixing APIs. Stereo-bus
analysis and the pre-existing single-file/finishing contracts retain their schemas.
Web accepts multiple A files through the new import adapter; B still accepts one
comparison file. Same-rate STEM sources are summed at a common start, without
automatic resampling/position detection or role-dependent corrective DSP.

0.10.0 adds finishing controls/output profile metadata, planning and rendering
APIs plus optional `AutoFinishOptions.preferences` / `AutoFinishResult.preferences`.
Omitted preferences or zero controls/Auto output preserve the automatic path.
Non-default selections explicitly re-render and re-measure final PCM after colour
and LIVE; `targetReached` is an attainment flag, not platform certification.

Use only named exports from package roots. Deep `dist/` or `src/` imports are
blocked by export maps and unsupported. Core is the recommended integration entry
point; shared, DSP and analysis packages remain independently installable.
Libraries are ESM only, targeting ES2022. Supported Node baseline is 22.13+;
local verification uses Node 24. Browser adapters (decoding, playback, file I/O)
remain the host's responsibility. DOM/canvas UI must not be imported in a Node app
unless the host provides the required DOM. Core needs no DOM/audio device.

Patch releases in 0.12.x preserve export names, accepted inputs, versioned schemas
and return field meanings. Additive APIs or intentional breaking behavior require
a minor release plus changelog/migration notes while the version is below 1.0.

0.9.0 adds `LiveSelection`, `AutoFinishOptions.live` and frozen venue/strength
metadata/validation exports. Automatic LIVE defaults to concert-hall/vivid with
the new network; its numeric output therefore changes. Lower-level legacy
room/hall kernels and planning without an explicit venue remain supported.
Report/chain schemas and corrective/safety gate meanings are unchanged.

0.8.0 adds the sound-colour APIs and optional `AutoFinishOptions.soundColor`,
`AutoFinishResult.soundColor` / `finalAfter` and `capabilities.soundColor`.
Existing calls remain valid. With colour selected, `processed`/`finalAfter` are
the final candidate; `attempts[].after` keeps its corrective Mix/Master meaning.
Measure/compare finalAfter or soundColor's final attempt when exporting coloured
AUTO results. No analysis or processing-chain schema migration is required.
Numerical bug fixes may alter measured values; they require reference tests and
an algorithm-version change when measurement semantics change. Exact PCM is
guaranteed only for explicit bypass; do not rely on cross-engine floating-point
identity for all DSP. Use documented measurement tolerances.

Older 0.1–0.4 checkout versions are development snapshots, not supported registry
release lines. No 1.0 stability, long-term support or registry ownership is claimed.
Before persistence consumers should check report/chain versions and reject unknown
versions; do not silently reinterpret them. Report JSON preserves unavailable values
as null, not NaN/Infinity. There is no automatic migration from unknown schemas.

## Ownership and availability

AudioData holds finite planar Float32Array samples; source rate/channels/limits
are enforced by validateAudio. Analysis and processing never mutate caller PCM.
Processed PCM is a fresh buffer, including bypass. Transferring it to a Worker
detaches the sender: transfer only when relinquishing ownership, otherwise clone.
Synchronous Core work should run in a Worker for long files; cancellation belongs
to the host. Callback progress is not an asynchronous yield.

`capabilities` describes implemented Core features, not browser codec/device
support. Mastering candidates may be rejected according to MASTERING_POLICY; check
status and processed before export. Do not infer that a browser can decode FLAC
from capabilities.analysis. No VST3, filesystem reader, codec or playback backend
is included in Core.

## Verification and release gates

The release scripts inspect npm pack contents, hash artifacts, install all local
tarballs into a fresh external directory using an empty cache and offline mode,
compile a strict TypeScript consumer and run Node without DOM. A browser bundler
then consumes those installed packages (no workspace aliases). Chromium and WebKit
exercise both that bundle and a standalone browser ESM + module Worker example.
These SDK checks do not certify the entire Web app on WebKit or Safari.

Registry publication additionally requires a real owner/scope, contact, repository
URLs and explicit release authorization. Local tarballs intentionally retain
private:true; npm can install them, but npm publish remains blocked. The package
namespace is a local identifier, not a claim of ownership on npm.
