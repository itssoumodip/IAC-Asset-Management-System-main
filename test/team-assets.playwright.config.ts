import { defineConfig, devices } from '@playwright/test';

// Reuse only the web server. All API requests are synthetic and intercepted.
export default defineConfig({
  testDir: '.',
  testMatch: 'team-assets.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  outputDir: '../test-results/team-assets',
  use: {
    baseURL: 'http://127.0.0.1:5173',
    ...devices['Desktop Chrome'],
    channel: 'msedge',
    viewport: { width: 1440, height: 1100 },
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
