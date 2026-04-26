/**
 * E2E: refresh-during-typing — Lane G / D8 specs.
 *
 * Asserts the D2 user-flow check from the stability plan: a user is
 * 200 characters into a Step 3 script, leaves their cursor for ~500ms
 * (long enough for the 300ms debounce to flush), refreshes the page,
 * and finds their text restored. Catches any regression where the
 * RHF→zustand bridge stops persisting drafts.
 *
 * Mocking: queue empty, history empty, voices stubbed. The wizard
 * doesn't need a backend for the script field itself — it's pure UI
 * state.
 */
import { test, expect } from '@playwright/test';

const EMPTY_QUEUE = { running: [], pending: [], recent: [], total_running: 0, total_pending: 0 };

async function mockApi(page: import('@playwright/test').Page) {
  await page.route('**/api/queue', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(EMPTY_QUEUE) }),
  );
  await page.route('**/api/elevenlabs/voices', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ voices: [] }),
    }),
  );
  await page.route('**/api/playlists', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ playlists: [], unassigned_count: 0 }),
    }),
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

test.describe('refresh-during-typing', () => {
  test.beforeEach(async ({ page }) => {
    await seedAuth(page);
    await mockApi(page);
  });

  test('200-char Step 3 script survives a refresh after 500ms idle', async ({ page }) => {
    // Seed a fully-valid Step 1 + Step 2 state so /step/3 isn't
    // redirected away by the wizard guard. We don't care about
    // generation correctness here — just that the route lets us land
    // and the script field is reachable.
    await page.addInitScript(() => {
      const state = {
        host: {
          input: { kind: 'text', prompt: 'a'.repeat(20), builder: {}, negativePrompt: '', extraPrompt: '' },
          temperature: 0.7,
          generation: {
            state: 'ready',
            batchId: 'b-test',
            variants: [{ seed: 1, imageId: 'h1', url: '/u/h1.png', path: '/p/h1.png' }],
            selected: { seed: 1, imageId: 'h1', url: '/u/h1.png', path: '/p/h1.png' },
            prevSelected: null,
          },
        },
        products: [],
        background: { kind: 'preset', presetId: 'sunset' },
        composition: {
          settings: { direction: '', shot: 'medium', angle: 'eye', temperature: 0.7, rembg: true },
          generation: {
            state: 'ready',
            batchId: 'b2',
            variants: [{ seed: 2, imageId: 'c1', url: '/u/c1.png', path: '/p/c1.png' }],
            selected: { seed: 2, imageId: 'c1', url: '/u/c1.png', path: '/p/c1.png' },
            prevSelected: null,
          },
        },
        voice: {
          source: 'tts',
          voiceId: null,
          voiceName: null,
          advanced: { speed: 1, stability: 0.5, style: 0.3, similarity: 0.75 },
          script: { paragraphs: [''] },
          generation: { state: 'idle' },
        },
        resolution: '448p',
        imageQuality: '1K',
        playlistId: null,
        wizardEpoch: 0,
        lastSavedAt: null,
      };
      localStorage.setItem(
        'showhost.wizard.v1',
        JSON.stringify({ state, version: 8 }),
      );
    });

    await page.goto('/step/3');
    await expect(page).toHaveURL(/\/step\/3/);

    const long = 'ㄱ'.repeat(200);
    const scriptInput = page.locator('textarea').first();
    await scriptInput.fill(long);
    // Wait beyond the 300ms debounce so the watch handler flushes.
    await page.waitForTimeout(500);

    await page.reload();
    const after = page.locator('textarea').first();
    await expect(after).toHaveValue(long);
  });
});
