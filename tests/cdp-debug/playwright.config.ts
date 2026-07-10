import { defineConfig, devices } from '@playwright/test';

const reporter = process.env.PLAYWRIGHT_REPORTER === 'html' ? 'html' : 'line';

export default defineConfig({
  testDir: './',
  testMatch: '**/*.e2e.ts',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  // One retry even locally: the fat debug wasm (3.6MB) cold-starts an Asyncify runtime in a
  // module worker; a flaky cold start should self-heal, not show as a normal red.
  retries: process.env.CI ? 2 : 1,
  // Serialize: the single relay + a single guest target is shared process-wide.
  workers: 1,
  reporter,
  // Generous per-test budget: loading a 3.6MB wasm in a worker, an Asyncify pause, and a
  // full CDP round-trip over the relay.
  timeout: 60000,

  use: {
    baseURL: `http://127.0.0.1:${process.env.TEST_PORT || '3000'}`,
    trace: 'on-first-retry',
  },

  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        ...(process.env.PLAYWRIGHT_CHROME_CHANNEL
          ? { channel: process.env.PLAYWRIGHT_CHROME_CHANNEL }
          : {}),
      },
    },
  ],
});
