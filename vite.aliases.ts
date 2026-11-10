import { fileURLToPath } from 'node:url';
export const aliases = Object.fromEntries(['shared', 'dsp', 'audio-analysis', 'core', 'ui'].map(
  name => [`@music-sync/${name}`, fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url))],
));
