import { defineConfig } from 'vitest/config';
import { aliases } from './vite.aliases.ts';
export default defineConfig({ resolve: { alias: aliases }, test: { include: ['tests/unit/**/*.test.ts'], testTimeout: 20000 } });
