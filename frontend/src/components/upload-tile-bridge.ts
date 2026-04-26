/**
 * Bridge between `<UploadTile>`'s legacy `{name, size, _file, url}` shape
 * and the schema's `LocalAsset` / `ServerAsset` types.
 *
 * UploadTile predates the wizard schema by several phases and emits a
 * loose-typed object with a `_file` File ref + a data: or blob: URL.
 * Every Step that mounts UploadTile needs the same lift-to-schema +
 * lower-from-schema. Live here once instead of duplicating per step.
 */

import { isLocalAsset, isServerAsset } from '@/wizard/normalizers';
import type { LocalAsset, ServerAsset } from '@/wizard/schema';

/** The shape `UploadTile` calls back with. */
export interface UploadTileFile {
  name?: string;
  size?: number;
  type?: string;
  url?: string | null;
  _file?: File;
}

/** Lift the UploadTile callback shape into a schema `LocalAsset`.
 * Returns null when the callback didn't include a `File` (e.g.,
 * `_fake: true` placeholders or a remove event). */
export function localAssetFromUploadFile(next: UploadTileFile | null): LocalAsset | null {
  if (!next || !next._file) return null;
  // Prefer the data: URL UploadTile already produced via FileReader —
  // it survives storage, doesn't need revoking, and renders on
  // network-IP origins where blob: would be blocked. Fall back to
  // createObjectURL only when the reader failed (UploadTile passes
  // url: null in that case). Caller is responsible for revoking blob
  // URLs they create — see `revokeLocalAssetIfBlob` below.
  const previewUrl =
    typeof next.url === 'string' && next.url
      ? next.url
      : URL.createObjectURL(next._file);
  return {
    file: next._file,
    previewUrl,
    name: next.name ?? next._file.name,
  };
}

/** Lower a schema asset back into the UploadTile shape so the tile
 * renders the "has-file" state correctly. ServerAsset → label-only;
 * LocalAsset → preview + ref. Null/empty → null. */
export function uploadFileFromAsset(
  asset: ServerAsset | LocalAsset | null | undefined,
): UploadTileFile | null {
  if (!asset) return null;
  if (isLocalAsset(asset)) {
    return {
      name: asset.name,
      size: asset.file.size,
      type: asset.file.type,
      url: asset.previewUrl,
      _file: asset.file,
    };
  }
  if (isServerAsset(asset)) {
    return { name: asset.name, url: asset.url };
  }
  return null;
}

/** Revoke a blob: URL on a LocalAsset. Safe no-op for data: URLs and
 * non-LocalAssets. Call when replacing a previewUrl or unmounting. */
export function revokeLocalAssetIfBlob(asset: LocalAsset | null | undefined): void {
  if (!asset) return;
  const url = asset.previewUrl;
  if (typeof url === 'string' && url.startsWith('blob:')) {
    try {
      URL.revokeObjectURL(url);
    } catch {
      // Browsers tolerate revoke on already-revoked URLs but throw on
      // some non-blob inputs depending on engine — quiet fallback.
    }
  }
}
