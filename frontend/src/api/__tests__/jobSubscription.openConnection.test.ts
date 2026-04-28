/**
 * @vitest-environment jsdom
 *
 * _openConnection drive-loop tests for jobSubscription.
 *
 * Mocks `fetch` to return SSE byte streams and asserts the cache mutates
 * end-to-end. The sibling `jobSubscription.test.ts` covers refcount and
 * handle lifecycle; this file covers the actual fetch + parse + apply
 * machinery (~60% of the module that previously had 0% coverage).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _testActiveCount,
  _testReset,
  subscribeToJob,
} from '../jobSubscription';
import { useJobCacheStore } from '../../stores/jobCacheStore';

// ────────────────────────────────────────────────────────────────────
// Helpers — build streaming Response objects mocking fetch
// ────────────────────────────────────────────────────────────────────

/** Build a Response whose body emits the given SSE chunks then closes. */
function sseResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return new Response(stream, {
    status,
    headers: { 'content-type': 'text/event-stream' },
  });
}

/** Build a Response with a status code and JSON body, no streaming body. */
function errorResponse(status: number): Response {
  return new Response(JSON.stringify({ detail: `${status}` }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Pause until the cache enters a terminal state for `jobId`, or fail. */
async function waitForTerminal(jobId: string, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const entry = useJobCacheStore.getState().jobs[jobId];
    const state = entry?.snapshot?.state;
    if (state === 'ready' || state === 'failed' || state === 'cancelled') {
      return;
    }
    if (entry?.error) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(
    `did not reach terminal in ${timeoutMs}ms; last entry=${
      JSON.stringify(useJobCacheStore.getState().jobs[jobId])
    }`,
  );
}

/** Pause for one microtask + small tick so async generators schedule. */
const yieldOnce = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  _testReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  _testReset();
});

// ────────────────────────────────────────────────────────────────────
// Happy paths
// ────────────────────────────────────────────────────────────────────

describe('_openConnection — happy paths', () => {
  it('drives a snapshot → candidate → done sequence into the cache', async () => {
    const wire =
      'id: 0\nevent: snapshot\ndata: {"id":"job-1","kind":"host","state":"streaming","variants":[]}\n\n' +
      'id: 1\nevent: candidate\ndata: {"variant":{"image_id":"v1","path":"/p/v1.png","url":"/u/v1.png","seed":42}}\n\n' +
      'id: 2\nevent: done\ndata: {"batch_id":"b-1","prev_selected_image_id":null}\n\n';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([wire])));

    const handle = subscribeToJob('job-1');
    await waitForTerminal('job-1');

    const entry = useJobCacheStore.getState().jobs['job-1']!;
    expect(entry.snapshot?.state).toBe('ready');
    expect(entry.snapshot?.batch_id).toBe('b-1');
    expect(entry.snapshot?.variants).toHaveLength(1);
    expect(entry.snapshot?.variants[0]?.image_id).toBe('v1');
    expect(entry.lastSeq).toBe(2);
    handle.close();
  });

  it('handles a snapshot frame whose state is already terminal (early close)', async () => {
    // Backend's stream_job_events closes immediately after a terminal-state
    // snap (app.py: `if snap.get("state") in TERMINAL_STATES: return`).
    const wire =
      'id: 5\nevent: snapshot\ndata: {"id":"job-1","kind":"host","state":"ready","batch_id":"b","variants":[]}\n\n';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([wire])));

    const handle = subscribeToJob('job-1');
    await waitForTerminal('job-1');

    const entry = useJobCacheStore.getState().jobs['job-1']!;
    expect(entry.snapshot?.state).toBe('ready');
    expect(entry.lastSeq).toBe(5);
    handle.close();
  });

  it('handles a fatal frame (sets state=failed + error)', async () => {
    const wire =
      'id: 0\nevent: snapshot\ndata: {"id":"job-1","kind":"host","state":"streaming","variants":[]}\n\n' +
      'id: 1\nevent: fatal\ndata: {"error":"GPU OOM"}\n\n';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([wire])));

    const handle = subscribeToJob('job-1');
    await waitForTerminal('job-1');

    const entry = useJobCacheStore.getState().jobs['job-1']!;
    expect(entry.snapshot?.state).toBe('failed');
    expect(entry.snapshot?.error).toBe('GPU OOM');
    handle.close();
  });

  it('handles a cancelled frame (sets state=cancelled)', async () => {
    const wire =
      'id: 0\nevent: snapshot\ndata: {"id":"job-1","kind":"host","state":"streaming","variants":[]}\n\n' +
      'id: 1\nevent: cancelled\ndata: {}\n\n';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([wire])));

    const handle = subscribeToJob('job-1');
    await waitForTerminal('job-1');

    expect(useJobCacheStore.getState().jobs['job-1']?.snapshot?.state).toBe('cancelled');
    handle.close();
  });

  it('tolerates unknown event types without breaking the run', async () => {
    const wire =
      'id: 0\nevent: snapshot\ndata: {"id":"job-1","kind":"host","state":"streaming","variants":[]}\n\n' +
      'id: 1\nevent: progress\ndata: {"pct":50}\n\n' +
      'id: 2\nevent: done\ndata: {"batch_id":"b"}\n\n';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([wire])));

    const handle = subscribeToJob('job-1');
    await waitForTerminal('job-1');

    expect(useJobCacheStore.getState().jobs['job-1']?.snapshot?.state).toBe('ready');
    handle.close();
  });
});

