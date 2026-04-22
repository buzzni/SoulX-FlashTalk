// Pure-function reducers for ServerFilePicker selections.
// Extracted from Step2Composite so the picker→state branches are unit-testable
// without mounting the full component tree.

/**
 * Apply a server-file pick to the products array.
 * f: { filename, path, url, size, modified }
 * Returns the next products array.
 *
 * Rule: replace any row that lacks a server `path` (a stub from "제품 추가",
 * or a row whose browser upload failed leaving _file but no path). Otherwise
 * append. This guarantees a picker selection always produces a row with a
 * valid `path` and never re-triggers a failing upload from a stale row.
 */
export function applyPickedFileToProducts(products, f) {
  const nextRow = {
    id: Date.now().toString(36),
    url: f.url,
    name: f.filename,
    source: 'upload',
    path: f.path,
    _file: null,
  };
  const ps = products || [];
  const replaceIdx = ps.findIndex(p => !p.path);
  if (replaceIdx >= 0) {
    const next = ps.slice();
    next[replaceIdx] = nextRow;
    return next;
  }
  if (ps.length === 0) return [nextRow];
  return [...ps, nextRow];
}

/**
 * Apply a server-file pick to the background object.
 * Returns the next background object.
 *
 * Sets imageUrl + uploadPath + serverFilename so generateComposite's
 * `if (background.uploadPath)` check skips the upload step. Clears any
 * conflicting source data (preset id, prompt text, raw URL, in-memory File).
 */
export function applyPickedFileToBackground(background, f) {
  return {
    ...(background || {}),
    _file: null,
    imageUrl: f.url,
    uploadPath: f.path,
    preset: null,
    prompt: '',
    url: '',
    serverFilename: f.filename,
  };
}
