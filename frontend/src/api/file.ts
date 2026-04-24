/**
 * File-related helpers — server file picker + video metadata.
 *
 * `listServerFiles` exists for environments where browser file upload
 * is blocked (corporate DLP / VPN); the user `scp`s a file onto the
 * server once, then picks from this list in the UI.
 *
 * `getVideoMeta` is a HEAD request against the result video — used by
 * RenderDashboard's "파일 용량" display to show the *actual* Content-
 * Length rather than a rough resolution-based estimate.
 */

import { API_BASE, getAuthHeaders, fetchJSON } from './http';

export interface CallOptions {
  signal?: AbortSignal;
}

export type ServerFileKind = 'image' | 'audio';

export interface ServerFile {
  filename: string;
  path: string;
  url: string;
  size: number;
  modified: number;
}

export function listServerFiles(
  kind: ServerFileKind = 'image',
  { signal }: CallOptions = {},
): Promise<{ files: ServerFile[] }> {
  return fetchJSON<{ files: ServerFile[] }>(
    `/api/upload/list?kind=${encodeURIComponent(kind)}`,
    { label: '서버 파일 목록 조회', signal },
  );
}

export interface VideoMeta {
  sizeBytes?: number;
  contentType?: string;
}

/**
 * HEAD request for the rendered video. Returns just the headers we
 * care about (size + content-type); a missing Content-Length becomes
 * `sizeBytes: undefined`. Network errors are silently swallowed — the
 * UI falls back to an em-dash, and a permanently broken video will be
 * obvious when the user tries to play it.
 */
export async function getVideoMeta(
  taskId: string,
  { signal }: CallOptions = {},
): Promise<VideoMeta> {
  try {
    const res = await fetch(`${API_BASE}/api/videos/${encodeURIComponent(taskId)}`, {
      method: 'HEAD',
      headers: getAuthHeaders(),
      signal,
    });
    if (!res.ok) return {};
    const len = Number(res.headers.get('content-length') || 0);
    return {
      sizeBytes: len > 0 ? len : undefined,
      contentType: res.headers.get('content-type') || undefined,
    };
  } catch (err) {
    // Re-throw aborts so useEffect cleanup can distinguish "user left"
    // from "network broken" if it cares; callers typically catch and
    // ignore both. Check by `name` rather than `instanceof DOMException`
    // so it works under test mocks that don't subclass DOMException.
    if ((err as { name?: string })?.name === 'AbortError') throw err;
    return {};
  }
}
