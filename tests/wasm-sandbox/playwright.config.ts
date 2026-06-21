import { defineConfig, devices } from '@playwright/test';

const reporter = process.env.PLAYWRIGHT_REPORTER === 'html' ? 'html' : 'line';

export default defineConfig({
  testDir: './',
  testMatch: '**/*.e2e.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // Default to >=1 retry even locally: the engine-on-real-WASM specs cold-start a WASM
  // instance + react-reconciler under parallel workers and can occasionally miss the poll
  // window. A flaky cold start should self-heal, not show as a normal red.
  retries: process.env.CI ? 2 : 1,
  workers: process.env.CI ? 1 : undefined,
  reporter,
  // Generous per-test budget: the engine e2e loads a 768KB WASM binary and drives a full
  // react-reconciler render (initial + update).
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
