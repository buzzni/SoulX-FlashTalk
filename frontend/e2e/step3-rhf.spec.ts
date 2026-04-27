/**
 * E2E: step3-rhf — Step 3 RHF migration regression guards.
 *
 * Behaviors with explicit asserts because they're load-bearing for the
 * Step 3 RHF refactor (feat/step3-rhf):
 *
 *   1. Voice source swaps tts → clone → upload → tts commit the new
 *      tagged-union shape to localStorage with no stale per-variant
 *      fields. Cross-variant swap MUST drop the prior variant's
 *      voice_id / sample / audio.
 *
 *   2. Script paragraphs add/remove/edit round-trip through
 *      voice.script.paragraphs (form → store) within the 300ms
 *      debounce window.
 *
 *   3. CRITICAL: typed script paragraph survives a simulated
 *      voice.generation mutation (TTS state machine event).
 *      Step3Audio subscribes to narrow voice fields (NOT the full
 *      voice slice), so generation mutations MUST NOT trigger a
 *      form.reset that would wipe in-progress edits.
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
    background: { kind: 'preset', presetId: 'studio_white' },
    composition: {
      settings: { direction: '', shot: 'medium', angle: 'eye', temperature: 0.7, rembg: true },
      generation: {
        state: 'ready',
        batchId: 'cb1',
        variants: [{ seed: 1, imageId: 'c1', url: '/u/c1.png', path: '/p/c1.png' }],
        selected: { seed: 1, imageId: 'c1', url: '/u/c1.png', path: '/p/c1.png' },
        prevSelected: null,
      },
    },
    voice: {
      source: 'tts',
      voiceId: 'v_minji',
      voiceName: '민지',
      advanced: { speed: 1, stability: 0.5, style: 0.3, similarity: 0.75 },
      script: { paragraphs: ['첫 문단'] },
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
  await page.route('**/api/elevenlabs/voices', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ voices: [] }),
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

async function readVoice(page: import('@playwright/test').Page) {
  return await page.evaluate(() => {
    const raw = localStorage.getItem('showhost.wizard.v1');
    if (!raw) return null;
    const env = JSON.parse(raw) as { state: { voice: Record<string, unknown> } };
    return env.state.voice;
  });
}

test.describe('step3-rhf', () => {
  test.beforeEach(async ({ page }) => {
    await seed(page);
    await mockApi(page);
  });

  test('tts → upload swap drops voiceId/voiceName/advanced; no stale fields persist', async ({ page }) => {
    await page.goto('/step/3');
    await page.waitForLoadState('networkidle');

    await page.getByText('내 녹음 그대로 쓰기').click();
    // Wait beyond 300ms debounce so the form→store flush lands.
    await page.waitForTimeout(400);

    const voice = await readVoice(page);
    expect(voice?.source).toBe('upload');
    expect(voice?.voiceId).toBeUndefined();
    expect(voice?.voiceName).toBeUndefined();
    expect(voice?.advanced).toBeUndefined();
    expect(voice).toHaveProperty('audio');
    expect(voice).toHaveProperty('script');
  });

  test('upload → tts swap restores tts shape with empty voiceId, drops audio', async ({ page }) => {
    await page.goto('/step/3');
    await page.waitForLoadState('networkidle');
    // Land in upload first.
    await page.getByText('내 녹음 그대로 쓰기').click();
    await page.waitForTimeout(400);
    // Swap back to AI.
    await page.getByText('AI로 음성 만들기').click();
    await page.waitForTimeout(400);

    const voice = await readVoice(page);
    expect(voice?.source).toBe('tts');
    expect(voice?.voiceId).toBeNull();
    expect(voice?.voiceName).toBeNull();
    expect(voice?.audio).toBeUndefined();
    expect(voice?.generation).toEqual({ state: 'idle' });
  });

  test('tts → clone sub-mode swap drops voiceId, initializes empty sample', async ({ page }) => {
    await page.goto('/step/3');
    await page.waitForLoadState('networkidle');

    await page.getByRole('tab', { name: /내 목소리 복제/ }).click();
    await page.waitForTimeout(400);

    const voice = await readVoice(page);
    expect(voice?.source).toBe('clone');
    expect(voice?.voiceId).toBeUndefined();
    expect(voice?.voiceName).toBeUndefined();
    expect(voice?.sample).toEqual({ state: 'empty' });
    expect(voice?.generation).toEqual({ state: 'idle' });
  });

  test('script paragraph add + edit round-trips through voice.script.paragraphs', async ({ page }) => {
    await page.goto('/step/3');
    await page.waitForLoadState('networkidle');

    // Type into the first paragraph.
    const firstPara = page.locator('textarea').first();
    await firstPara.fill('안녕하세요 첫 문단 내용입니다');
    await page.waitForTimeout(400);

    // Add a second paragraph.
    await page.getByRole('button', { name: /문단 추가/ }).click();
    const allParas = page.locator('textarea');
    await allParas.nth(1).fill('두 번째 문단 내용');
    await page.waitForTimeout(400);

    const voice = await readVoice(page);
    expect(voice?.source).toBe('tts');
    expect(voice).toHaveProperty('script');
    const paragraphs = (voice as { script: { paragraphs: string[] } }).script.paragraphs;
    expect(paragraphs).toEqual(['안녕하세요 첫 문단 내용입니다', '두 번째 문단 내용']);
  });

  test('typed script survives a simulated voice.generation mutation', async ({ page }) => {
    await page.goto('/step/3');
    await page.waitForLoadState('networkidle');

    const firstPara = page.locator('textarea').first();
    await firstPara.fill('타이핑 중인 사용자 입력');
    await page.waitForTimeout(400);

    // Simulate a TTS state-machine event by mutating voice.generation
    // via the persisted blob + a storage event. Step3Audio subscribes
    // to narrow voice fields (script, advanced, voiceId, voiceName,
    // sample, audio) — NOT to voice.generation. This mutation MUST
    // NOT trigger a form.reset that wipes the textarea.
    await page.evaluate(() => {
      const raw = JSON.parse(localStorage.getItem('showhost.wizard.v1')!);
      raw.state.voice.generation = { state: 'generating' };
      localStorage.setItem('showhost.wizard.v1', JSON.stringify(raw));
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: 'showhost.wizard.v1',
          newValue: JSON.stringify(raw),
        }),
      );
    });
    await page.waitForTimeout(200);

    await expect(firstPara).toHaveValue('타이핑 중인 사용자 입력');
  });
});
