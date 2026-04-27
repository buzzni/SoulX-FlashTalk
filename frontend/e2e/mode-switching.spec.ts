/**
 * E2E: mode-switching — Lane G / D8 spec.
 *
 * The tagged-union schemas mean Step 1 (text↔image), Step 2 (background
 * preset→upload→url→prompt), and Step 3 (tts↔clone↔upload) hold
 * mode-specific fields that the schema rejects when crossed. The
 * regression we want to catch: a user toggles modes and the previous
 * mode's input lingers — RHF's resolver should reject mode-cross
 * fields, and the wizard store's slice setters should replace the
 * whole tagged variant on switch.
 */
import { test, expect } from '@playwright/test';

const EMPTY_QUEUE = { running: [], pending: [], recent: [], total_running: 0, total_pending: 0 };

async function mockApi(page: import('@playwright/test').Page) {
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

test.describe('mode-switching', () => {
  test.beforeEach(async ({ page }) => {
    await seedAuth(page);
    await mockApi(page);
  });

  test('Step 1 text → image swap leaves no stale prompt in the schema', async ({ page }) => {
    await page.goto('/step/1');
    // Type a text prompt.
    const textArea = page.locator('textarea').first();
    await textArea.fill('30대 여성, 베이지 니트, 따뜻한 분위기');
    // Switch to image mode (the segmented control labels are stable).
    await page.getByRole('tab', { name: /사진|reference|image/i }).first().click();

    // Persisted state should be HostInput.kind === 'image'. The
    // tagged-union swap drops the text-mode `prompt` entirely.
    const stored = await page.evaluate(() => {
      const raw = localStorage.getItem('showhost.wizard.v1');
      if (!raw) return null;
      const env = JSON.parse(raw) as { state: { host: { input: { kind: string; prompt?: string } } } };
      return env.state.host.input;
    });
    expect(stored?.kind).toBe('image');
    expect((stored as { prompt?: string }).prompt).toBeUndefined();
  });
});
