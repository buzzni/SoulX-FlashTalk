/**
 * picker_handler.js — pure reducers for ServerFilePicker selections.
 */
import { describe, it, expect } from 'vitest';
import { applyPickedFileToProducts } from '../picker_handler.js';

const sampleFile = {
  filename: 'place1.png',
  path: '/uploads/place1.png',
  url: '/api/files/place1.png',
  size: 12345,
  modified: 1700000000,
};

// `applyPickedFileToBackground` was deleted in Phase 2a — schema-typed
// Background is constructed inline in Step2Composite from a single
// AssetRef, so a multi-field merge reducer no longer earns its
// keep. The product-list reducer still exists because product rows
// remain a legacy shape until Phase 2c.

describe('applyPickedFileToProducts', () => {
  it('appends single row when products list is empty', () => {
    const next = applyPickedFileToProducts([], sampleFile);
    expect(next).toHaveLength(1);
    expect(next[0].path).toBe(sampleFile.path);
    expect(next[0].url).toBe(sampleFile.url);
    expect(next[0].name).toBe(sampleFile.filename);
    expect(next[0].source).toBe('upload');
    expect(next[0]._file).toBeNull();
  });

  it('replaces a stub row (no path/_file) instead of appending', () => {
    const stub = { id: 'stub', source: 'upload' };
    const next = applyPickedFileToProducts([stub], sampleFile);
    expect(next).toHaveLength(1);
    expect(next[0].id).not.toBe('stub');
    expect(next[0].path).toBe(sampleFile.path);
  });

  it('replaces a failed-upload row (_file but no path)', () => {
    const failed = { id: 'failed', source: 'upload', _file: { name: 'orphan' } };
    const next = applyPickedFileToProducts([failed], sampleFile);
    expect(next).toHaveLength(1);
    expect(next[0].path).toBe(sampleFile.path);
    expect(next[0]._file).toBeNull();
  });

  it('appends when every existing row already has a path', () => {
    const existing = [
      { id: 'a', path: '/uploads/a.png', source: 'upload' },
      { id: 'b', path: '/uploads/b.png', source: 'upload' },
    ];
    const next = applyPickedFileToProducts(existing, sampleFile);
    expect(next).toHaveLength(3);
    expect(next[0].id).toBe('a');
    expect(next[1].id).toBe('b');
    expect(next[2].path).toBe(sampleFile.path);
  });
});
