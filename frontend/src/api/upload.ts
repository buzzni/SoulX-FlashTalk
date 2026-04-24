/**
 * File-upload helpers — `File` → server path.
 *
 * All uploads use the same multipart pattern against `/api/upload/*`.
 * Per-endpoint wrappers (`uploadHostImage`, `uploadReferenceImage`, …)
 * differ only in the target path and the Korean label for error copy.
 */

import { ApiError, API_BASE, getAuthHeaders, parseResponse } from './http';

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

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

export interface UploadResult {
  // Backend endpoints return varied shapes — always include filename + path.
  filename?: string;
  path?: string;
  url?: string;
  [key: string]: unknown;
}

export interface UploadOptions {
  signal?: AbortSignal;
}

async function uploadMultipart(
  file: Blob,
  path: string,
  label: string,
  { signal }: UploadOptions = {},
): Promise<UploadResult> {
  assertSize(file);
  const fd = new FormData();
  fd.append('file', file);
  // FormData owns Content-Type (multipart boundary); we only add auth.
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    body: fd,
    headers: getAuthHeaders(),
    signal,
  });
  return parseResponse<UploadResult>(res, label);
}

// Thin domain wrappers — labels tell the user which step failed.

export function uploadHostImage(file: Blob, opts?: UploadOptions): Promise<UploadResult> {
  return uploadMultipart(file, '/api/upload/host-image', '호스트 이미지 업로드', opts);
}

export function uploadBackgroundImage(file: Blob, opts?: UploadOptions): Promise<UploadResult> {
  return uploadMultipart(file, '/api/upload/background-image', '배경 이미지 업로드', opts);
}

export function uploadReferenceImage(file: Blob, opts?: UploadOptions): Promise<UploadResult> {
  return uploadMultipart(file, '/api/upload/reference-image', '참조 이미지 업로드', opts);
}

export function uploadAudio(file: Blob, opts?: UploadOptions): Promise<UploadResult> {
  return uploadMultipart(file, '/api/upload/audio', '오디오 업로드', opts);
}

export function uploadReferenceAudio(file: Blob, opts?: UploadOptions): Promise<UploadResult> {
  return uploadMultipart(file, '/api/upload/reference-audio', '참조 오디오 업로드', opts);
}

// Export assertSize for callers that want to pre-validate before
// enqueuing uploads (e.g. Step 1's drag-and-drop handler).
export { assertSize };
