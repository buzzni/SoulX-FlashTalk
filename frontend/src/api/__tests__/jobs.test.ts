/**
 * @vitest-environment jsdom
 *
 * HTTP client tests for /api/jobs/* — createJob, getJob, deleteJob,
 * listJobs. Verifies URL/header/body shape and parseResponse error path
 * (which wires the 401/403 → /login redirect, the bug /simplify caught
 * when the original code reimplemented apiError without that hookup).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createJob,
  deleteJob,
  getJob,
  listJobs,
} from '../jobs';

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('createJob', () => {
  it('POSTs to /api/jobs with JSON body and Content-Type', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      id: 'job-1', state: 'pending',
    }));
    vi.stubGlobal('fetch', fetchMock);

    const body = {
      kind: 'host' as const,
      input: { mode: 'v1', prompt: 'x', n: 4, seeds: [1, 2, 3, 4] },
    };
    await createJob(body);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toContain('/api/jobs');
    expect((init as RequestInit).method).toBe('POST');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual(body);
  });

  it('returns the parsed JobSnapshot on 200', async () => {
    const snap = { id: 'job-1', state: 'pending', kind: 'host' };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(snap)));
    const out = await createJob({
      kind: 'host', input: { mode: 'v1' },
    });
    expect(out).toMatchObject(snap);
  });

  it('throws ApiError on non-2xx with backend detail', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      detail: 'input too large',
    }, 413)));
    await expect(createJob({
      kind: 'host', input: { mode: 'v1' },
    })).rejects.toMatchObject({ status: 413, detail: 'input too large' });
  });
});

describe('getJob', () => {
  it('GETs /api/jobs/:id with URL-encoded jobId', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      id: 'a/b', state: 'ready',
    }));
    vi.stubGlobal('fetch', fetchMock);

    await getJob('a/b');
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain('/api/jobs/a%2Fb');
  });

  it('throws ApiError on 404', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      detail: 'not found',
    }, 404)));
    await expect(getJob('missing')).rejects.toMatchObject({ status: 404 });
  });
});

describe('deleteJob', () => {
  it('DELETEs and returns the cancelled snapshot', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      id: 'job-1', state: 'cancelled',
    }));
    vi.stubGlobal('fetch', fetchMock);

    const out = await deleteJob('job-1');
    expect((fetchMock.mock.calls[0]![1] as RequestInit).method).toBe('DELETE');
    expect(out.state).toBe('cancelled');
  });

  it('throws ApiError 409 on already-terminal', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      detail: 'job already ready',
    }, 409)));
    await expect(deleteJob('job-1')).rejects.toMatchObject({ status: 409 });
  });
});

describe('listJobs', () => {
  it('omits query string when no options passed', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      items: [], next_cursor: null,
    }));
    vi.stubGlobal('fetch', fetchMock);
    await listJobs();
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toMatch(/\/api\/jobs$/);
  });

  it('builds query string from kind/state/limit/cursor options', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      items: [], next_cursor: 'abc',
    }));
    vi.stubGlobal('fetch', fetchMock);
    await listJobs({ kind: 'host', state: 'streaming', limit: 10, cursor: 'c1' });
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain('kind=host');
    expect(url).toContain('state=streaming');
    expect(url).toContain('limit=10');
    expect(url).toContain('cursor=c1');
  });

  it('returns the typed list response shape', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      items: [{ id: 'job-1' }, { id: 'job-2' }],
      next_cursor: 'job-2',
    })));
    const out = await listJobs();
    expect(out.items).toHaveLength(2);
    expect(out.next_cursor).toBe('job-2');
  });
});
