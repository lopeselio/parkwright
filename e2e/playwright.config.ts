// End-to-end tests: the built web app served by the real server (FileStore, in-process cache,
// no chain keys, no AI key), driven in headless Chromium. Run with `pnpm e2e` from the repo root.
import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT ?? 8931);
const BASE = `http://127.0.0.1:${PORT}`;
const CI = !!process.env.CI;

export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: CI ? 1 : 0,
  forbidOnly: CI,
  reporter: CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: BASE,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{
    name: 'chromium',
    use: {
      ...devices['Desktop Chrome'],
      // Headless runners have no GPU: render WebGL in software (SwiftShader through ANGLE).
      launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] },
    },
  }],
  webServer: {
    // A clean save directory each run; every chain, AI and Redis variable is blanked so nothing external is touched.
    command: 'rm -rf .saves && node --experimental-transform-types --disable-warning=ExperimentalWarning ../apps/server/src/main.ts',
    url: `${BASE}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      PORT: String(PORT),
      SAVES_DIR: '.saves',
      STORE: '',
      REDIS_URL: '',
      SETTLE_LOCAL: '',
      PARK_ADMIN_KEY: '',
      PATRON_KEYS: '',
      NEARAI_API_KEY: '',
      PW_CLAUDE_TERMINAL: '',
      APP_VERSION: 'e2e',
    },
  },
});
