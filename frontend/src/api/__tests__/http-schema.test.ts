/**
 * Lane B unit tests for the schema-required `fetchJSON` flow.
 *
 * `runSchema` is the inner helper exposed for tests; the whole-flow
 * tests mock global fetch and assert that:
 *   - valid JSON passes through cleanly
 *   - schema mismatches surface as ApiError with status 0 and structured
 *     detail (so callers can distinguish "shape wrong" from "5xx")
 *   - 4xx still throws ApiError with the real status (no schema check
 *     reached)
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { z } from 'zod';
import { ApiError, fetchJSON, runSchema } from '../http';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('runSchema', () => {
  const schema = z.object({ id: z.string(), n: z.number() });

  it('returns parsed payload on success', () => {
    expect(runSchema(schema, { id: 'x', n: 1 }, 'test')).toEqual({ id: 'x', n: 1 });
  });

  it('throws ApiError with status 0 on schema mismatch', () => {
    let err: unknown;
    try {
      runSchema(schema, { id: 'x' }, '테스트');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(0);
    expect((err as ApiError).message).toContain('테스트 응답 형식 오류');
    expect((err as ApiError).detail).toContain('n:');
  });
});

describe('fetchJSON({ schema })', () => {
  it('returns z.infer<schema> on 2xx with matching body', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ id: 'x', n: 7 }),
    });
    const out = await fetchJSON('/api/x', {
      label: 't',
      schema: z.object({ id: z.string(), n: z.number() }),
    });
    expect(out).toEqual({ id: 'x', n: 7 });
  });

  it('rejects with ApiError(status=0) when backend body fails the schema', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ id: 'x' }),
    });
    await expect(
      fetchJSON('/api/x', {
        label: '테스트',
        schema: z.object({ id: z.string(), n: z.number() }),
      }),
    ).rejects.toMatchObject({ name: 'ApiError', status: 0 });
  });

  it('preserves the real status on 4xx (schema check is skipped)', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 422,
      url: 'http://example.test/api/x',
      json: async () => ({ detail: 'nope' }),
    });
    await expect(
      fetchJSON('/api/x', {
        label: '테스트',
        schema: z.object({ id: z.string() }),
      }),
    ).rejects.toMatchObject({ name: 'ApiError', status: 422 });
  });
});
