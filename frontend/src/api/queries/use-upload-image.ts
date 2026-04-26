/**
 * useUploadImage — TanStack Query mutation for image uploads.
 *
 * Lane E (D5): backend uploads are idempotent (each POST creates a
 * fresh asset, the server-side filename is content-hash-derived) so
 * we opt in to a single retry on transient 5xx. Default `retry: 0`
 * from the query client config protects generation POSTs from
 * accidental duplicate-job creation; this is the explicit override.
 *
 * The hook returns the standard TQ mutation surface; consumers call
 * `.mutate(file)` or `.mutateAsync(file)` and read `.isPending`,
 * `.error`, `.data` for state. zod parses the response shape so a
 * backend rename surfaces as ApiError (status 0) at the call site.
 */

import { useMutation, type UseMutationResult } from '@tanstack/react-query';
import { z } from 'zod';
import {
  ApiError,
  API_BASE,
  getAuthHeaders,
  runSchema,
  parseResponse,
} from '../http';
import { MAX_UPLOAD_BYTES } from '../upload';

export const UploadResultSchema = z
  .object({
    filename: z.string().optional(),
    path: z.string().optional(),
    url: z.string().optional(),
  })
  .passthrough();
export type UploadResult = z.infer<typeof UploadResultSchema>;

export type UploadKind = 'host' | 'background' | 'reference' | 'audio' | 'reference-audio';

const KIND_PATH: Record<UploadKind, string> = {
  host: '/api/upload/host-image',
  background: '/api/upload/background-image',
  reference: '/api/upload/reference-image',
  audio: '/api/upload/audio',
  'reference-audio': '/api/upload/reference-audio',
};

const KIND_LABEL: Record<UploadKind, string> = {
  host: '호스트 이미지 업로드',
  background: '배경 이미지 업로드',
  reference: '참조 이미지 업로드',
  audio: '오디오 업로드',
  'reference-audio': '참조 오디오 업로드',
};

function assertSize(file: unknown): asserts file is Blob {
  if (!file || typeof file !== 'object' || !(file instanceof Blob)) {
    throw new ApiError('파일이 사라졌어요. 페이지를 새로고침한 뒤 다시 업로드해주세요.', {
      status: 400,
    });
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new ApiError('파일이 너무 커요 (최대 20MB)', { status: 413 });
  }
}

async function uploadOne(kind: UploadKind, file: Blob, signal?: AbortSignal): Promise<UploadResult> {
  assertSize(file);
  const fd = new FormData();
  fd.append('file', file);
  const res = await fetch(`${API_BASE}${KIND_PATH[kind]}`, {
    method: 'POST',
    body: fd,
    headers: getAuthHeaders(),
    signal,
  });
  const raw = await parseResponse<unknown>(res, KIND_LABEL[kind]);
  return runSchema(UploadResultSchema, raw, KIND_LABEL[kind]);
}

export function useUploadImage(
  kind: UploadKind,
): UseMutationResult<UploadResult, Error, Blob, unknown> {
  return useMutation({
    mutationKey: ['upload', kind],
    mutationFn: (file: Blob) => uploadOne(kind, file),
    // D5: idempotent — backend creates a fresh asset per POST. One
    // retry on transient 5xx; non-idempotent generation mutations
    // keep the global default of retry: 0.
    retry: 1,
    retryDelay: 1000,
  });
}
