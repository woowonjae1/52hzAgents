import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: /.*\.spec\.ts$/,
  timeout: 30000,
  retries: 0,
  workers: 1,
  use: {
    baseURL: 'http://localhost:3006',
    channel: 'msedge',
    headless: true,
    viewport: { width: 1280, height: 800 },
    ignoreHTTPSErrors: true,
  },
  webServer: {
    command: 'node tests/serve-out.mjs',
    port: 3006,
    reuseExistingServer: true,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
