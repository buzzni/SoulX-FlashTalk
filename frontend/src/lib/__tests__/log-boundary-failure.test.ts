/**
 * Lane G — logBoundaryFailure unit tests.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  logBoundaryFailure,
  scrubAuthTokens,
} from '../log-boundary-failure';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('scrubAuthTokens', () => {
  it('strips Bearer tokens from messages', () => {
    expect(scrubAuthTokens('failed: Bearer abc.def-ghi/123=='))
      .toBe('failed: <scrubbed>');
  });

  it('strips JWT-shaped strings from stacks', () => {
    expect(
      scrubAuthTokens(
        'TypeError: at fetchJSON (eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.signed-tail)',
      ),
    ).toMatch(/<scrubbed>/);
  });

  it('strips long hex strings (e.g. session ids)', () => {
    expect(scrubAuthTokens('cookie: deadbeef00000000deadbeef11111111deadbeef'))
      .toContain('<scrubbed>');
  });

  it('passes plain text through unchanged', () => {
    expect(scrubAuthTokens('보통 에러 메세지 — backend rejected')).toBe(
      '보통 에러 메세지 — backend rejected',
    );
  });
});

describe('logBoundaryFailure', () => {
  it('returns a structured record with scrubbed fields', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = new Error('oops Bearer abc-def');
    err.stack = 'TypeError oops Bearer abc-def\n  at runtime';
    const rec = logBoundaryFailure('parse', err, {
      lane: 'B',
      step: 1,
      userAction: 'submit',
    });
    expect(rec.boundary).toBe('parse');
    expect(rec.context).toMatchObject({ lane: 'B', step: 1, userAction: 'submit' });
    expect(rec.error.message).toBe('oops <scrubbed>');
    expect(rec.error.stack).not.toContain('Bearer');
    expect(warn).toHaveBeenCalled();
  });

  it('handles non-Error throwables', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rec = logBoundaryFailure('mutation', 'just a string Bearer xyz');
    expect(rec.error.name).toBe('UnknownError');
    expect(rec.error.message).toBe('just a string <scrubbed>');
    expect(warn).toHaveBeenCalled();
  });
});
