/**
 * E2E: sse-fatal-error — Lane G / D8 spec.
 *
 * Mocks /api/host/generate/stream to emit a fatal SSE event mid-
 * stream. Asserts:
 *   1. <ErrorAlert> appears beside the generation button.
 *   2. The retry affordance restarts the mutation (we observe the
 *      mocked endpoint being hit a second time).
 *   3. No toast-only failure — the inline alert is the primary
 *      surface, per Lane G's "every primary action has an inline
 *      error + retry affordance" acceptance criterion.
 */
import { test, expect } from '@playwright/test';

const EMPTY_QUEUE = { running: [], pending: [], recent: [], total_running: 0, total_pending: 0 };

function fatalEventStream(): string {
  // SSE wire format: "data: {json}\n\n"
  const init = JSON.stringify({ type: 'init', seeds: [1, 2, 3, 4], batch_id: 'b-test' });
  const fatal = JSON.stringify({
    type: 'fatal',
    error: 'GPU 일시적 오류 (mock)',
    status: 503,
  });
  return `data: ${init}\n\ndata: ${fatal}\n\n`;
}

async function mockApi(page: import('@playwright/test').Page) {
  let streamCalls = 0;
  await page.route('**/api/queue', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(EMPTY_QUEUE) }),
  );
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ user_id: 'test', display_name: 'Test', role: 'user', subscriptions: [] }),
    }),
  );
  await page.route('**/api/host/generate/stream', (route) => {
    streamCalls += 1;
    route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      headers: { 'cache-control': 'no-cache' },
      body: fatalEventStream(),
    });
  });
  return () => streamCalls;
}

async function seedAuth(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    localStorage.setItem('studio.jwt.access', 'fake-token-for-e2e');
    localStorage.setItem(
      'studio.jwt.user',
      JSON.stringify({ user_id: 'test', display_name: 'Test', role: 'user', subscriptions: [] }),
    );
  });
}

test.describe('sse-fatal-error', () => {
  test('fatal event surfaces ErrorAlert + retry restarts the stream', async ({ page }) => {
    await seedAuth(page);
    const getCalls = await mockApi(page);

    await page.goto('/step/1');
    // Type a valid prompt.
    await page.locator('textarea').first().fill('30대 여성, 따뜻한 분위기, 베이지 니트, 친근한 표정');
    // Click the primary "쇼호스트 만들기" button.
    await page.getByRole('button', { name: /쇼호스트 만들기|다시 만들기|만들기/ }).first().click();

    // Inline ErrorAlert appears.
    await expect(page.getByTestId('error-alert')).toBeVisible({ timeout: 5_000 });
    expect(getCalls()).toBeGreaterThanOrEqual(1);

    // Retry affordance restarts the mutation.
    const before = getCalls();
    await page.getByRole('button', { name: /다시 시도/ }).click();
    await expect(page.getByTestId('error-alert')).toBeVisible();
    expect(getCalls()).toBeGreaterThan(before);
  });
});
