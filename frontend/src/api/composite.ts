/**
 * Step 2 — product + background composition.
 *
 * Mirrors `host.ts` structure: sync `generateComposite` + streaming
 * `streamComposite`, both driven off `buildCompositeBody`. Stream uses
 * the shared SSE parser from `host.ts`.
 */

import { API_BASE, ApiError, getAuthHeaders, parseResponse } from './http';
import { parseSSEStream, type CallOptions, type StreamEvent } from './host';

export interface CompositeInput {
  host: { selectedPath?: string | null };
  products?: Array<{ path?: string | null }>;
  background: {
    source?: 'preset' | 'prompt' | 'upload' | 'url' | null;
    preset?: { id?: string; label?: string } | string | null;
    prompt?: string;
    uploadPath?: string | null;
    /** External image URL (url-mode). Wire-level handling lives in
     * buildCompositeBody — currently only preset/upload/prompt are
     * encoded; url-mode awaits backend support. */
    url?: string;
  };
  composition?: {
    direction?: string;
    shot?: string;
    angle?: string;
    temperature?: number;
    _seeds?: number[];
    imageSize?: '1K' | '2K' | '4K';
  };
}

export interface CompositeCallOptions extends CallOptions {
  /** Backend runs rembg pre-pass by default; pass `false` to skip. */
  rembg?: boolean;
}

export function buildCompositeBody({ host, products, background, composition }: CompositeInput): FormData {
  const body = new FormData();
  if (!host?.selectedPath) throw new Error('1단계에서 선택한 쇼호스트가 필요해요');
  body.append('hostImagePath', host.selectedPath);

  const productPaths = (products || [])
    .map((p) => p.key)
    .filter((p): p is string => Boolean(p));
  body.append('productImagePaths', JSON.stringify(productPaths));

  const bgType = background?.source || 'prompt';
  body.append('backgroundType', bgType);
  if (bgType === 'preset') {
    if (!background.preset) throw new Error('배경 프리셋을 선택해주세요');
    const presetId =
      typeof background.preset === 'string' ? background.preset : background.preset?.id;
    if (!presetId) throw new Error('배경 프리셋을 선택해주세요');
    body.append('backgroundPresetId', presetId);
    if (typeof background.preset === 'object' && background.preset?.label) {
      body.append('backgroundPresetLabel', background.preset.label);
    }
  } else if (bgType === 'upload') {
    if (!background.uploadPath) throw new Error('배경 이미지 업로드가 필요해요');
    body.append('backgroundUploadPath', background.uploadPath);
  } else if (bgType === 'prompt') {
    if (!background.prompt?.trim()) throw new Error('배경 설명을 입력해주세요');
    body.append('backgroundPrompt', background.prompt.trim());
  }

  body.append('direction', composition?.direction || '');
  body.append('shot', composition?.shot || 'bust');
  body.append('angle', composition?.angle || 'eye');
  body.append('n', '4');
  if (typeof composition?.temperature === 'number') {
    body.append('temperature', String(composition.temperature));
  }
  if (Array.isArray(composition?._seeds) && composition._seeds.length > 0) {
    body.append('seeds', JSON.stringify(composition._seeds));
  }
  if (composition?.imageSize) body.append('imageSize', composition.imageSize);
  return body;
}

export async function generateComposite(
  input: CompositeInput,
  { signal, rembg = true }: CompositeCallOptions = {},
): Promise<unknown> {
  const body = buildCompositeBody(input);
  const url = `${API_BASE}/api/composite/generate${rembg ? '' : '?rembg=false'}`;
  const res = await fetch(url, {
    method: 'POST',
    body,
    headers: getAuthHeaders(),
    signal,
  });
  return parseResponse(res, '합성 이미지 생성');
}

/**
 * Mark a Step2 candidate as the user's current selection. See
 * `selectHost` for rationale — this only syncs the backend's
 * lifecycle slot; the local store already reflects the click.
 */
export async function selectComposite(
  imageId: string,
  { signal }: CallOptions = {},
): Promise<unknown> {
  const body = new FormData();
  body.append('image_id', imageId);
  const res = await fetch(`${API_BASE}/api/composite/select`, {
    method: 'POST',
    body,
    headers: getAuthHeaders(),
    signal,
  });
  return parseResponse(res, '합성 선택');
}

export async function* streamComposite(
  input: CompositeInput,
  { signal, rembg = true }: CompositeCallOptions = {},
): AsyncGenerator<StreamEvent, void, void> {
  const body = buildCompositeBody(input);
  const url = `${API_BASE}/api/composite/generate/stream${rembg ? '' : '?rembg=false'}`;
  const res = await fetch(url, {
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
    throw new ApiError(`합성 생성 시작 실패 (${res.status})`, { status: res.status, detail });
  }
  yield* parseSSEStream(res, signal);
}
