/**
 * picker_handler.js — pure reducers for ServerFilePicker selections.
 *
 * Phase 2c: Product rows are schema-typed. `source` is a tagged union
 * (empty | localFile | uploaded | url); the picker writes 'uploaded'
 * rows. The "replace empty/local row" rule still holds — picker fills
 * back-empty rows so a server-pick never duplicates the placeholder.
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
// keep.

describe('applyPickedFileToProducts (schema-shaped)', () => {
  it('appends an uploaded row when products list is empty', () => {
    const next = applyPickedFileToProducts([], sampleFile);
    expect(next).toHaveLength(1);
    expect(next[0].source.kind).toBe('uploaded');
    expect(next[0].source.asset.path).toBe(sampleFile.path);
    expect(next[0].source.asset.url).toBe(sampleFile.url);
    expect(next[0].source.asset.name).toBe(sampleFile.filename);
    expect(next[0].name).toBe(sampleFile.filename);
  });

  it('replaces an empty stub row instead of appending', () => {
    const stub = { id: 'stub', source: { kind: 'empty' } };
    const next = applyPickedFileToProducts([stub], sampleFile);
    expect(next).toHaveLength(1);
    expect(next[0].id).not.toBe('stub');
    expect(next[0].source.kind).toBe('uploaded');
    expect(next[0].source.asset.path).toBe(sampleFile.path);
  });

  it('replaces a localFile (pre-upload) row', () => {
    // Real flow: user picked a file, upload pending; before upload
    // completes they hit "서버 파일 선택" instead. The picker swaps the
    // local row out for the chosen server asset.
    const local = {
      id: 'local',
      source: {
        kind: 'localFile',
        asset: {
          file: new File(['x'], 'orphan.png'),
          previewUrl: 'data:image/png;base64,x',
          name: 'orphan.png',
        },
      },
    };
    const next = applyPickedFileToProducts([local], sampleFile);
    expect(next).toHaveLength(1);
    expect(next[0].source.kind).toBe('uploaded');
    expect(next[0].source.asset.path).toBe(sampleFile.path);
  });

  it('appends when every existing row is already uploaded', () => {
    const existing = [
      { id: 'a', source: { kind: 'uploaded', asset: { path: '/uploads/a.png' } } },
      { id: 'b', source: { kind: 'uploaded', asset: { path: '/uploads/b.png' } } },
    ];
    const next = applyPickedFileToProducts(existing, sampleFile);
    expect(next).toHaveLength(3);
    expect(next[0].id).toBe('a');
    expect(next[1].id).toBe('b');
    expect(next[2].source.kind).toBe('uploaded');
    expect(next[2].source.asset.path).toBe(sampleFile.path);
  });
});
