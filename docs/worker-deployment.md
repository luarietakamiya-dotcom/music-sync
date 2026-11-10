# Worker deployment and open-tab compatibility (0.7.1)

An already-open 0.7.0 page retained an old hashed processing Worker URL after the
local preview build replaced its assets. Vite returned the SPA's HTML fallback for
the missing JS filename. Module Worker startup failed before DSP began, so the UI
showed a generic Worker error and an incorrect audio-import failure status.

The failure was reproduced in the affected in-app browser. A compatibility entry
restored processing on that existing page with its already-imported Original PCM.
It generated an AUTO candidate and enabled matched comparison. This verifies actual
processing completion, not subjective quality or playback/listening preference.
No user recording is included in the repository or synthetic fixtures.

## Current loader

Vite emits `workers.json` beside the Web index, mapping analysis/processing kinds
to their actual built assets under protocol 1. Each new job resolves this manifest
with `cache: no-store`. The client checks same-origin/local deployment path, supported
protocol, successful HEAD and JavaScript MIME before constructing a module Worker.
Development without JSON uses the Vite-generated `?worker&url` fallback.

Metadata/loading failure does not invoke DSP. Processing errors explain that
Original and prior B remain; they no longer tell users to try a different audio file
for a code-loading failure. An unexpected runtime Worker error also retains audio.
Generation checks after async startup terminate superseded Workers before posting
PCM, including cancellation and rapid mode changes.

The previous `processing.worker-DTrVFXyp.js` path has a small compatibility entry.
It buffers incoming messages until the current same-origin processing module is
loaded from the manifest, then dispatches them to the unchanged protocol-1 handler.
This preserves audio in the specifically affected already-open 0.7.0 tab. It is an
intentional legacy URL adapter, not a content-identical hashed build artifact.

## Hosting and boundaries

Deploy index, manifest and assets consistently. Keep `workers.json` / index fresh;
immutable hashed JS can be cached. During rolling deployments, retaining prior
assets or atomically replacing the release remains recommended to avoid the race
between preflight and actual module loading. Incompatible future Worker protocols
must increment the manifest protocol and ask clients to refresh; never silently
mix breaking message contracts. The loader does not retry DSP after a crash.

Basic processing remains browser-local. This change does not upload PCM or change
DSP decisions, memory caps, Core metering or quality policies. A refresh discards
in-memory audio as before; save a desired candidate before refreshing.

Regression browser tests simulate a changed asset filename, successful HTTP 200
HTML fallback, unsupported protocol, cancellation during manifest fetch, and legacy
startup with PCM arriving before import completion.
