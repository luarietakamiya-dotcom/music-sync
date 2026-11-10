# Development and hosting

Prerequisites: Node.js 24 LTS (minimum 22.13), npm, a current browser. No Python,
GPU, payment account, API key, FFmpeg or desktop installation is needed for Web.

From the repository root on Windows/macOS/Linux:

```sh
npm ci
npm run dev
```

Dev binds to loopback port 5173. If occupied, stop the process using the port or
pass `-- --port 5174` and use that URL. Never expose the development server publicly.
Production preview is at port 4173:

```sh
npm run check
npx playwright install chromium
npm run test:e2e
npm run preview
```

Linux CI uses `npx playwright install --with-deps chromium`. Dependency installation
needs a network connection. Basic usage does not call external APIs. Test FLAC is
materialized from a checked-in generated base64 fixture, so tests need no Python.

`npm run build` produces ESM/declarations in each package's `dist` and static web
assets in `apps/web/dist`. Serve **the contents of apps/web/dist**, not the entire
repository, over HTTPS. The relative Vite base supports subdirectory hosting.
No deploy or domain is configured by this local implementation.

Recommended static-host response headers:

```text
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; worker-src 'self'; media-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
```

The build already includes the corresponding meta CSP except `frame-ancestors`,
which requires a response header. Self-host all assets. No CDN fonts/scripts or
analytics. Production `connect-src 'self'` permits serving same-origin assets;
there is no upload endpoint or fetch/XHR of audio. Do not add third-party telemetry
without a privacy design review. AudioWorklet (future) requires a secure context.
SharedArrayBuffer/threaded WASM would additionally need COOP/COEP review.

Runtime caps are in shared/LIMITS. Raising them needs memory/latency measurements.
Playback can create a second AudioBuffer. Cancelling FLAC ignores its result but
does not abort native decode; new FLAC decodes wait for the previous decoder.
Mobile limits may need to be lower after broader device testing.

Useful commands: `npm test`, `npm run typecheck`, `npm run lint`, `npm run example`,
`npm audit`, `npm audit --omit=dev`. All changes to algorithms need numeric fixtures.
See [contributing](../CONTRIBUTING.md) and [validation record](validation.md).

## Phase 2 audio tests

`npm run test:e2e` manages loopback Vite servers on 4173 and 4174 and stops only
its own child processes. Port 4174 serves a test-only OfflineAudioContext harness;
it is not included in the production app. Existing Music Sync servers may be reused.
Tests render the real playback adapter to verify alignment, gain and ramp continuity.

## Phase 5 SDK verification and release

After `npm run check`, run `npm run test:package` to pack five libraries, verify
contents/checksums and install them in a new temporary project with a fresh empty
cache in offline mode. Node, public exports, schema, strict declarations and an
independent browser-bundler consumer are checked. Temporary directories are removed
only after verifying their exact generated parent/name.

Install Chromium and WebKit using `npx playwright install chromium webkit`, then
run `npm run test:sdk-browser`. These tests use a temporary loopback server and test
the distribution's ESM module, a module Worker and the installed-package bundle in
both engines. These are Core SDK checks, not all Web app/codec behavior on WebKit.

`npm run release:local` rebuilds and writes local release artifacts. `pack:local`
alone assumes a current build. artifacts/, generated package docs, npm cache and
tarballs are ignored in Git. See [distribution](distribution.md). No public registry
or GitHub release command runs automatically.


Phase 6 moves legacy manual controls into Advanced Settings. Their regression tests
open that disclosure before operating them; the new beginner tests assert it stays
closed during AUTO/IMPACT/LIVE. Automatic rendering reuses the 96 MiB source cap
and releases cached playback AudioBuffers before creating candidates.

## Phase 7 evaluation

For Web deployment, keep `workers.json` together with index/assets. Version 0.7.1
resolves current Worker paths per job; see [Worker deployment](worker-deployment.md).

After `npm run build`, run `npm run evaluate:perceptual` (Node 24 recommended).
Generated fixtures and expectations are in `tests/fixtures/perceptual.ts`; plans
and before/after evidence go to `artifacts/evaluation/phase7-fixtures.json`.
These are original test signals, not copyrighted recordings or subjective quality proof.
See [Phase 7 analysis and DSP](perceptual-intelligence.md).
