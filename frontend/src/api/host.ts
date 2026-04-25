/**
 * Step 1 — host generation.
 *
 * Two entry points:
 *  - `generateHost` — synchronous batch (used when streaming isn't needed).
 *  - `streamHost` — async generator, yields one event per completed
 *    candidate. Enables "하나씩 페이드인" UX during inference.
 *
 * Both support cancellation via `{signal}`; callers should bubble
 * `AbortError` as "the user moved on" (silent).
 */

import { API_BASE, ApiError, getAuthHeaders, parseResponse } from './http';
import { builderToPromptSuffix, negativeToSystemSuffix, strengthToClause } from './mapping';

export interface HostGenerateInput {
  mode?: 'text' | 'face-outfit' | 'style-ref';
  prompt?: string;
  builder?: Record<string, string> | null;
  extraPrompt?: string;
  negativePrompt?: string;
  faceRef?: unknown;
  outfitRef?: unknown;
  faceRefPath?: string | null;
  outfitRefPath?: string | null;
  styleRefPath?: string | null;
  faceStrength?: number | null;
  outfitStrength?: number | null;
  outfitText?: string;
  /** Override the backend's fixed default seed set — used by "다시 만들기". */
  _seeds?: number[];
  imageSize?: '1K' | '2K' | '4K';
  temperature?: number;
}

/**
 * Build the FormData body for /api/host/generate from UI host state.
 * Mirrors the mapping tables in `modules/host_generator.py` so the
 * payload matches the backend's expectations exactly.
 */
export function buildHostGenerateBody(host: HostGenerateInput): FormData {
  const mode = host.mode === 'text'
    ? 'text'
    : host.faceRef && host.outfitRef
      ? 'face-outfit'
      : host.faceRef
        ? 'style-ref'
        : 'text';

  const promptSuffix = host.mode === 'text' ? builderToPromptSuffix(host.builder) : '';

  // §5.1.2 + §5.1.1 — strength + negative prompt collapse into extraPrompt
  // until backend exposes a first-class system_instruction override.
  const extraBits: string[] = [];
  if (host.faceRef && typeof host.faceStrength === 'number') {
    extraBits.push(strengthToClause(host.faceStrength, 'face'));
  }
  if (host.outfitRef && typeof host.outfitStrength === 'number') {
    extraBits.push(strengthToClause(host.outfitStrength, 'outfit'));
  }
  const negSuffix = negativeToSystemSuffix(host.negativePrompt).trim();
  if (negSuffix) extraBits.push(negSuffix);
  const extraPrompt = [host.extraPrompt, ...extraBits].filter(Boolean).join(' ').trim();

  const body = new FormData();
  body.append('mode', mode);
  if (host.prompt) body.append('prompt', (host.prompt || '') + promptSuffix);
  if (extraPrompt) body.append('extraPrompt', extraPrompt);
  if (host.negativePrompt) body.append('negativePrompt', host.negativePrompt);
  if (host.builder && Object.keys(host.builder).length) {
    body.append('builder', JSON.stringify(host.builder));
  }
  if (host.faceRefPath) body.append('faceRefPath', host.faceRefPath);
  if (host.outfitRefPath) body.append('outfitRefPath', host.outfitRefPath);
  if (host.styleRefPath) body.append('styleRefPath', host.styleRefPath);
  if (typeof host.faceStrength === 'number') body.append('faceStrength', String(host.faceStrength));
  if (typeof host.outfitStrength === 'number') body.append('outfitStrength', String(host.outfitStrength));
  if (host.outfitText && host.outfitText.trim()) {
    body.append('outfitText', host.outfitText.trim());
  }
  if (Array.isArray(host._seeds) && host._seeds.length > 0) {
    body.append('seeds', JSON.stringify(host._seeds));
  }
  if (host.imageSize) body.append('imageSize', host.imageSize);
  body.append('n', '4');
  if (typeof host.temperature === 'number') body.append('temperature', String(host.temperature));

  return body;
}

export interface CallOptions {
  signal?: AbortSignal;
}

export async function generateHost(
  host: HostGenerateInput,
  { signal }: CallOptions = {},
): Promise<unknown> {
  const body = buildHostGenerateBody(host);
  const res = await fetch(`${API_BASE}/api/host/generate`, {
    method: 'POST',
    body,
    headers: getAuthHeaders(),
    signal,
  });
  return parseResponse(res, '호스트 생성');
}

/**
 * Mark a Step1 candidate as the user's current selection. Server uses
 * this to schedule cleanup at the next generate / video-render event.
 * Fire-and-forget from the UI's perspective — local state already
 * reflects the click; this only syncs the backend's lifecycle slot.
 */
export async function selectHost(
  imageId: string,
  { signal }: CallOptions = {},
): Promise<unknown> {
  const body = new FormData();
  body.append('image_id', imageId);
  const res = await fetch(`${API_BASE}/api/host/select`, {
    method: 'POST',
    body,
    headers: getAuthHeaders(),
    signal,
  });
  return parseResponse(res, '호스트 선택');
}

// Stream events — untyped union (backend emits several flavors that
// change quickly during development). Consumers typically narrow by
// `.type` at the callsite.
export type StreamEvent = { type: string; [key: string]: unknown };

/**
 * Async generator — yields parsed SSE events from POST /api/host/generate/stream.
 *
 * EventSource only supports GET, hence the fetch + manual SSE frame
 * parser. The loop terminates when:
 *  - the reader reports `done` (backend closed the stream), OR
 *  - `signal` is aborted (caller cancelled) — the fetch rejects with
 *    AbortError which we rethrow so `for await` exits cleanly.
 */
export async function* streamHost(
  host: HostGenerateInput,
  { signal }: CallOptions = {},
): AsyncGenerator<StreamEvent, void, void> {
  const body = buildHostGenerateBody(host);
  const res = await fetch(`${API_BASE}/api/host/generate/stream`, {
    method: 'POST',
    body,
    headers: getAuthHeaders(),
    signal,
  });
  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.json())?.detail ?? '';
    } catch {
      /* ignore — detail stays empty */
    }
    throw new ApiError(`호스트 생성 시작 실패 (${res.status})`, { status: res.status, detail });
  }
  yield* parseSSEStream(res, signal);
}

// Shared SSE frame parser — also used by `streamComposite`.
export async function* parseSSEStream(
  res: Response,
  signal?: AbortSignal,
): AsyncGenerator<StreamEvent, void, void> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      if (signal?.aborted) break;
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        for (const line of frame.split('\n')) {
          if (line.startsWith('data: ')) {
            try {
              yield JSON.parse(line.slice(6)) as StreamEvent;
            } catch {
              /* malformed frame — skip */
            }
          }
        }
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* reader already closed — ignore */
    }
  }
}
