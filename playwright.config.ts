import { defineConfig, devices } from '@playwright/test';

const production = process.env.E2E_PRODUCTION === '1';
const PORT = Number(process.env.E2E_PORT || (production ? 3101 : 3100));

export default defineConfig({
  testDir: './e2e',
  ...(production ? { testMatch: '**/production.spec.ts' } : { testIgnore: '**/production.spec.ts' }),
  fullyParallel: false,
  workers: 3,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI && !production ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    viewport: { width: 1440, height: 900 },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
  webServer: {
    command: production ? 'bash scripts/serve-production-test.sh' : 'npx tsx e2e/serve.ts',
    url: `http://127.0.0.1:${PORT}/healthz`,
    reuseExistingServer: !production && !process.env.CI,
    timeout: 60_000,
    env: { E2E_PORT: String(PORT), PORT: String(PORT) },
  },
});
