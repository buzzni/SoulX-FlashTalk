/**
 * E2E: step2-rhf — Step 2 RHF migration regression guards.
 *
 * Three behaviors get explicit asserts because they're load-bearing
 * for the Step 2 RHF refactor (feat/step2-rhf):
 *
 *   1. Background preset → prompt swap commits the new tagged-union
 *      shape to localStorage with no stale fields. Hard-reset
 *      semantics in useFormZustandSync (keepDirty:false) mean the
 *      discriminator must flip even when other fields were dirty.
 *
 *   2. Reverse swap (prompt → preset) — symmetric guard.
 *
 *   3. CRITICAL: typed direction survives a composition.generation
 *      mutation (simulated SSE candidate event). Step2Composite
 *      subscribes to composition.settings, NOT the full composition,
 *      so streaming events MUST NOT trigger a form.reset that wipes
 *      the user's in-progress textarea input. Caught and fixed during
 *      /simplify pre-landing review — this spec is the regression
 *      guard.
 */
import { test, expect } from '@playwright/test';

const EMPTY_QUEUE = { running: [], pending: [], recent: [], total_running: 0, total_pending: 0 };
const SEEDED_STATE = {
  state: {
    host: {
      input: { kind: 'text', prompt: 'a'.repeat(20), builder: {}, negativePrompt: '', extraPrompt: '' },
      temperature: 0.7,
      generation: {
        state: 'ready',
        batchId: 'b1',
        variants: [{ seed: 1, imageId: 'h1', url: '/u/h1.png', path: '/p/h1.png' }],
        selected: { seed: 1, imageId: 'h1', url: '/u/h1.png', path: '/p/h1.png' },
        prevSelected: null,
      },
    },
    products: [
      { id: 'p1', name: 'p1', source: { kind: 'uploaded', asset: { path: '/u/p1.png', url: '/u/p1.png', name: 'p1' } } },
    ],
    background: { kind: 'preset', presetId: null },
    composition: {
      settings: { direction: '', shot: 'medium', angle: 'eye', temperature: 0.7, rembg: true },
      generation: { state: 'idle' },
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
  },
  version: 8,
};

async function mockApi(page: import('@playwright/test').Page) {
  await page.route('**/api/queue', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(EMPTY_QUEUE) }),
  );
  await page.route('**/api/auth/me', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ user_id: 'test', display_name: 'Test', role: 'user', subscriptions: [] }),
    }),
  );
  await page.route('**/api/playlists', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ playlists: [], unassigned_count: 0 }),
    }),
  );
}

async function seed(page: import('@playwright/test').Page) {
  await page.addInitScript((s) => {
    localStorage.setItem('studio.jwt.access', 'fake-token-for-e2e');
    localStorage.setItem(
      'studio.jwt.user',
      JSON.stringify({ user_id: 'test', display_name: 'Test', role: 'user', subscriptions: [] }),
    );
    localStorage.setItem('showhost.wizard.v1', JSON.stringify(s));
  }, SEEDED_STATE);
}

test.describe('step2-rhf', () => {
  test.beforeEach(async ({ page }) => {
    await seed(page);
    await mockApi(page);
  });

  test('background preset → prompt swap commits tagged shape with no stale fields', async ({ page }) => {
    await page.goto('/step/2');
    await page.waitForLoadState('networkidle');
    await page.getByText('AI로 새로 만들기').click();
    // Wait beyond 300ms debounce so the form→store flush lands.
    await page.waitForTimeout(400);

    const stored = await page.evaluate(() => {
      const raw = localStorage.getItem('showhost.wizard.v1');
      if (!raw) return null;
      const env = JSON.parse(raw) as {
        state: { background: { kind: string; presetId?: unknown; prompt?: unknown } };
      };
      return env.state.background;
    });
    expect(stored?.kind).toBe('prompt');
    expect((stored as { presetId?: unknown }).presetId).toBeUndefined();
  });

  test('background prompt → preset reverse swap drops stale prompt field', async ({ page }) => {
    await page.goto('/step/2');
    await page.waitForLoadState('networkidle');
    // Land in prompt mode first.
    await page.getByText('AI로 새로 만들기').click();
    await page.waitForTimeout(400);
    // Swap back to "이미 있는 이미지 쓰기" (preset).
    await page.getByText('이미 있는 이미지 쓰기').click();
    await page.waitForTimeout(400);

    const stored = await page.evaluate(() => {
      const raw = localStorage.getItem('showhost.wizard.v1');
      if (!raw) return null;
      const env = JSON.parse(raw) as {
        state: { background: { kind: string; prompt?: unknown; presetId?: unknown } };
      };
      return env.state.background;
    });
    expect(stored?.kind).toBe('preset');
    expect((stored as { prompt?: unknown }).prompt).toBeUndefined();
  });

  test('typed direction survives a simulated composition.generation mutation', async ({ page }) => {
    await page.goto('/step/2');
    await page.waitForLoadState('networkidle');
    const directionTa = page.locator('textarea').first();
    await directionTa.fill('소파에 앉아 1번 들고 있음 - 사용자 입력');
    // Wait for the 300ms debounce flush so the typed value lands in store.
    await page.waitForTimeout(400);

    // Simulate an SSE candidate event by mutating composition.generation
    // via the persisted blob + a storage event. The Step2Composite
    // container subscribes only to composition.settings, so this
    // mutation MUST NOT trigger a form.reset that would wipe the
    // textarea (the regression that motivated CRITICAL #1 fix).
    await page.evaluate(() => {
      const raw = JSON.parse(localStorage.getItem('showhost.wizard.v1')!);
      raw.state.composition.generation = {
        state: 'streaming',
        batchId: 'sse-batch',
        variants: [{ seed: 11, imageId: 'cand-1', url: '/u/c1.png', path: '/p/c1.png' }],
      };
      localStorage.setItem('showhost.wizard.v1', JSON.stringify(raw));
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: 'showhost.wizard.v1',
          newValue: JSON.stringify(raw),
        }),
      );
    });
    await page.waitForTimeout(200);

    await expect(directionTa).toHaveValue('소파에 앉아 1번 들고 있음 - 사용자 입력');
  });
});
