import { defineConfig, devices } from '@playwright/test';

const reporter = process.env.PLAYWRIGHT_REPORTER === 'html' ? 'html' : 'line';

export default defineConfig({
  testDir: './',
  testMatch: '**/*.e2e.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter,
  timeout: 30000,

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
