/**
 * doEditAndRetry — rehydrate guard for damaged rows.
 *
 * Plan: docs/plans/result-rehydration-fix-plan.md (Fix 3)
 *
 * Pre-fix worker bug shadowed `params.audio_path` with a temp absolute
 * path (`/opt/.../temp/job-input-x.wav`). doEditAndRetry must reject those
 * values and fall through to a blank voice slice — feeding the temp path
 * back into a dispatch would 404 on the worker. Storage-key shaped values
 * pass through.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

vi.mock('../../api/queue', () => ({
  fetchQueue: vi.fn().mockResolvedValue({
    running: [], pending: [], recent: [], total_running: 0, total_pending: 0,
  }),
  cancelQueuedTask: vi.fn(),
}));

import ResultPage from '../ResultPage.tsx';
import { useWizardStore } from '../../stores/wizardStore';
import { __queueStoreInternals } from '../../stores/queueStore';
import { INITIAL_WIZARD_STATE } from '../../wizard/schema';

beforeEach(() => {
  // Reset wizard so each test starts from a known state.
  useWizardStore.setState({ ...INITIAL_WIZARD_STATE, wizardEpoch: 0 });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  __queueStoreInternals.reset();
});

function renderAt(taskId, manifest) {
  global.fetch = vi.fn().mockImplementation((url) => {
    if (typeof url === 'string' && url.startsWith('/api/results/')) {
      return Promise.resolve({
        ok: true, status: 200, json: () => Promise.resolve(manifest),
      });
    }
    return Promise.resolve({
      ok: true, status: 200, json: () => Promise.resolve({}),
      headers: { get: () => '0' },
    });
  });
  return render(
    <MemoryRouter initialEntries={[`/result/${taskId}`]}>
      <Routes>
        <Route path="/result/:taskId" element={<ResultPage />} />
        <Route path="/step/*" element={<div>STEP</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

async function clickEditAndRetry() {
  // status='error' + retried_from set → ResultPrimary renders the
  // "수정해서 다시 만들기" button directly (D3A retry-aware swap).
  // Click that to open the confirmation modal, then "시작하기" to fire
  // doEditAndRetry.
  const editBtn = await screen.findByText('수정해서 다시 만들기');
  fireEvent.click(editBtn);
  const startBtn = await screen.findByText('시작하기');
  await act(async () => {
    fireEvent.click(startBtn);
  });
}


describe('doEditAndRetry — audio guard', () => {
  it('rejects temp absolute path; falls through to idle voice', async () => {
    renderAt('damaged-audio', {
      task_id: 'damaged-audio',
      type: 'generate',
      status: 'error',
      completed_at: '2026-04-29T10:00:00',
      video_url: '',
      error: 'failed',
      retried_from: 'prev_task',
      params: {
        host_image: 'outputs/composites/comp_ok.png',
        // Bug: worker shadowed this with the temp download path.
        audio_path: '/opt/home/jack/workspace/SoulX-FlashTalk/temp/job-input-x.wav',
        script_text: 'hello',
      },
      meta: {
        host: { mode: 'text', selectedPath: 'outputs/hosts/saved/host_a.png', selectedSeed: 1 },
        composition: { selectedPath: 'outputs/composites/comp_ok.png', selectedSeed: 1, shot: 'medium', angle: 'eye' },
        voice: { source: 'tts', voiceId: 'v1', voiceName: 'Joy', script: 'hello' },
      },
    });

    await clickEditAndRetry();

    const v = useWizardStore.getState().voice;
    // tts source preserved; generation must fall to idle (no audio asset
    // recovered from a temp path).
    expect(v.source).toBe('tts');
    expect(v.generation.state).toBe('idle');
  });

  it('keeps storage-key audio_path; voice generation lands ready', async () => {
    renderAt('clean-audio', {
      task_id: 'clean-audio',
      type: 'generate',
      status: 'error',
      completed_at: '2026-04-29T10:00:00',
      video_url: '',
      error: 'failed',
      retried_from: 'prev_task',
      params: {
        host_image: 'outputs/composites/comp_ok.png',
        audio_path: 'outputs/tts_clean.wav',
        audio_url: 'https://stub/outputs/tts_clean.wav',
        script_text: 'hi',
      },
      meta: {
        host: { mode: 'text', selectedPath: 'outputs/hosts/saved/host.png', selectedSeed: 1 },
        composition: { selectedPath: 'outputs/composites/comp_ok.png', selectedSeed: 1, shot: 'medium', angle: 'eye' },
        voice: { source: 'tts', voiceId: 'v1', voiceName: 'Joy', script: 'hi' },
      },
    });

    await clickEditAndRetry();

    const v = useWizardStore.getState().voice;
    expect(v.source).toBe('tts');
    expect(v.generation.state).toBe('ready');
    expect(v.generation.audio.key).toBe('outputs/tts_clean.wav');
  });

  it('prefers params.audio_key over audio_path', async () => {
    renderAt('canonical-key', {
      task_id: 'canonical-key',
      type: 'generate',
      status: 'error',
      completed_at: '2026-04-29T10:00:00',
      video_url: '',
      error: 'failed',
      retried_from: 'prev_task',
      params: {
        host_image: 'outputs/composites/comp_ok.png',
        audio_key: 'outputs/canonical.wav',
        audio_path: 'outputs/legacy.wav',
        audio_url: 'https://stub/outputs/canonical.wav',
        script_text: 'hi',
      },
      meta: {
        host: { mode: 'text', selectedPath: 'outputs/hosts/saved/host.png', selectedSeed: 1 },
        composition: { selectedPath: 'outputs/composites/comp_ok.png', selectedSeed: 1, shot: 'medium', angle: 'eye' },
        voice: { source: 'tts', voiceId: 'v1', voiceName: 'Joy', script: 'hi' },
      },
    });

    await clickEditAndRetry();
    const v = useWizardStore.getState().voice;
    expect(v.generation.audio.key).toBe('outputs/canonical.wav');
  });
});
