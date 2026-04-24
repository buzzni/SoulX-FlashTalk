/**
 * useAbortableRequest — the concurrency primitive every async hook
 * builds on. These tests pin the contract:
 *   - calling run() aborts any previous controller
 *   - unmount aborts the current controller
 *   - isCurrent() returns false for a stale snapshot
 *   - abort() cancels without starting a new epoch
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAbortableRequest } from '../useAbortableRequest';

describe('useAbortableRequest', () => {
  it('run() returns a signal + isCurrent that returns true before another run', () => {
    const { result } = renderHook(() => useAbortableRequest());
    let snapshot;
    act(() => {
      snapshot = result.current.run();
    });
    expect(snapshot.signal.aborted).toBe(false);
    expect(snapshot.isCurrent()).toBe(true);
  });

  it('a second run() aborts the first AND invalidates its isCurrent', () => {
    const { result } = renderHook(() => useAbortableRequest());
    let first, second;
    act(() => { first = result.current.run(); });
    act(() => { second = result.current.run(); });
    expect(first.signal.aborted).toBe(true);
    expect(first.isCurrent()).toBe(false);
    expect(second.signal.aborted).toBe(false);
    expect(second.isCurrent()).toBe(true);
  });

  it('abort() cancels without starting a new run AND invalidates isCurrent', () => {
    const { result } = renderHook(() => useAbortableRequest());
    let snap;
    act(() => { snap = result.current.run(); });
    act(() => { result.current.abort(); });
    expect(snap.signal.aborted).toBe(true);
    expect(snap.isCurrent()).toBe(false);
  });

  it('unmount aborts the in-flight controller', () => {
    const { result, unmount } = renderHook(() => useAbortableRequest());
    let snap;
    act(() => { snap = result.current.run(); });
    expect(snap.signal.aborted).toBe(false);
    unmount();
    expect(snap.signal.aborted).toBe(true);
  });

  it('isActive() reflects whether a controller is live', () => {
    const { result } = renderHook(() => useAbortableRequest());
    expect(result.current.isActive()).toBe(false);
    act(() => { result.current.run(); });
    expect(result.current.isActive()).toBe(true);
    act(() => { result.current.abort(); });
    expect(result.current.isActive()).toBe(false);
  });
});
