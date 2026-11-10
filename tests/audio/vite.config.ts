import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { aliases } from '../../vite.aliases.ts';
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)), resolve: { alias: aliases },
  server: { port: 4174, host: '127.0.0.1', strictPort: true, fs: { allow: [fileURLToPath(new URL('../..', import.meta.url))] } },
});
