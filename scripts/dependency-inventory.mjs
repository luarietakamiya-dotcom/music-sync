import { readFileSync, writeFileSync } from 'node:fs';
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
const packages = [];
for (const [path, entry] of Object.entries(lock.packages)) {
  if (!path.startsWith('node_modules/') || entry.link) continue;
  let metadata = {};
  try { metadata = JSON.parse(readFileSync(`${path}/package.json`, 'utf8')); } catch { /* optional platform package not installed */ }
  packages.push({ name: metadata.name ?? path.replace(/^node_modules\//, ''), version: entry.version,
    license: metadata.license ?? entry.license ?? 'REVIEW REQUIRED', dev: !!entry.dev,
    resolved: entry.resolved, integrity: entry.integrity });
}
writeFileSync('docs/dependency-inventory.json', JSON.stringify({ source: 'package-lock.json and installed package metadata', packages }, null, 2) + '\n');
console.log(`Recorded ${packages.length} locked packages`);
