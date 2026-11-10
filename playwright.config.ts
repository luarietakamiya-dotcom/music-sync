import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e', timeout: 60000, workers: 1,
  use: { baseURL: 'http://127.0.0.1:4173', trace: 'retain-on-failure', ...devices['Desktop Chrome'] },
  webServer: process.env.MUSIC_SYNC_SERVERS_MANAGED ? undefined : [{
    command: 'node node_modules/vite/bin/vite.js preview --config apps/web/vite.config.ts --host 127.0.0.1',
    url: 'http://127.0.0.1:4173', reuseExistingServer: !process.env.CI,
  }, {
    command: 'node node_modules/vite/bin/vite.js --config tests/audio/vite.config.ts',
    url: 'http://127.0.0.1:4174', reuseExistingServer: !process.env.CI,
  }],
});
