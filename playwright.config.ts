import { defineConfig, devices } from '@playwright/test';
import { randomBytes } from 'crypto';

// One token per run, shared with the test-only server (tests/e2e/web-server.js) and the specs.
process.env.GHK_E2E_TOKEN ??= randomBytes(24).toString('hex');
const PORT = Number(process.env.GHK_E2E_PORT || 3001);

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? 'list' : 'html',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'on-first-retry'
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } }
  ],
  webServer: {
    // Requires `npm run build` (serves dist/ui).
    command: 'node tests/e2e/web-server.js',
    url: `http://127.0.0.1:${PORT}/index.html`,
    reuseExistingServer: false,
    timeout: 60 * 1000,
    env: { GHK_E2E_TOKEN: process.env.GHK_E2E_TOKEN, GHK_E2E_PORT: String(PORT) }
  }
});
