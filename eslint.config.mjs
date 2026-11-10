import js from '@eslint/js';
import tseslint from 'typescript-eslint';
export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', 'apps/web/public/vendor/**', 'test-results/**', 'playwright-report/**', 'artifacts/**'] },
  js.configs.recommended, ...tseslint.configs.recommended,
  { files: ['**/*.mjs'], languageOptions: { globals: { console: 'readonly', process: 'readonly', URL: 'readonly', fetch: 'readonly', AbortSignal: 'readonly' } } },
  { files: ['scripts/test-sdk-browser.mjs', 'examples/browser-sdk/*.js'], languageOptions: { globals: { document: 'readonly', self: 'readonly', Worker: 'readonly', URL: 'readonly' } } },
  { files: ['apps/web/public/assets/*.js'], languageOptions: { globals: { self: 'readonly', URL: 'readonly', fetch: 'readonly' } } },
);
