/**
 * useSavedHosts — TanStack Query hooks for the "나의 쇼호스트" library.
 *
 * Backs the four /api/hosts surfaces:
 *  - GET    /api/hosts              → useSavedHosts (list)
 *  - POST   /api/hosts/save         → useSaveHostMutation (PR1 step 1 button)
 *  - PATCH  /api/hosts/{host_id}    → useRenameHostMutation (PR2 library page)
 *  - DELETE /api/hosts/{host_id}    → useDeleteHostMutation (PR2 library page)
 *
 * Cache invalidation contract (eng-review decision #11):
 *
 *   queryKey ['saved-hosts', 'list']  ← single source for sidebar count
 *                                       AND library grid AND step 1 picker
 *   queryKey ['saved-hosts', host_id] ← reserved for future detail page
 *
 *   On save / rename / delete success → invalidate ['saved-hosts'] (the
 *   tuple prefix invalidates both the list and any per-host queries in
 *   one call). The list refetch supplies fresh URLs; we do NOT optimistic-
 *   update the list because URL signing happens server-side and the
 *   client can't fabricate a presigned URL.
 *
 * delete uses an optimistic remove from the list cache so the grid
 * snaps immediately, with rollback on error. save/rename keep things
 * simple (no optimism) — the user is already waiting on the modal.
 *
 * The rename + delete hooks ship in PR1 (used by PR2). Co-locating all
 * four mutations means the worktree split between PR2 (library page)
 * and PR3 (step 1 mode) doesn't fight over this file.
 */

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { z } from 'zod';
import {
  ApiError,
  API_BASE,
  fetchJSON,
  getAuthHeaders,
  parseResponse,
  runSchema,
} from '../http';
import { schemas } from '../schemas-generated';

// ────────────────────────────────────────────────────────────────────
// Types — re-export from generated zod schemas so the TS shape stays
// in lockstep with backend Pydantic without a hand-typed mirror.
// ────────────────────────────────────────────────────────────────────

export type SavedHost = z.infer<typeof schemas.SavedHost>;
export type SavedHostMeta = z.infer<typeof schemas.SavedHostMeta>;
export type SavedHostsListResponse = z.infer<typeof schemas.SavedHostsListResponse>;

const HOSTS_LIST_KEY = ['saved-hosts', 'list'] as const;
const HOSTS_KEY_PREFIX = ['saved-hosts'] as const;

export const savedHostsQueryKeys = {
  list: () => HOSTS_LIST_KEY,
  detail: (hostId: string) => ['saved-hosts', hostId] as const,
  all: () => HOSTS_KEY_PREFIX,
} as const;

// ────────────────────────────────────────────────────────────────────
// Generic ack body for delete (backend returns {message, id})
// ────────────────────────────────────────────────────────────────────

const DeleteAckSchema = z
  .object({ message: z.string().optional(), id: z.string() })
  .passthrough();

// ────────────────────────────────────────────────────────────────────
// GET /api/hosts
// ────────────────────────────────────────────────────────────────────

export function useSavedHosts(): UseQueryResult<SavedHostsListResponse, Error> {
  return useQuery({
    queryKey: HOSTS_LIST_KEY,
    queryFn: ({ signal }) =>
      fetchJSON('/api/hosts', {
        label: '저장된 호스트 조회',
        signal,
        cache: 'no-store',
        schema: schemas.SavedHostsListResponse,
      }) as Promise<SavedHostsListResponse>,
    // List is small and cheap — refresh on focus catches a save from
    // another tab so the count stays honest. staleTime=0 keeps it
    // simple; if list size ever grows we can bump this.
    staleTime: 0,
    refetchOnWindowFocus: true,
  });
}

/** Convenience selector — most callers (sidebar badge, step 1 N gate) just want the count. */
export function useSavedHostCount(): number {
  const q = useSavedHosts();
  return q.data?.hosts?.length ?? 0;
}

// ────────────────────────────────────────────────────────────────────
// POST /api/hosts/save
// ────────────────────────────────────────────────────────────────────

export interface SaveHostInput {
  source_image_id: string;
  name: string;
}

