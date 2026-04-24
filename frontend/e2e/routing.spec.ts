/**
 * Route tree + guard behavior — browser-level regression guard for
 * Phase 5. vitest already covers `computeValidity` and the guard
 * logic in isolation, but only the real router can tell us whether a
 * `<Navigate />` returned mid-render actually resolves in time to
 * prevent the child from mounting (the bug that showed up during
 * browse smoke and got fixed in 337b86d).
 *
 * Mocking strategy: `/api/queue` and friends are mocked to an empty
 * queue so the stores hydrate quickly. Tests don't touch anything
 * that needs real backend state.
 */
import { test, expect } from '@playwright/test';

const EMPTY_QUEUE = {
  running: [],
  pending: [],
  recent: [],
  total_running: 0,
  total_pending: 0,
};

async function mockQueue(page: import('@playwright/test').Page) {
  await page.route('**/api/queue', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(EMPTY_QUEUE),
    });
  });
}

async function clearStores(page: import('@playwright/test').Page) {
  // Wipe localStorage BEFORE the app mounts so wizardStore sees an
  // empty state. Zustand's persist middleware reads localStorage in
  // its initializer, so the window must load with storage already
  // cleared.
  await page.addInitScript(() => {
    try {
      localStorage.clear();
      sessionStorage.clear();
    } catch {
      /* ignore — file:// origins throw, test envs don't */
    }
  });
}

test.describe('route guards (empty wizard state)', () => {
  test.beforeEach(async ({ page }) => {
    await clearStores(page);
    await mockQueue(page);
  });

  test('/ redirects to /step/1', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/step\/1$/);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('쇼호스트');
  });

  test('/step/2 redirects to /step/1 (step 1 not satisfied)', async ({ page }) => {
    await page.goto('/step/2');
    await expect(page).toHaveURL(/\/step\/1$/);
  });

  test('/step/3 redirects to /step/1 (step 1+2 not satisfied)', async ({ page }) => {
    await page.goto('/step/3');
    await expect(page).toHaveURL(/\/step\/1$/);
  });

  test('/render redirects to /step/1 (wizard not valid)', async ({ page }) => {
    await page.goto('/render');
    await expect(page).toHaveURL(/\/step\/1$/);
  });

  test('/render/:taskId stays on attach-mode dashboard even without wizard state', async ({ page }) => {
    // Mock the progress endpoint so the dashboard has a stable starting state.
    await page.route('**/api/tasks/*/state', (route) =>
      route.fulfill({ status: 404, body: 'not found' }),
    );
    await page.goto('/render/bogus-task');
    await expect(page).toHaveURL(/\/render\/bogus-task$/);
    // Header should be "영상 만드는 중이에요" (rendering) initially, not a redirect target.
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(/영상 만드는 중|만들기에 실패/);
  });

  test('/result/:taskId shows friendly error header on 404 manifest', async ({ page }) => {
    await page.route('**/api/results/*', (route) =>
      route.fulfill({ status: 404, body: 'not found' }),
    );
    await page.goto('/result/bogus-task');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      /영상 정보를 불러오지 못했어요/,
    );
  });

  test('unknown path falls through catch-all to /step/1', async ({ page }) => {
    await page.goto('/nonsense/path');
    await expect(page).toHaveURL(/\/step\/1$/);
  });
});

test.describe('route guards (with valid wizard state)', () => {
  test.beforeEach(async ({ page }) => {
    await clearStores(page);
    await mockQueue(page);
    // Seed a fully-valid wizard state directly into localStorage so
    // guards let us reach step 3 and /render without completing the
    // actual wizard flow.
    await page.addInitScript(() => {
      const state = {
        host: { generated: true, imageUrl: '/fake/host.png' },
        composition: { generated: true, selectedSeed: 10 },
        voice: {
          source: 'tts',
          generated: true,
          generatedAudioPath: '/fake/audio.wav',
          script: '테스트 대본',
        },
        resolution: { key: '448p', width: 448, height: 768, label: '448p' },
      };
      // wizardStore persist envelope: { state, version }. `version` MUST
      // match wizardStore.ts's `version: 1` or Zustand discards the
      // payload as "from an older version with no migrator available."
      localStorage.setItem(
        'showhost.wizard.v1',
        JSON.stringify({ state, version: 1 }),
      );
    });
  });

  test('/step/3 allowed when steps 1+2 satisfied', async ({ page }) => {
    await page.goto('/step/3');
    await expect(page).toHaveURL(/\/step\/3$/);
  });

  test('/step/2 allowed when step 1 satisfied', async ({ page }) => {
    await page.goto('/step/2');
    await expect(page).toHaveURL(/\/step\/2$/);
  });
});

test.describe('render back button targets the deepest reachable step', () => {
  test.beforeEach(async ({ page }) => {
    await mockQueue(page);
    await page.route('**/api/tasks/*/state', (route) =>
      route.fulfill({ status: 404, body: 'not found' }),
    );
  });

  test('attached user with empty wizard state lands at /step/1 (not bounced through /step/3)', async ({
    page,
  }) => {
    // No seed — wizard state is empty, simulating a user who clicked a
    // queue item in a fresh session. handleBack used to unconditionally
    // go to /step/3, which the WizardLayout guard then bounced back to
    // /step/1. Now it asks deepestReachableStep(valid) up front and
    // routes straight to /step/1 — no visible bounce, no misleading
    // "go edit" button label.
    await page.addInitScript(() => {
      try {
        localStorage.clear();
      } catch {
        /* ignore */
      }
    });
    await page.goto('/render/bogus-task');
    await page.getByRole('button', { name: /앞으로 돌아가서 수정/ }).click();
    await expect(page).toHaveURL(/\/step\/1$/);
  });

  test('attached user with full wizard state lands at /step/3', async ({ page }) => {
    // Seed a fully-valid wizard so deepestReachableStep returns 3.
    await page.addInitScript(() => {
      try {
        localStorage.clear();
        const state = {
          host: { generated: true, imageUrl: '/fake/host.png' },
          composition: { generated: true, selectedSeed: 10 },
          voice: {
            source: 'tts',
            generated: true,
            generatedAudioPath: '/fake/audio.wav',
            script: '테스트 대본',
          },
          resolution: { key: '448p', width: 448, height: 768, label: '448p' },
        };
        localStorage.setItem(
          'showhost.wizard.v1',
          JSON.stringify({ state, version: 1 }),
        );
      } catch {
        /* ignore */
      }
    });
    await page.goto('/render/bogus-task');
    await page.getByRole('button', { name: /앞으로 돌아가서 수정/ }).click();
    await expect(page).toHaveURL(/\/step\/3$/);
  });
});
