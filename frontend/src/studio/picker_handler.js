// Pure-function reducers for ServerFilePicker selections.
// Extracted from Step2Composite so the picker→state branches are unit-testable
// without mounting the full component tree.

/**
 * Apply a server-file pick to the products array.
 * f: { filename, path, url, size, modified }
 * Returns the next products array.
 *
 * Schema-typed (Phase 2c) — emits a Product with source.kind === 'uploaded'.
 *
 * Rule: replace any row whose source.kind is 'empty' or 'localFile' (the
 * picker is meant to back-fill rows that don't yet have a server path).
 * Otherwise append.
 */
export function applyPickedFileToProducts(products, f) {
  const nextRow = {
    id: Date.now().toString(36),
    name: f.filename,
    source: {
      kind: 'uploaded',
      asset: { path: f.path, url: f.url, name: f.filename },
    },
  };
  const ps = products || [];
  const replaceIdx = ps.findIndex(
    (p) => p.source && (p.source.kind === 'empty' || p.source.kind === 'localFile'),
  );
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
