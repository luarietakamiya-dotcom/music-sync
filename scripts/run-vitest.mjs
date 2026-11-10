import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

// Keep temporary transformed modules inside the checkout. A Windows sandbox may
// discard its per-command system temp directory while Vitest workers still read it.
const temporaryDirectory = resolve('node_modules/.cache/music-sync-vitest');
mkdirSync(temporaryDirectory, { recursive: true });
const result = spawnSync(process.execPath,
  [resolve('node_modules/vitest/vitest.mjs'), ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, TEMP: temporaryDirectory, TMP: temporaryDirectory, TMPDIR: temporaryDirectory },
  });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
