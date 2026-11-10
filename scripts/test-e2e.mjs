import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';

// Own the Node server processes directly so Windows teardown does not rely on
// npm/cmd process-tree termination. Existing user preview servers are reused.
const owned = [];
const servers = [
  { url: 'http://127.0.0.1:4173', args: ['preview', '--config', 'apps/web/vite.config.ts', '--host', '127.0.0.1'] },
  { url: 'http://127.0.0.1:4174', args: ['--config', 'tests/audio/vite.config.ts'] },
];
async function ready(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
    return response.ok && (await response.text()).includes('Music Sync');
  } catch { return false; }
}
function cleanup() { for (const child of owned) if (child.exitCode === null) child.kill(); }
process.on('SIGINT', () => { cleanup(); process.exit(130); });
process.on('SIGTERM', () => { cleanup(); process.exit(143); });
try {
  for (const server of servers) {
    if (await ready(server.url)) continue;
    const child = spawn(process.execPath, ['node_modules/vite/bin/vite.js', ...server.args], { stdio: 'inherit' });
    owned.push(child);
    let started = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) throw new Error(`Preview exited: ${server.url}`);
      if (await ready(server.url)) { started = true; break; }
      await wait(100);
    }
    if (!started) throw new Error(`Preview did not start: ${server.url}`);
  }
  const tests = spawn(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', ...process.argv.slice(2)], {
    stdio: 'inherit', env: { ...process.env, MUSIC_SYNC_SERVERS_MANAGED: '1' },
  });
  owned.push(tests);
  process.exitCode = await new Promise((resolve, reject) => { tests.on('error', reject); tests.on('exit', code => resolve(code ?? 1)); });
} catch (error) { console.error(error); process.exitCode = 1; }
finally { cleanup(); }
