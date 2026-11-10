import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, realpathSync } from 'node:fs';
for (const name of ['shared', 'dsp', 'audio-analysis', 'core', 'ui']) {
  const packageRoot = `packages/${name}`;
  execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', `${packageRoot}/tsconfig.build.json`], { stdio: 'inherit' });
  copyFileSync('LICENSE', `${packageRoot}/LICENSE`);
  if (name === 'ui') copyFileSync('packages/ui/src/tokens.css', 'packages/ui/dist/tokens.css');
  // Windows sandboxes may deny npm workspace links. Keep a physical local package
  // copy current when one is used; normal linked workspaces already resolve here.
  const localPackage = `node_modules/@music-sync/${name}`;
  if (!existsSync(localPackage) || realpathSync(localPackage) !== realpathSync(packageRoot)) {
    mkdirSync(localPackage, { recursive: true });
    copyFileSync(`${packageRoot}/package.json`, `${localPackage}/package.json`);
    cpSync(`${packageRoot}/dist`, `${localPackage}/dist`, { recursive: true, force: true });
  }
}
execFileSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--config', 'apps/web/vite.config.ts'], { stdio: 'inherit' });
