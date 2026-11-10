# Core examples

From the repo root: `npm ci && npm run build && npm run example`.
`analyze-tone.mjs` is a host-independent Node consumer of the built package exports.
It synthesizes one second of a 1 kHz tone, analyzes it, asserts its peak and prints
LUFS/peak/crest values. It does not import the Web app or browser globals.

For a browser host, decode locally and transfer planar Float32 PCM into a Worker,
then call the same `analyzeAudio` function. See apps/web/src/analysis.worker.ts and
docs/api.md. Published npm distribution is planned for Phase 5.

`compare-tones.mjs` consumes built Core comparison exports, checks a 6.02 dB
level difference and prints the monitoring plan. Included in `npm run example`.

`process-tone.mjs` renders a bounded chain, re-analyzes it and encodes Float32 WAV.
It runs in Node without a browser, audio device or service and is checked in CI.

`master-tone.mjs` demonstrates accepted automatic loudness mastering and encoding
in a standalone Node consumer. It runs as part of `npm run example`.

Phase 5: `browser-sdk/` is copied beside the standalone ESM in the local release.
Serve the resulting browser directory over HTTP to run analysis + module Worker.
The separate tests/consumer fixtures verify real installed tarballs (Node, strict
TypeScript and a browser bundler), not aliases into this checkout.

`auto-finish.mjs` demonstrates input-adaptive AUTO / IMPACT / LIVE through the
public Core API. Accepted candidates retain report/plan evidence and original PCM.

Phase 7: `auto-finish.mjs` now includes perceptual issues/objective gates in each
mode result. See `scripts/evaluate-perceptual.mjs` and `npm run evaluate:perceptual`
for the reproducible fixture corpus. Public APIs and chunk usage are documented
in `docs/perceptual-intelligence.md`.
