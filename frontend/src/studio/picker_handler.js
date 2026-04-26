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

// `applyPickedFileToBackground` removed in Phase 2a — schema-typed
// Background is constructed inline by Step2Composite via a single
// `{ kind: 'upload', asset: { path, url, name } }` literal.
