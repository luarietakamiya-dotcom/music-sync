# Phase 6 change inventory

Compared by SHA-256 with the preserved Phase 5 source ZIP. Generated build output,
local tarballs, dependencies and test artifacts are excluded. Desktop source is unchanged.

## Added

- `docs/auto-finishing.md`
- `docs/images/phase6-desktop.png`
- `docs/images/phase6-mobile.png`
- `docs/phase6-changes.md`
- `docs/phase6-reference-review.md`
- `examples/auto-finish.mjs`
- `packages/audio-analysis/src/adaptive.ts`
- `packages/core/src/auto/engine.ts`
- `packages/core/src/auto/live-strategy.ts`
- `packages/core/src/auto/mastering-planner.ts`
- `packages/core/src/auto/mix-planner.ts`
- `packages/core/src/auto/problem-detector.ts`
- `packages/core/src/auto/quality-evaluator.ts`
- `packages/dsp/src/live.ts`
- `packages/dsp/src/mix.ts`
- `tests/e2e/phase6.spec.ts`
- `tests/unit/auto-finishing.test.ts`

## Modified

- `CHANGELOG.md`
- `README.md`
- `SECURITY.md`
- `apps/web/index.html`
- `apps/web/package.json`
- `apps/web/src/main.ts`
- `apps/web/src/processing.worker.ts`
- `apps/web/src/style.css`
- `docs/api.md`
- `docs/architecture.md`
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
- `packages/core/src/index.ts`
- `packages/dsp/README.md`
- `packages/dsp/package.json`
- `packages/dsp/src/index.ts`
- `packages/shared/README.md`
- `packages/shared/package.json`
- `packages/ui/README.md`
- `packages/ui/package.json`
- `scripts/package-release.mjs`
- `scripts/test-sdk-browser.mjs`
- `tests/consumer/bundler.ts`
- `tests/consumer/consumer.mjs`
- `tests/e2e/phase3.spec.ts`
- `tests/e2e/phase4.spec.ts`

## Validation and design

See [validation](validation.md), [adaptive engine](auto-finishing.md) and
[desktop reference review](phase6-reference-review.md).
