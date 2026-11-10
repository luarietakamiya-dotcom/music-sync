# Desktop integration boundary

The production baseline is Music Sync 2.0.0-alpha.16.5-impact.67, a Python/Tkinter
application. Phase 1 keeps it at its original location and records a read-only
source inventory in ../../docs/legacy-source-manifest.json. No desktop code has
been relocated, rewritten or connected to the browser. This folder is deliberately
a migration boundary, not a working replacement desktop app.

Before importing it here: confirm ownership/licenses of application code, assets
and vendor runtimes; add a reproducible dependency lock; establish the baseline
test run; copy first-party source with hashes and preserve relative asset paths.
Then isolate native file/audio/plugin adapters and bridge to versioned Core
contracts one function at a time. Keep the impact.67 binary available for rollback.

OS audio devices, native plugin hosting, VST3, signature checking and installer
packaging remain here. Do not bundle them into Web or its Core dependencies.
