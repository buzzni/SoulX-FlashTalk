/**
 * Lane B unit tests for `src/api/sse-schemas.ts`.
 *
 * Verifies wire-shape (snake_case) → client-shape (camelCase) transform
 * for every event branch (init / candidate / error / fatal / done) and
 * exercises `parseHostStreamEvent`'s soft-fail behavior on malformed
 * inputs.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';
import { HostStreamEventSchema, parseHostStreamEvent } from '../sse-schemas';

describe('HostStreamEventSchema — wire → client transform', () => {
  it('init: maps snake_case batch_id and prev_selected to camelCase', () => {
    const out = HostStreamEventSchema.parse({
      type: 'init',
      seeds: [1, 2, 3],
      batch_id: 'b-001',
      prev_selected: {
        image_id: 'img-1',
        url: '/u/img-1.png',
        path: '/p/img-1.png',
        seed: 7,
      },
    });
    expect(out).toEqual({
      type: 'init',
      seeds: [1, 2, 3],
      batchId: 'b-001',
      prevSelected: {
        imageId: 'img-1',
        url: '/u/img-1.png',
        path: '/p/img-1.png',
        seed: 7,
      },
    });
  });

  it('init: nullifies missing optional batch_id / prev_selected', () => {
    const out = HostStreamEventSchema.parse({ type: 'init', seeds: [42] });
    expect(out).toMatchObject({
      type: 'init',
      seeds: [42],
      batchId: null,
      prevSelected: null,
    });
  });

  it('candidate: derives imageId from path', () => {
    const out = HostStreamEventSchema.parse({
      type: 'candidate',
      seed: 99,
      path: '/output/host_a1b2.png',
      url: '/u/host_a1b2.png',
      batch_id: 'b-002',
    });
    expect(out).toEqual({
      type: 'candidate',
      seed: 99,
      path: '/output/host_a1b2.png',
      url: '/u/host_a1b2.png',
      batchId: 'b-002',
      imageId: 'host_a1b2',
    });
  });

  it('error: keeps wire fields verbatim (no rename)', () => {
    const out = HostStreamEventSchema.parse({
      type: 'error',
      seed: 7,
      error: 'GPU OOM',
    });
    expect(out).toEqual({ type: 'error', seed: 7, error: 'GPU OOM' });
  });

  it('fatal: optional status defaults to null', () => {
    const out = HostStreamEventSchema.parse({ type: 'fatal', error: 'boom' });
    expect(out).toEqual({ type: 'fatal', error: 'boom', status: null });
  });

  it('done: maps min_success_met to minSuccessMet', () => {
    const out = HostStreamEventSchema.parse({
      type: 'done',
      total: 4,
      min_success_met: false,
      batch_id: 'b-003',
    });
    expect(out).toMatchObject({
      type: 'done',
      total: 4,
      minSuccessMet: false,
      batchId: 'b-003',
      prevSelected: null,
    });
  });

  it('rejects unknown discriminator', () => {
    expect(() =>
      HostStreamEventSchema.parse({ type: 'wat', seed: 1 }),
    ).toThrow();
  });
});

describe('parseHostStreamEvent — soft-fail wrapper', () => {
  it('returns parsed event on success', () => {
    const out = parseHostStreamEvent({
      type: 'candidate',
      seed: 1,
      path: '/p/x.png',
      url: '/u/x.png',
    });
    expect(out.type).toBe('candidate');
  });

  it('returns synthetic fatal on parse failure (no throw)', () => {
    const out = parseHostStreamEvent({ type: 'init', seeds: 'not-an-array' });
    expect(out.type).toBe('fatal');
    if (out.type === 'fatal') {
      expect(out.error).toMatch(/이벤트 파싱 실패/);
      expect(out.status).toBe(null);
    }
  });

  it('returns synthetic fatal when type field is missing', () => {
    const out = parseHostStreamEvent({ foo: 1 });
    expect(out.type).toBe('fatal');
  });
});
