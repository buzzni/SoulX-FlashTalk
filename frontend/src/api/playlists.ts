/**
 * Playlists — CRUD + filter wrappers over /api/playlists and /api/results/:id/playlist.
 *
 * Per docs/playlist-feature-plan.md §4. All endpoints owner-scoped via the
 * existing auth middleware. Errors bubble up as `ApiError` with the backend's
 * 4xx status (caller decides whether to humanize).
 */

import { API_BASE, fetchJSON, getAuthHeaders, parseResponse } from './http';

export interface Playlist {
  playlist_id: string;
  name: string;
  video_count: number;
  created_at?: string;
  updated_at?: string;
}

export interface PlaylistListResponse {
  playlists: Playlist[];
  unassigned_count: number;
}

export interface CallOptions {
  signal?: AbortSignal;
}

export function listPlaylists({ signal }: CallOptions = {}): Promise<PlaylistListResponse> {
  return fetchJSON<PlaylistListResponse>('/api/playlists', {
    label: '플레이리스트 목록',
    signal,
  });
}

export async function createPlaylist(
  name: string,
  { signal }: CallOptions = {},
): Promise<Playlist> {
  const body = new FormData();
  body.append('name', name);
  const res = await fetch(`${API_BASE}/api/playlists`, {
    method: 'POST',
    body,
    headers: getAuthHeaders(),
    signal,
  });
  return parseResponse<Playlist>(res, '플레이리스트 만들기');
}

export async function renamePlaylist(
  playlistId: string,
  name: string,
  { signal }: CallOptions = {},
): Promise<Playlist> {
  const body = new FormData();
  body.append('name', name);
  const res = await fetch(`${API_BASE}/api/playlists/${playlistId}`, {
    method: 'PATCH',
    body,
    headers: getAuthHeaders(),
    signal,
  });
  return parseResponse<Playlist>(res, '플레이리스트 이름 변경');
}

export async function deletePlaylist(
  playlistId: string,
  { signal }: CallOptions = {},
): Promise<{ message: string; playlist_id: string }> {
  const res = await fetch(`${API_BASE}/api/playlists/${playlistId}`, {
    method: 'DELETE',
    headers: getAuthHeaders(),
    signal,
  });
  return parseResponse(res, '플레이리스트 삭제');
}

/**
 * Move a video to a playlist (or pass null to send it back to "미지정").
 * Empty string is also accepted by the backend as "unassign" — this wrapper
 * forwards null directly.
 */
export async function moveResultToPlaylist(
  taskId: string,
  playlistId: string | null,
  { signal }: CallOptions = {},
): Promise<{ task_id: string; playlist_id: string | null; message: string }> {
  const body = new FormData();
  body.append('playlist_id', playlistId ?? '');
  const res = await fetch(`${API_BASE}/api/results/${taskId}/playlist`, {
    method: 'PATCH',
    body,
    headers: getAuthHeaders(),
    signal,
  });
  return parseResponse(res, '플레이리스트 이동');
}
