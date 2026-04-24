/**
 * Playwright config — browser-level integration tests that complement
 * the vitest unit suite in `src/**\/__tests__/`.
 *
 * Division of labor:
 *   - vitest covers reducer-level invariants (store slices, hook
 *     behavior with mocked APIs, pure helpers).
 *   - playwright covers browser-level integration that can't run in
 *     jsdom: the router, history, page-to-page transitions, and timing
 *     scenarios that depend on real intervals (e.g. pollFailed flipping
 *     after ~12s of poll failures).
 *
 * Backend: each spec mocks `/api/*` via `page.route()` rather than
 * spinning a fixture FastAPI. Cheaper, no hidden state between
 * scenarios, and the production code can't tell the difference.
 *
 * `webServer.command` uses Vite's dev build. CI should set
 * `CI=1 PORT=5558` to avoid collisions with a developer's running
 * `npm run dev`.
 */
import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT ?? 5558);
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    command: `npx vite --port ${PORT} --host 127.0.0.1`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
