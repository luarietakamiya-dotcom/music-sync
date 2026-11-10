# Phase 7 change inventory

Compared by SHA-256 with the preserved Phase 6 source ZIP. Generated builds,
local tarballs, dependencies and raw test artifacts are excluded. Desktop source remains unchanged.

## Added

- `docs/evaluation/phase7-fixtures.json`
- `docs/images/phase7-advanced.png`
- `docs/images/phase7-mobile.png`
- `docs/perceptual-intelligence.md`
- `docs/phase7-changes.md`
- `docs/phase7-report.md`
- `packages/audio-analysis/src/perceptual.ts`
- `packages/core/src/auto/objective-quality.ts`
- `packages/core/src/auto/perceptual-decisions.ts`
- `packages/core/src/blind-comparison.ts`
- `packages/dsp/src/band-dynamics.ts`
- `scripts/evaluate-perceptual.mjs`
- `tests/e2e/phase7.spec.ts`
- `tests/fixtures/perceptual.ts`
- `tests/unit/perceptual.test.ts`

## Modified

- `CHANGELOG.md`
- `README.md`
- `SECURITY.md`
- `apps/web/index.html`
- `apps/web/package.json`
- `apps/web/src/main.ts`
- `docs/api.md`
- `docs/architecture.md`
- `docs/auto-finishing.md`
- `docs/compatibility.md`
- `docs/development.md`
- `docs/distribution.md`
- `docs/migration-plan.md`
- `docs/validation.md`
- `examples/README.md`
- `package-lock.json`
- `package.json`
- `packages/audio-analysis/README.md`
- `packages/audio-analysis/package.json`
- `packages/audio-analysis/src/index.ts`
- `packages/core/README.md`
- `packages/core/package.json`
- `packages/core/src/auto/engine.ts`
- `packages/core/src/auto/mix-planner.ts`
- `packages/core/src/index.ts`
- `packages/dsp/README.md`
- `packages/dsp/package.json`
- `packages/dsp/src/index.ts`
- `packages/dsp/src/mix.ts`
- `packages/shared/README.md`
- `packages/shared/package.json`
- `packages/ui/README.md`
- `packages/ui/package.json`
- `scripts/package-release.mjs`
- `scripts/test-sdk-browser.mjs`
- `tests/consumer/bundler.ts`
- `tests/consumer/consumer.mjs`

## Review

See [implementation report](phase7-report.md), [validation](validation.md),
[analysis/DSP design](perceptual-intelligence.md), and
[fixture evidence](evaluation/phase7-fixtures.json).
