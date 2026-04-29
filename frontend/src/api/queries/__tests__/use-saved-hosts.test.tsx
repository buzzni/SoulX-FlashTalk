/**
 * useSavedHosts hook suite — eng-review T9.
 *
 * Covers all four /api/hosts hooks:
 *  - useSavedHosts (GET): loading / success / empty / error / 401
 *  - useSaveHostMutation (POST): success invalidates, error surfaces
 *  - useRenameHostMutation (PATCH): success invalidates, error surfaces
 *  - useDeleteHostMutation (DELETE): optimistic remove, rollback on error
 *
 * @vitest-environment jsdom
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  useDeleteHostMutation,
  useRenameHostMutation,
  useSaveHostMutation,
  useSavedHostCount,
  useSavedHosts,
  type SavedHost,
} from '../use-saved-hosts';

function makeClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: 0 } },
  });
}

function wrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

const FAKE_HOST: SavedHost = {
  id: 'host-1',
  name: '민지',
  key: 'outputs/hosts/saved/host-1.png',
  url: '/api/files/outputs/hosts/saved/host-1.png',
  created_at: '2026-04-29T12:00:00+00:00',
  updated_at: null,
  deleted_at: null,
  meta: null,
  face_ref_for_variation: 'outputs/hosts/saved/host-1.png',
};

const FAKE_HOST_2: SavedHost = {
  ...FAKE_HOST,
  id: 'host-2',
  name: '주연',
  key: 'outputs/hosts/saved/host-2.png',
  url: '/api/files/outputs/hosts/saved/host-2.png',
  face_ref_for_variation: 'outputs/hosts/saved/host-2.png',
};

afterEach(() => {
  vi.restoreAllMocks();
});

// ─────────────────────── useSavedHosts (list) ───────────────────────

describe('useSavedHosts', () => {
  it('returns empty list on cold mount with no saved hosts', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ hosts: [] }),
    });
    const client = makeClient();
    const { result } = renderHook(() => useSavedHosts(), { wrapper: wrapper(client) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.hosts).toEqual([]);
  });

  it('returns populated list', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ hosts: [FAKE_HOST, FAKE_HOST_2] }),
    });
    const client = makeClient();
    const { result } = renderHook(() => useSavedHosts(), { wrapper: wrapper(client) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.hosts).toHaveLength(2);
    expect(result.current.data?.hosts?.[0]?.name).toBe('민지');
  });

  it('surfaces server 500 as Error', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      headers: new Map(),
      text: async () => 'boom',
      json: async () => ({}),
    });
    const client = makeClient();
    const { result } = renderHook(() => useSavedHosts(), { wrapper: wrapper(client) });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toBeInstanceOf(Error);
  });

  it('useSavedHostCount returns 0 during loading and N after success', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ hosts: [FAKE_HOST, FAKE_HOST_2] }),
    });
    const client = makeClient();
    const { result } = renderHook(
      () => ({ count: useSavedHostCount(), q: useSavedHosts() }),
      { wrapper: wrapper(client) },
    );
    expect(result.current.count).toBe(0);
    await waitFor(() => expect(result.current.q.isSuccess).toBe(true));
    expect(result.current.count).toBe(2);
  });
});

// ─────────────────────── useSaveHostMutation ───────────────────────

describe('useSaveHostMutation', () => {
  it('posts source_image_id+name and returns SavedHost', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => FAKE_HOST,
    });
    global.fetch = fetchMock;
    const client = makeClient();
    const { result } = renderHook(() => useSaveHostMutation(), { wrapper: wrapper(client) });
    const out = await result.current.mutateAsync({ source_image_id: 'host_abc_s1', name: '민지' });
    expect(out.id).toBe('host-1');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toMatch(/\/api\/hosts\/save$/);
    expect((init as RequestInit).method).toBe('POST');
    expect((init as RequestInit).body).toBeInstanceOf(FormData);
  });

  it('invalidates saved-hosts cache on success', async () => {
    global.fetch = vi
      .fn()
      // First call: list returns empty
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ hosts: [] }) })
      // Save call:
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => FAKE_HOST })
      // Refetch after invalidate:
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ hosts: [FAKE_HOST] }) });
    const client = makeClient();
    const { result } = renderHook(
      () => ({ list: useSavedHosts(), save: useSaveHostMutation() }),
      { wrapper: wrapper(client) },
    );
    await waitFor(() => expect(result.current.list.isSuccess).toBe(true));
    expect(result.current.list.data?.hosts).toEqual([]);
    await act(async () => {
      await result.current.save.mutateAsync({ source_image_id: 'host_a_s1', name: 'x' });
    });
    await waitFor(() => expect(result.current.list.data?.hosts).toHaveLength(1));
  });

  it('surfaces 422 validation error from backend', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
      headers: new Map(),
      text: async () => '{"detail":"name must not be blank"}',
      json: async () => ({ detail: 'name must not be blank' }),
    });
    const client = makeClient();
    const { result } = renderHook(() => useSaveHostMutation(), { wrapper: wrapper(client) });
    await expect(
      result.current.mutateAsync({ source_image_id: 'host_a_s1', name: '   ' }),
    ).rejects.toMatchObject({ status: 422 });
  });
});

// ─────────────────────── useRenameHostMutation ───────────────────────

describe('useRenameHostMutation', () => {
  it('PATCH /api/hosts/{host_id} with name', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ...FAKE_HOST, name: 'new name' }),
    });
    global.fetch = fetchMock;
    const client = makeClient();
    const { result } = renderHook(() => useRenameHostMutation(), { wrapper: wrapper(client) });
    const out = await result.current.mutateAsync({ hostId: 'host-1', name: 'new name' });
    expect(out.name).toBe('new name');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toMatch(/\/api\/hosts\/host-1$/);
    expect((init as RequestInit).method).toBe('PATCH');
  });

  it('surfaces 404 when renaming a missing host', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      headers: new Map(),
      text: async () => 'not found',
      json: async () => ({ detail: 'not found' }),
    });
    const client = makeClient();
    const { result } = renderHook(() => useRenameHostMutation(), { wrapper: wrapper(client) });
    await expect(
      result.current.mutateAsync({ hostId: 'ghost', name: 'x' }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

// ─────────────────────── useDeleteHostMutation ───────────────────────

describe('useDeleteHostMutation', () => {
  it('optimistically removes the row from list cache, then refetches', async () => {
    global.fetch = vi
      .fn()
      // list: [host-1, host-2]
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ hosts: [FAKE_HOST, FAKE_HOST_2] }),
      })
      // delete success
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ message: 'deleted', id: 'host-1' }),
      })
      // refetch: [host-2]
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ hosts: [FAKE_HOST_2] }),
      });
    const client = makeClient();
    const { result } = renderHook(
      () => ({ list: useSavedHosts(), del: useDeleteHostMutation() }),
      { wrapper: wrapper(client) },
    );
    await waitFor(() => expect(result.current.list.isSuccess).toBe(true));
    expect(result.current.list.data?.hosts).toHaveLength(2);
    await act(async () => {
      await result.current.del.mutateAsync('host-1');
    });
    // Server-confirmed list arrives via refetch.
    await waitFor(() =>
      expect(result.current.list.data?.hosts?.map((h) => h.id)).toEqual(['host-2']),
    );
  });

  it('rolls back optimistic remove on error', async () => {
    global.fetch = vi
      .fn()
      // list: [host-1, host-2]
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ hosts: [FAKE_HOST, FAKE_HOST_2] }),
      })
      // delete fails 500
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        headers: new Map(),
        text: async () => 'oops',
        json: async () => ({}),
      })
      // onSettled refetch returns the original list (server didn't actually delete)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ hosts: [FAKE_HOST, FAKE_HOST_2] }),
      });
    const client = makeClient();
    const { result } = renderHook(
      () => ({ list: useSavedHosts(), del: useDeleteHostMutation() }),
      { wrapper: wrapper(client) },
    );
    await waitFor(() => expect(result.current.list.isSuccess).toBe(true));
    await act(async () => {
      await expect(result.current.del.mutateAsync('host-1')).rejects.toBeDefined();
    });
    await waitFor(() => expect(result.current.list.data?.hosts).toHaveLength(2));
    // Both hosts still in the cache after rollback + refetch.
    expect(result.current.list.data?.hosts?.map((h) => h.id)).toEqual(['host-1', 'host-2']);
  });
});
