import { defineConfig, devices } from '@playwright/test';
const baseURL = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:5173';
export default defineConfig({
  testDir: './test',
  fullyParallel: false,
  workers: 1,
  timeout: 45000,
  use: {
    baseURL,
    serviceWorkers: 'block',
    reducedMotion: 'reduce',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video:
      process.env.IAC_RECORD_DEMO === '1'
        ? { mode: 'on', size: { width: 1280, height: 800 } }
        : 'off',
  },
  projects: [
    {
      name: process.env.CI ? 'chromium' : 'edge',
      use: {
        ...devices['Desktop Chrome'],
        ...(process.env.PLAYWRIGHT_CHROME_EXECUTABLE
          ? {
              launchOptions: {
                executablePath: process.env.PLAYWRIGHT_CHROME_EXECUTABLE,
                ...(process.env.IAC_RECORD_DEMO === '1' ? { slowMo: 500 } : {}),
              },
            }
          : process.env.CI
            ? {}
            : { channel: 'msedge' as const }),
      },
    },
  ],
  webServer: {
    command: 'node scripts/dev-test.mjs',
    url: baseURL,
    reuseExistingServer: false,
    timeout: 60000,
  },
});