// ────────────────────────────────────────────────────────────────────
// HTTP error branches
// ────────────────────────────────────────────────────────────────────

describe('_openConnection — HTTP error handling', () => {
  it('401 sets error and does not retry', async () => {
    const fetchMock = vi.fn().mockResolvedValue(errorResponse(401));
    vi.stubGlobal('fetch', fetchMock);

    const handle = subscribeToJob('job-1');
    await waitForTerminal('job-1');

    expect(useJobCacheStore.getState().jobs['job-1']?.error).toContain('401');
    expect(fetchMock).toHaveBeenCalledTimes(1); // no retry
    handle.close();
  });

  it('403 sets error and does not retry', async () => {
    const fetchMock = vi.fn().mockResolvedValue(errorResponse(403));
    vi.stubGlobal('fetch', fetchMock);
    const handle = subscribeToJob('job-1');
    await waitForTerminal('job-1');
    expect(useJobCacheStore.getState().jobs['job-1']?.error).toContain('403');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    handle.close();
  });

  it('404 sets error and does not retry', async () => {
    const fetchMock = vi.fn().mockResolvedValue(errorResponse(404));
    vi.stubGlobal('fetch', fetchMock);
    const handle = subscribeToJob('job-1');
    await waitForTerminal('job-1');
    expect(useJobCacheStore.getState().jobs['job-1']?.error).toContain('404');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    handle.close();
  });

  it('429 sets error and does not retry (per-user cap exceeded)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(errorResponse(429));
    vi.stubGlobal('fetch', fetchMock);
    const handle = subscribeToJob('job-1');
    await waitForTerminal('job-1');
    expect(useJobCacheStore.getState().jobs['job-1']?.error).toContain('429');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    handle.close();
  });
});

// ────────────────────────────────────────────────────────────────────
// Last-Event-ID resume
// ────────────────────────────────────────────────────────────────────

