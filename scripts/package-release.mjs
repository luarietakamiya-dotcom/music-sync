import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { build } from 'vite';

const root = process.cwd();
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
const destination = resolve('artifacts', `v${version}`);
mkdirSync(destination, { recursive: true });
const npm = process.env.npm_execpath;
if (!npm) throw new Error('Run using npm run pack:local');
const records = [];
const docs = ['api', 'compatibility', 'distribution', 'measurement', 'comparison', 'processing', 'mastering', 'auto-finishing', 'perceptual-intelligence', 'live-depth', 'sound-color', 'live-venues', 'finishing-preferences', 'stem-input', 'reference-and-batch'];
for (const name of ['shared', 'dsp', 'audio-analysis', 'core', 'ui']) {
  const dir = resolve('packages', name);
  mkdirSync(resolve(dir, 'docs'), { recursive: true });
  for (const doc of docs) copyFileSync(`docs/${doc}.md`, resolve(dir, 'docs', `${doc}.md`));
  copyFileSync('CHANGELOG.md', resolve(dir, 'CHANGELOG.md'));
  const [packed] = JSON.parse(execFileSync(process.execPath,
    [npm, 'pack', '--ignore-scripts', '--json', '--cache', resolve('artifacts/npm-pack-cache'), '--pack-destination', destination], { cwd: dir, encoding: 'utf8' }));
  for (const file of packed.files) {
    if (!/^(dist\/[^.].*\.(js|d\.ts|css)|docs\/[a-z-]+\.md|README\.md|LICENSE|CHANGELOG\.md|package\.json)$/.test(file.path))
      throw new Error(`Unexpected package file: ${file.path}`);
  }
  for (const required of ['dist/index.js', 'dist/index.d.ts', 'LICENSE', 'README.md', 'docs/compatibility.md'])
    if (!packed.files.some(f => f.path === required)) throw new Error(`Missing ${name}/${required}`);
  records.push({ name: packed.name, version: packed.version, file: packed.filename, npmIntegrity: packed.integrity });
}
// Bundle our own workspace code for browsers without an npm resolver/import map.
await build({ configFile: false, logLevel: 'warn', build: {
  outDir: resolve(destination, 'browser'), emptyOutDir: true, target: 'es2022', minify: false,
  lib: { entry: resolve('packages/core/dist/index.js'), formats: ['es'], fileName: () => 'music-sync-core.js' },
} });
for (const name of readdirSync('examples/browser-sdk')) copyFileSync(`examples/browser-sdk/${name}`, resolve(destination, 'browser', name));
copyFileSync('LICENSE', resolve(destination, 'browser/LICENSE'));
copyFileSync('docs/compatibility.md', resolve(destination, 'browser/COMPATIBILITY.md'));
copyFileSync('docs/distribution.md', resolve(destination, 'README.md'));
const files = [...records.map(r => r.file), ...readdirSync(resolve(destination, 'browser')).map(n => `browser/${n}`), 'README.md'];
const checksums = files.map(file => ({ file, sha256: createHash('sha256').update(readFileSync(resolve(destination, file))).digest('hex') }));
writeFileSync(resolve(destination, 'manifest.json'), JSON.stringify({ version, packages: records, files: checksums,
  provenance: 'Locally built from this checkout; not registry-published or signed. See CHANGELOG and compatibility policy.' }, null, 2) + '\n');
writeFileSync(resolve(destination, 'SHA256SUMS'), checksums.map(f => `${f.sha256}  ${f.file}`).join('\n') + '\n');
console.log(`Prepared local release: ${destination} (${records.length} packages)`);
if (process.cwd() !== root) throw new Error('Unexpected working directory change');
