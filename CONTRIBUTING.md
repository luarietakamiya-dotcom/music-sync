# Contributing to Music Sync

We welcome fixes, tests, documentation, accessibility improvements and audio
engineering work. No paid API or proprietary plugin is required to contribute.

1. Fork/clone the repository and create a focused branch.
2. Use Node 24, run `npm ci`, then `npm run dev`.
3. Make one small change with a clear user outcome. Preserve original audio and
   keep filesystem/browser/device concerns outside Core.
4. Add meaningful numeric tests for analysis/DSP changes and browser tests for
   changed interactions. Use synthesized or clearly licensed fixtures.
5. Run `npm run check` and `npm run test:e2e` (install Chromium first).
6. Open a PR using the template; include the problem, result, tests and limitations.

Do not claim LUFS/true-peak compliance without the corresponding reference suite.
Do not silently substitute RMS for unavailable LUFS. New DSP needs bypass,
parameter bounds, finite outputs and unchanged source data. See the phase gates
in docs/migration-plan.md before adding future features.

Dependencies need a license/provenance review, a reason to exist and an updated
lockfile. Avoid remote assets, telemetry and paid services in the basic path.
Never submit user music, sessions, secrets, build caches or vendor executables.
Public exports are experimental; document breaking changes in CHANGELOG.md.

By submitting your contribution, you confirm that you have the right to contribute
it under this repository's MIT license. Follow CODE_OF_CONDUCT.md. Report security
issues privately as described in SECURITY.md.
