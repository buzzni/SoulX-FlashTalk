/**
 * pollFailed → isError transition — real-clock integration test.
 *
 * vitest (`useRenderJob.test.jsx`) proves that a single `{error: true}`
 * event from subscribeProgress flips both `pollFailed` and `isError`.
 * That test mocks subscribeProgress itself, so it can't prove the
 * whole chain end-to-end: the progress endpoint returning 8x
 * consecutive 404s, `subscribeProgress.ts` counting to the failure
 * budget, calling `onUpdate({error: true})`, the hook updating state,
 * and the dashboard re-rendering with the error header.
 *
 * This test drives the real chain: stock endpoint mocks (queue is
 * empty, progress always 404s) + Playwright waits for the header
 * swap. If the chain breaks anywhere — backoff logic, dep array
 * regression, or a future refactor that disconnects pollFailed from
 * isError — this test fails before users see an infinite spinner.
 *
 * Time budget: subscribeProgress polls every 1.5s and gives up after
 * 8 errors, so the header should swap at ~12s. We wait up to 30s.
 */
import { test, expect } from '@playwright/test';

test('progress endpoint 404s for 12s → dashboard flips to "만들기에 실패했어요"', async ({
  page,
}) => {
  await page.addInitScript(() => {
    try {
      localStorage.clear();
      sessionStorage.clear();
    } catch {
      /* ignore */
    }
  });
  await page.route('**/api/queue', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        running: [],
        pending: [],
        recent: [],
        total_running: 0,
        total_pending: 0,
      }),
    }),
  );
  await page.route('**/api/tasks/*/state', (route) =>
    route.fulfill({ status: 404, body: 'not found' }),
  );

  await page.goto('/render/bogus-task');

  // First render: attach mode, subscribeProgress not yet given up.
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    /영상 만드는 중이에요/,
  );

  // Wait for the failure budget (~12s) + a cushion for slower CI machines.
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    /만들기에 실패했어요/,
    { timeout: 30_000 },
  );

  // The reconnect message should be the visible error text.
  await expect(page.getByText('진행 상황 구독이 끊겼어요')).toBeVisible();
});
