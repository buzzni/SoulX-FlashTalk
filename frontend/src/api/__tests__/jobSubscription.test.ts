/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  _testActiveCount,
  _testReset,
  subscribeToJob,
} from '../jobSubscription';
import { useJobCacheStore } from '../../stores/jobCacheStore';

describe('jobSubscription', () => {
  beforeEach(() => {
    _testReset();
  });

  it('marks the cache entry as loading on subscribe', () => {
    const handle = subscribeToJob('job-1');
    const entry = useJobCacheStore.getState().jobs['job-1']!;
    expect(entry.isLoading).toBe(true);
    handle.close();
  });

  it('two subscribes to the same job share one connection', () => {
    const a = subscribeToJob('job-1');
    const b = subscribeToJob('job-1');
    expect(_testActiveCount()).toBe(1);
    a.close();
    // First close decrements but doesn't disconnect — b is still alive.
    expect(_testActiveCount()).toBe(1);
    b.close();
    // Last close drops the connection.
    expect(_testActiveCount()).toBe(0);
  });

  it('different jobs maintain independent connections', () => {
    const a = subscribeToJob('job-A');
    const b = subscribeToJob('job-B');
    expect(_testActiveCount()).toBe(2);
    a.close();
    expect(_testActiveCount()).toBe(1);
    b.close();
    expect(_testActiveCount()).toBe(0);
  });

  it('close is idempotent on a single handle', () => {
    const handle = subscribeToJob('job-1');
    handle.close();
    handle.close();  // second close is no-op
    expect(_testActiveCount()).toBe(0);
  });

  it('final close clears the cache entry', () => {
    const handle = subscribeToJob('job-1');
    expect(useJobCacheStore.getState().jobs['job-1']).toBeTruthy();
    handle.close();
    expect(useJobCacheStore.getState().jobs['job-1']).toBeUndefined();
  });

  it('non-final close keeps the cache entry alive', () => {
    const a = subscribeToJob('job-1');
    const b = subscribeToJob('job-1');
    a.close();
    expect(useJobCacheStore.getState().jobs['job-1']).toBeTruthy();
    b.close();
    expect(useJobCacheStore.getState().jobs['job-1']).toBeUndefined();
  });
});
