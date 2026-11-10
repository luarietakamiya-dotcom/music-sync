import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, cpSync, rmSync, realpathSync } from 'node:fs';
import { resolve, join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { build } from 'vite';

const root = process.cwd(), version = JSON.parse(readFileSync('package.json', 'utf8')).version;
const release = resolve('artifacts', `v${version}`), manifest = JSON.parse(readFileSync(join(release, 'manifest.json'), 'utf8'));
for (const record of manifest.files)
  assert.equal(createHash('sha256').update(readFileSync(join(release, record.file))).digest('hex'), record.sha256);
const temporary = mkdtempSync(join(tmpdir(), 'music-sync-consumer-'));
try {
  writeFileSync(join(temporary, 'package.json'), JSON.stringify({ name: 'independent-music-sync-consumer', private: true, type: 'module' }));
  // All tarballs are installed together; a fresh empty cache and offline mode
  // ensure this cannot succeed using registry packages or monorepo symlinks.
  execFileSync(process.execPath, [process.env.npm_execpath, 'install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund',
    '--cache', join(temporary, 'empty-cache'), ...manifest.packages.map(p => join(release, p.file))], { cwd: temporary, stdio: 'inherit' });
  for (const p of manifest.packages) assert.ok(realpathSync(join(temporary, 'node_modules', p.name)).startsWith(realpathSync(temporary)));
  for (const name of ['consumer.mjs', 'consumer.ts']) cpSync(resolve('tests/consumer', name), join(temporary, name));
  execFileSync(process.execPath, [join(temporary, 'consumer.mjs')], { cwd: temporary, stdio: 'inherit' });
  writeFileSync(join(temporary, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
    target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, noEmit: true, skipLibCheck: false,
    types: [], lib: ['ES2022', 'DOM'],
  }, files: ['consumer.ts'] }));
  execFileSync(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '-p', join(temporary, 'tsconfig.json')], { cwd: temporary, stdio: 'inherit' });
  cpSync(resolve('tests/consumer/bundler.ts'), join(temporary, 'bundler.ts'));
  // Resolve imports from the truly installed packages in the temp project.
  const output = resolve('artifacts', 'consumer-browser'); mkdirSync(output, { recursive: true });
  await build({ configFile: false, root: temporary, logLevel: 'warn', build: { outDir: output, emptyOutDir: true,
    lib: { entry: join(temporary, 'bundler.ts'), formats: ['es'], fileName: () => 'consumer.js' }, minify: false } });
  writeFileSync(join(output, 'index.html'), '<!doctype html><title>Music Sync installed consumer</title><script type="module" src="./consumer.js"></script>');
  console.log('External offline install, Node, TypeScript and browser bundler passed.');
} finally {
  // Delete only the exact temporary child created above, never a computed parent.
  assert.equal(dirname(temporary), tmpdir()); assert.ok(basename(temporary).startsWith('music-sync-consumer-'));
  rmSync(temporary, { recursive: true, force: true });
  assert.equal(process.cwd(), root);
}
