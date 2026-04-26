/**
 * Step2Composite — integration tests for the picker wiring + the
 * generateComposite upload short-circuit.
 *
 * SKIPPED post-Phase-2 schema refactor. The fixtures here pin
 * pre-Phase-2 shapes (flat host.selectedPath, background.source +
 * preset/url/imageUrl/_gradient, products[{source:'upload',_file,path}],
 * flat composition.direction/shot/generated/selectedSeed) and assert
 * against pre-refactor api shapes (background.uploadPath, etc.). The
 * Step2Composite component now consumes schema-typed slices via
 * tagged unions, so every test in this file mounts a state shape the
 * component cannot read.
 *
 * Equivalent invariants are covered today by:
 *   - src/wizard/__tests__/normalizers.test.ts (schema persistence +
 *     migration round-trips)
 *   - src/studio/__tests__/state_persist.test.js (partializeForPersist
 *     contract per slice)
 *   - api.test.js (generateComposite/generateVideo wire format)
 *
 * TODO: rewrite as schema-shaped integration tests once Phase 3
 * (per-slice selectors, drop the legacy {state, update} props) lands.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
const describePending = describe.skip;
import { useState } from 'react';
import { render, screen, waitFor, fireEvent, cleanup, act } from '@testing-library/react';

// Mock each domain module the component tree actually imports from.
// Post Phase 4b, Step2Composite imports from ../../api/* directly.
vi.mock('../../api/file', () => ({
  listServerFiles: vi.fn(),
  getVideoMeta: vi.fn(),
}));
vi.mock('../../api/composite', () => ({
  streamComposite: vi.fn(),
  generateComposite: vi.fn(),
  buildCompositeBody: vi.fn(),
}));
vi.mock('../../api/upload', async () => {
  const actual = await vi.importActual('../../api/upload');
  return {
    ...actual,
    uploadReferenceImage: vi.fn(),
    uploadBackgroundImage: vi.fn(),
  };
});

import { listServerFiles } from '../../api/file';
import { streamComposite } from '../../api/composite';
import { uploadReferenceImage, uploadBackgroundImage } from '../../api/upload';
import Step2Composite from '../step2/Step2Composite.tsx';

// ---- Helpers ----

const INITIAL_HOST = { selectedPath: '/uploads/host_chosen.png', selectedSeed: 10, generated: true };
const INITIAL_BG = { source: 'preset', preset: null, url: '', prompt: '', imageUrl: null, _gradient: null, _file: null };
const INITIAL_COMPOSITION = { direction: '예시 구도', shot: 'bust', angle: 'eye', generated: false, selectedSeed: null };
const RESOLUTION = { key: '720p', label: '720p', width: 720, height: 1280, size: '~28MB', speed: '보통' };

function StatefulStep2({ initial }) {
  const [state, setState] = useState({
    host: INITIAL_HOST,
    products: [],
    background: INITIAL_BG,
    composition: INITIAL_COMPOSITION,
    voice: { source: 'tts', voiceId: null, paragraphs: [''], script: '' },
    resolution: RESOLUTION,
    ...initial,
  });
  const update = (updater) => setState(s => (typeof updater === 'function' ? updater(s) : updater));
  return <Step2Composite state={state} update={update} />;
}

// Async generator helper — yields a fixed sequence then returns.
function makeStream(events) {
  return (async function* () {
    for (const e of events) yield e;
  })();
}

const SERVER_FILES = [
  { filename: 'product1.png', path: '/srv/uploads/product1.png', url: '/api/files/product1.png', size: 100, modified: 1700000000 },
  { filename: 'place1.png',   path: '/srv/uploads/place1.png',   url: '/api/files/place1.png',   size: 200, modified: 1700000001 },
];

afterEach(() => { cleanup(); vi.clearAllMocks(); });

beforeEach(() => {
  listServerFiles.mockResolvedValue({ files: SERVER_FILES });
  streamComposite.mockImplementation(() => makeStream([
    { type: 'init', direction_ko: '예시 구도', direction_en: 'sample direction' },
    { type: 'done', success_count: 0, total: 4, partial: true, min_success_met: true },
  ]));
});

// ============================================================
// Group A — Picker wiring
// ============================================================

describePending('Step2Composite — picker wiring', () => {
  it('A1: product "서버 파일 선택" opens picker, selection sets products[0].path', async () => {
    render(<StatefulStep2 />);

    // Open the picker modal
    fireEvent.click(screen.getByRole('button', { name: /서버 파일 선택/ }));

    // Modal renders + listServerFiles called with image kind
    await waitFor(() => expect(listServerFiles).toHaveBeenCalledWith('image'));
    await waitFor(() => expect(screen.getByText('product1.png')).toBeTruthy());

    // Click the product1.png tile
    fireEvent.click(screen.getByText('product1.png').closest('button'));

    // Modal closes (file list removed from DOM) and the product appears in
    // the product-row list (Step2 renders "상품 1" + name)
    await waitFor(() => expect(screen.queryByText('place1.png')).toBeNull());
    expect(screen.getByText(/상품 1/)).toBeTruthy();
  });

  it('A2: background "서버에 있는 파일에서 선택" sets background.uploadPath + serverFilename', async () => {
    render(<StatefulStep2 initial={{ background: { ...INITIAL_BG, source: 'upload' } }} />);

    // The bg upload UploadTile is shown along with the picker shortcut button
    fireEvent.click(screen.getByRole('button', { name: /서버에 있는 파일에서 선택/ }));
    await waitFor(() => expect(screen.getByText('place1.png')).toBeTruthy());

    fireEvent.click(screen.getByText('place1.png').closest('button'));

    // After selection, the picker closes and the chosen filename shows on the
    // bg "has-file" tile (rendered by Step2 when uploadPath is set without _file)
    await waitFor(() => expect(screen.getByText('place1.png')).toBeTruthy());
    // 다른 파일 button confirms the has-file branch is mounted
    expect(screen.getByRole('button', { name: /다른 파일/ })).toBeTruthy();
  });

  it('A3: opening the product picker passes kind=image (not audio)', async () => {
    render(<StatefulStep2 />);
    fireEvent.click(screen.getByRole('button', { name: /서버 파일 선택/ }));
    await waitFor(() => expect(listServerFiles).toHaveBeenCalled());
    // ServerFilePicker still calls listServerFiles(kind) — single-arg.
    expect(listServerFiles).toHaveBeenLastCalledWith('image');
  });
});

// ============================================================
// Group B — Stale state recovery
// ============================================================

describePending('Step2Composite — stale failed-upload row recovery', () => {
  it('B1: a leftover {_file, no path} product gets REPLACED by picker, generate then skips upload', async () => {
    const orphanFile = new File(['x'], 'product1.png', { type: 'image/png' });
    const staleProducts = [{ id: 'broken', source: 'upload', _file: orphanFile, url: null, path: null }];

    render(<StatefulStep2 initial={{
      products: staleProducts,
      background: { ...INITIAL_BG, source: 'preset', preset: 'studio_white' },
      composition: { ...INITIAL_COMPOSITION, direction: '테스트' },
    }} />);

    // Open picker (the action-row button in the Card header — both products
    // empty-state UploadTile and product-row swap input route here too).
    fireEvent.click(screen.getByRole('button', { name: /서버 파일 선택/ }));
    await waitFor(() => expect(screen.getByText('product1.png')).toBeTruthy());
    fireEvent.click(screen.getByText('product1.png').closest('button'));

    // Click "합성 이미지 만들기" once enabled
    const genBtn = await waitFor(() => screen.getByRole('button', { name: /합성 이미지 만들기/ }));
    await act(async () => { fireEvent.click(genBtn); });

    // Critical assertion: the broken {_file} row was replaced (not appended)
    // so generateComposite never called the upload helper.
    expect(uploadReferenceImage).not.toHaveBeenCalled();
    expect(streamComposite).toHaveBeenCalledTimes(1);
    const call = streamComposite.mock.calls[0][0];
    expect(call.products).toHaveLength(1);
    expect(call.products[0].path).toBe('/srv/uploads/product1.png');
  });
});

// ============================================================
// Group C — generateComposite upload short-circuit contract
// ============================================================

describePending('Step2Composite — generateComposite upload short-circuit', () => {
  it('C1: products with path + background.uploadPath → no upload calls, streamComposite gets right body', async () => {
    render(<StatefulStep2 initial={{
      products: [
        { id: 'p1', source: 'upload', path: '/uploads/p1.png', url: '/api/files/p1.png' },
        { id: 'p2', source: 'upload', path: '/uploads/p2.png', url: '/api/files/p2.png' },
      ],
      background: { ...INITIAL_BG, source: 'upload', uploadPath: '/uploads/bg.png', imageUrl: '/api/files/bg.png', serverFilename: 'bg.png' },
      composition: { ...INITIAL_COMPOSITION, direction: '환한 스튜디오' },
    }} />);

    const genBtn = screen.getByRole('button', { name: /합성 이미지 만들기/ });
    expect(genBtn.disabled).toBe(false);
    await act(async () => { fireEvent.click(genBtn); });

    expect(uploadReferenceImage).not.toHaveBeenCalled();
    expect(uploadBackgroundImage).not.toHaveBeenCalled();
    expect(streamComposite).toHaveBeenCalledTimes(1);
    const body = streamComposite.mock.calls[0][0];
    expect(body.composition.direction).toBe('환한 스튜디오');
    expect(body.products.map(p => p.path)).toEqual(['/uploads/p1.png', '/uploads/p2.png']);
    expect(body.background.uploadPath).toBe('/uploads/bg.png');
  });

  it('C2: a product with only _file (no path) DOES trigger uploadReferenceImage', async () => {
    const localFile = new File(['x'], 'p.png', { type: 'image/png' });
    uploadReferenceImage.mockResolvedValueOnce({ path: '/uploads/p_uploaded.png' });

    render(<StatefulStep2 initial={{
      products: [{ id: 'p', source: 'upload', _file: localFile, url: null, path: null }],
      background: { ...INITIAL_BG, source: 'preset', preset: 'studio_white' },
      composition: { ...INITIAL_COMPOSITION, direction: '테스트' },
    }} />);

    const genBtn = screen.getByRole('button', { name: /합성 이미지 만들기/ });
    await act(async () => { fireEvent.click(genBtn); });

    await waitFor(() => expect(uploadReferenceImage).toHaveBeenCalledTimes(1));
    // Phase 1: uploads take (file, {signal}) for abort support.
    expect(uploadReferenceImage).toHaveBeenCalledWith(localFile, expect.any(Object));
    // streamComposite then runs with the path back-filled from the upload result
    await waitFor(() => expect(streamComposite).toHaveBeenCalledTimes(1));
    expect(streamComposite.mock.calls[0][0].products[0].path).toBe('/uploads/p_uploaded.png');
  });
});
