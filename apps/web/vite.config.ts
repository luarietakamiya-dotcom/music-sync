import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { aliases } from '../../vite.aliases.ts';
import { readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)), base: './',
  resolve: { alias: aliases, conditions: ['onnxruntime-web-use-extern-wasm', 'browser', 'module'] },
  worker: { format: 'es' },
  // Vite development injects CSS/HMR; production retains the strict HTML policy.
  plugins: [{ name: 'development-csp', apply: 'serve', transformIndexHtml(html) {
    return html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '');
  } }, { name: 'audio-worker-manifest', apply: 'build', writeBundle(options) {
    const dir = resolve(options.dir!);
    const assets = readdirSync(resolve(dir, 'assets'));
    const find = (kind: string) => {
      const file = assets.find(name => name.startsWith(`${kind}.worker-`) && name.endsWith('.js') && name !== 'processing.worker-DTrVFXyp.js');
      if (!file) throw new Error(`Missing ${kind} worker`);
      return `assets/${file}`;
    };
    writeFileSync(resolve(dir, 'workers.json'), JSON.stringify({ protocol: 1, analysis: find('analysis'), processing: find('processing'), export: find('audio-export'), project: find('project'), batch: find('batch'), 'batch-export': find('batch-download'), separation: find('separation') }));
  } }],
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022' },
  server: { port: 5173, strictPort: true }, preview: { port: 4173, strictPort: true },
});