describe('_openConnection — Last-Event-ID resume', () => {
  it('omits Last-Event-ID on first connect (cache.lastSeq=0)', async () => {
    const wire =
      'id: 0\nevent: snapshot\ndata: {"id":"job-1","kind":"host","state":"ready","variants":[]}\n\n';
    const fetchMock = vi.fn().mockResolvedValue(sseResponse([wire]));
    vi.stubGlobal('fetch', fetchMock);

    const handle = subscribeToJob('job-1');
    await waitForTerminal('job-1');

    const initOpts = fetchMock.mock.calls[0]![1] as RequestInit;
    const headers = initOpts.headers as Record<string, string>;
    expect(headers['Last-Event-ID']).toBeUndefined();
    handle.close();
  });

  it('includes Last-Event-ID header when cache already has lastSeq>0', async () => {
    // Pre-seed the cache with a snapshot at seq=7 to simulate a reconnect
    // scenario (a prior connection stored data; we resubscribe).
    useJobCacheStore.getState().setSnapshot('job-1', {
      id: 'job-1',
      user_id: 'u1',
      kind: 'host',
      state: 'streaming',
      variants: [],
      prev_selected_image_id: null,
      batch_id: null,
      error: null,
      input_hash: null,
    }, 7);

    const wire =
      'id: 8\nevent: done\ndata: {"batch_id":"b"}\n\n';
    const fetchMock = vi.fn().mockResolvedValue(sseResponse([wire]));
    vi.stubGlobal('fetch', fetchMock);

    const handle = subscribeToJob('job-1');
    await waitForTerminal('job-1');

    const initOpts = fetchMock.mock.calls[0]![1] as RequestInit;
    const headers = initOpts.headers as Record<string, string>;
    expect(headers['Last-Event-ID']).toBe('7');
    handle.close();
  });
});

// ────────────────────────────────────────────────────────────────────
// URL + headers
// ────────────────────────────────────────────────────────────────────

describe('_openConnection — request shape', () => {
  it('encodes the jobId in the URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse([
      'id: 0\nevent: snapshot\ndata: {"id":"x","kind":"host","state":"ready","variants":[]}\n\n',
    ]));
    vi.stubGlobal('fetch', fetchMock);

    const handle = subscribeToJob('job/with/slashes');
    await waitForTerminal('job/with/slashes');

    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain('/api/jobs/job%2Fwith%2Fslashes/events');
    handle.close();
  });

  it('sends Accept: text/event-stream', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse([
      'id: 0\nevent: snapshot\ndata: {"id":"job-1","kind":"host","state":"ready","variants":[]}\n\n',
    ]));
    vi.stubGlobal('fetch', fetchMock);

    const handle = subscribeToJob('job-1');
    await waitForTerminal('job-1');

    const initOpts = fetchMock.mock.calls[0]![1] as RequestInit;
    const headers = initOpts.headers as Record<string, string>;
    expect(headers['Accept']).toBe('text/event-stream');
    handle.close();
  });
});

// ────────────────────────────────────────────────────────────────────
// Abort + cleanup
// ────────────────────────────────────────────────────────────────────

describe('_openConnection — abort + cleanup', () => {
  it('close() aborts the fetch (signal propagates)', async () => {
    let capturedSignal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(
      (_url: string, init: RequestInit) => {
        capturedSignal = init.signal as AbortSignal;
        // Never-resolving response — simulates a long-lived stream.
        return new Promise(() => { /* hang */ });
      },
    ));

    const handle = subscribeToJob('job-1');
    await yieldOnce(); // let fetch enter
    expect(capturedSignal?.aborted).toBe(false);
    handle.close();
    // The handle.close calls AbortController.abort() — the captured signal flips.
    expect(capturedSignal?.aborted).toBe(true);
    expect(_testActiveCount()).toBe(0);
  });

  it('terminal frame triggers cache reset on final close', async () => {
    const wire =
      'id: 0\nevent: snapshot\ndata: {"id":"job-1","kind":"host","state":"ready","variants":[]}\n\n';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([wire])));

    const handle = subscribeToJob('job-1');
    await waitForTerminal('job-1');
    // Cache holds the terminal snapshot.
    expect(useJobCacheStore.getState().jobs['job-1']).toBeTruthy();
    handle.close();
    // close() drops the cache entry on final-refcount.
    expect(useJobCacheStore.getState().jobs['job-1']).toBeUndefined();
  });
});
