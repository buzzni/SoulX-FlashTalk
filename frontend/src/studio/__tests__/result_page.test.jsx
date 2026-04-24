/**
 * ResultPage — /result/:taskId view, fed exclusively by /api/results/{id}.
 * Verifies the ProvenanceCard populates from the manifest (params + meta)
 * rather than from any live wizard state.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

// Mock only the queue fetch — everything else (fetchResult,
// humanizeError) uses the real implementation so the `global.fetch`
// override in `renderAt` is what drives the ResultPage request.
vi.mock('../../api/queue', () => ({
  fetchQueue: vi.fn().mockResolvedValue({
    running: [],
    pending: [],
    recent: [],
    total_running: 0,
    total_pending: 0,
  }),
  cancelQueuedTask: vi.fn(),
}));

import ResultPage from '../ResultPage.tsx';
import { __queueStoreInternals } from '../../stores/queueStore';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  __queueStoreInternals.reset();
});

function renderAt(taskId, manifest) {
  // Intercept /api/results/{id}; let /api/queue fall through to the mocked
  // default so QueueStatus (inside ResultPage) doesn't blow up on undefined.
  global.fetch = vi.fn().mockImplementation((url) => {
    if (typeof url === 'string' && url.startsWith('/api/results/')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(manifest),
      });
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}), headers: { get: () => '0' } });
  });

  return render(
    <MemoryRouter initialEntries={[`/result/${taskId}`]}>
      <Routes>
        <Route path="/result/:taskId" element={<ResultPage />} />
      </Routes>
    </MemoryRouter>
  );
}

describe('ResultPage — manifest-driven rendering', () => {
  it('populates ProvenanceCard fields from manifest meta (voiceName, products, script, quality)', async () => {
    renderAt('done-meta', {
      task_id: 'done-meta',
      type: 'generate',
      status: 'completed',
      completed_at: '2026-04-23T10:03:00',
      generation_time_sec: 180,
      video_url: '/api/videos/done-meta',
      video_bytes: 12345678,
      params: {
        resolution_requested: '1280x720',
        resolution_actual: '1280x720',
        script_text: '안녕하세요',
        scene_prompt: '',
        audio_source_label: 'tts',
        host_image: '/opt/project/outputs/composites/c.png',
      },
      meta: {
        host: { mode: 'image', selectedSeed: 42, temperature: 0.4 },
        composition: { shot: 'medium', temperature: 1.0 },
        products: [{ name: '쿠션' }, { name: '소파' }],
        background: { source: 'preset', presetLabel: '아늑한 거실' },
        voice: { source: 'tts', voiceName: '민지', script: '안녕하세요' },
        imageQuality: '2K',
      },
    });

    await waitFor(() => {
      expect(screen.getByText('민지')).toBeTruthy();
      expect(screen.getByText('아늑한 거실')).toBeTruthy();
      expect(screen.getByText('고화질 (2K)')).toBeTruthy();
      expect(screen.getByText('쿠션, 소파')).toBeTruthy();
      expect(screen.getByText('안녕하세요')).toBeTruthy();
    });
  });

  it('summary card shows actual rendered resolution (W×H) from params', async () => {
    renderAt('done-hd', {
      task_id: 'done-hd',
      type: 'generate',
      status: 'completed',
      completed_at: '2026-04-23T10:03:00',
      video_url: '/api/videos/done-hd',
      params: { resolution_requested: '720x1280', resolution_actual: '720x1280' },
      meta: null,
    });

    await waitFor(() => {
      // 720x1280 = HxW; display as W×H
      expect(screen.getByText('1280×720 · 세로형')).toBeTruthy();
    });
  });

  it('surfaces 16× snap (requested 1920×1080 → actual 1920×1072)', async () => {
    renderAt('snapped', {
      task_id: 'snapped',
      status: 'completed',
      completed_at: '2026-04-23T10:03:00',
      video_url: '/api/videos/snapped',
      params: {
        resolution_requested: '1920x1080',
        resolution_actual: '1920x1072',
      },
      meta: null,
    });

    await waitFor(() => {
      // Actual (1072×1920 = W×H) renders in both the summary card and the
      // ProvenanceCard resolution row — same value, two places.
      expect(screen.getAllByText('1072×1920').length).toBeGreaterThan(0);
      // Requested is surfaced as a subtitle hint in ProvenanceCard
      expect(screen.getByText(/요청 1080×1920/)).toBeTruthy();
    });
  });

  it('renders "—" for fields missing from both params and meta (pre-manifest task)', async () => {
    renderAt('old-task', {
      task_id: 'old-task',
      status: 'completed',
      completed_at: '2026-04-23T10:03:00',
      video_url: '/api/videos/old-task',
      params: { resolution_requested: '768x448', audio_source_label: 'upload' },
      meta: null,
      synthesized: true,
    });

    await waitFor(() => {
      // imageQuality must NOT silently default to "1K" when we don't know.
      // Previous bug: `|| '1K'` made every meta-less task look like 1K.
      expect(screen.queryByText('표준 (1K)')).toBeNull();
      // Voice source came from params.audio_source_label, not meta
      expect(screen.getByText('녹음 파일 업로드')).toBeTruthy();
    });
  });

  it('shows error-state header for failed tasks', async () => {
    renderAt('err-1', {
      task_id: 'err-1',
      status: 'error',
      error: 'simulated failure',
      video_url: '/api/videos/err-1',
      params: {},
      meta: null,
    });

    await waitFor(() => {
      expect(screen.getByText('만들기에 실패했어요')).toBeTruthy();
    });
  });
});
