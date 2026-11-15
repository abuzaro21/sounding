import { defineConfig, devices } from '@playwright/test';

// Runs the real server against the test database. Build the UI first (npm run build).
const PORT = Number(process.env.E2E_PORT ?? 3110);
export default defineConfig({
  testDir: 'e2e',
  timeout: 120_000,
  expect: { timeout: 20_000 },
  workers: 1,
  reporter: [['list']],
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    command: 'node src/main.ts',
    url: `http://127.0.0.1:${PORT}/healthz`,
    reuseExistingServer: false,
    env: { PORT: String(PORT), DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://app:app@127.0.0.1:55432/sim_test', SND_RELAXED_LIMITS: '1', SND_OUTBOX_HOLD_S: '600', SND_MAX_WORKSPACES: '1000000' },
  },
});