async function postSaveHost(input: SaveHostInput, signal?: AbortSignal): Promise<SavedHost> {
  const fd = new FormData();
  fd.append('source_image_id', input.source_image_id);
  fd.append('name', input.name);
  const res = await fetch(`${API_BASE}/api/hosts/save`, {
    method: 'POST',
    body: fd,
    headers: getAuthHeaders(),
    signal,
  });
  const raw = await parseResponse<unknown>(res, '호스트 저장');
  return runSchema(schemas.SavedHost, raw, '호스트 저장');
}

export function useSaveHostMutation(): UseMutationResult<SavedHost, Error, SaveHostInput, unknown> {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: ['saved-hosts', 'save'],
    mutationFn: (input: SaveHostInput) => postSaveHost(input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: HOSTS_KEY_PREFIX });
    },
    // Save is non-idempotent (each POST creates a new uuid host_id);
    // keep the global retry: 0 default to avoid double-saves on a flaky
    // 5xx.
  });
}

// ────────────────────────────────────────────────────────────────────
// PATCH /api/hosts/{host_id}  (PR2 use-site, hook ships in PR1)
// ────────────────────────────────────────────────────────────────────

export interface RenameHostInput {
  hostId: string;
  name: string;
}

async function patchRenameHost(
  input: RenameHostInput,
  signal?: AbortSignal,
): Promise<SavedHost> {
  const fd = new FormData();
  fd.append('name', input.name);
  const res = await fetch(`${API_BASE}/api/hosts/${encodeURIComponent(input.hostId)}`, {
    method: 'PATCH',
    body: fd,
    headers: getAuthHeaders(),
    signal,
  });
  const raw = await parseResponse<unknown>(res, '호스트 이름 변경');
  return runSchema(schemas.SavedHost, raw, '호스트 이름 변경');
}

export function useRenameHostMutation(): UseMutationResult<SavedHost, Error, RenameHostInput, unknown> {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: ['saved-hosts', 'rename'],
    mutationFn: (input: RenameHostInput) => patchRenameHost(input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: HOSTS_KEY_PREFIX });
    },
  });
}

// ────────────────────────────────────────────────────────────────────
// DELETE /api/hosts/{host_id}  — optimistic remove from list cache
// ────────────────────────────────────────────────────────────────────

interface DeleteContext {
  previous?: SavedHostsListResponse;
}

async function deleteHost(hostId: string, signal?: AbortSignal): Promise<{ id: string }> {
  const res = await fetch(`${API_BASE}/api/hosts/${encodeURIComponent(hostId)}`, {
    method: 'DELETE',
    headers: getAuthHeaders(),
    signal,
  });
  const raw = await parseResponse<unknown>(res, '호스트 삭제');
  const parsed = runSchema(DeleteAckSchema, raw, '호스트 삭제');
  return { id: parsed.id };
}

export function useDeleteHostMutation(): UseMutationResult<
  { id: string },
  Error,
  string,
  DeleteContext
> {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: ['saved-hosts', 'delete'],
    mutationFn: (hostId: string) => deleteHost(hostId),
    onMutate: async (hostId) => {
      // Snapshot + optimistic remove. If the user has a slow connection
      // and clicks delete, the grid snaps immediately; rollback on
      // error preserves the original list.
      await qc.cancelQueries({ queryKey: HOSTS_LIST_KEY });
      const previous = qc.getQueryData<SavedHostsListResponse>(HOSTS_LIST_KEY);
      if (previous?.hosts) {
        qc.setQueryData<SavedHostsListResponse>(HOSTS_LIST_KEY, {
          ...previous,
          hosts: previous.hosts.filter((h) => h.id !== hostId),
        });
      }
      return { previous };
    },
    onError: (_err, _hostId, ctx) => {
      if (ctx?.previous) qc.setQueryData(HOSTS_LIST_KEY, ctx.previous);
    },
    onSettled: () => {
      // Refetch on both success and error so the cache reconciles with
      // the server (handles the soft-delete-already-deleted-404 case).
      void qc.invalidateQueries({ queryKey: HOSTS_KEY_PREFIX });
    },
  });
}

// Re-export the ApiError class for callers that want to discriminate
// on .status (e.g. show a different message for 404 vs 422).
export { ApiError };
