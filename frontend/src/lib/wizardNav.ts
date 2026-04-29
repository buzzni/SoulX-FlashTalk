/**
 * wizardNav — entry-point helpers that disambiguate "start fresh" from
 * "resume in-progress" wizard state.
 *
 * Every "+ 새 영상 만들기" CTA in the app calls `startNewVideo`, which
 * resets the store first then navigates. "↻ 이어 만들기" CTAs call
 * `resumeVideo`, which jumps to the deepest step the persisted state
 * has earned. Without this split, navigating to /step/1 silently
 * rehydrates whatever was last persisted — confusing when the user
 * meant to start over.
 */

import { useEffect, useState } from 'react';
import type { NavigateFunction } from 'react-router-dom';
import { useWizardStore } from '../stores/wizardStore';
import { storageKey } from '../stores/storageKey';
import { computeValidity, deepestReachableStep } from '../routes/wizardValidation';

export function startNewVideo(navigate: NavigateFunction): void {
  useWizardStore.getState().reset();
  navigate('/step/1');
}

export function resumeVideo(navigate: NavigateFunction): void {
  const step = deepestReachableStep(computeValidity(useWizardStore.getState()));
  navigate(`/step/${step}`);
}

export function discardDraft(): void {
  useWizardStore.getState().reset();
}

// ────────────────────────────────────────────────────────────────────
// Dispatch ownership tracking — sessionStorage flag set when this
// session POSTs /api/generate. Read on render-completion to decide
// whether to auto-reset the wizard.
//
// Why session-scoped: the same user could dispatch task A, navigate
// home, build a fresh draft for task B, then click the queue popover
// to attach to task A's render. If task A finishes while their wizard
// holds B's in-progress data, an unconditional reset would destroy
// real work. The flag scopes auto-reset to "I personally dispatched
// this task this session".
// ────────────────────────────────────────────────────────────────────

// These resolve through storageKey() at *call time*, not module init,
// because userScope changes after module load (login/logout). If we
// captured them as module constants the keys would freeze on the
// pre-login (global) scope and never re-bind for the logged-in user.
const dispatchedKey = () => storageKey('justDispatched');
// Stores {taskId, signature, at} so /render-dispatch can detect a
// duplicate POST (same wizard intent + still-live task) on refresh /
// fast double-click / back-and-click. Lives in lockstep with
// dispatchedKey() so clearDraftIfDispatched stays a one-liner.
const dispatchSnapshotKey = () => storageKey('dispatchSnapshot');

export interface DispatchSnapshot {
  taskId: string;
  signature: string;
  at: number;
}

export function markDispatched(
  taskId: string,
  options?: { signature?: string },
): void {
  try {
    sessionStorage.setItem(dispatchedKey(), taskId);
    if (options?.signature) {
      const snap: DispatchSnapshot = {
        taskId,
        signature: options.signature,
        at: Date.now(),
      };
      sessionStorage.setItem(dispatchSnapshotKey(), JSON.stringify(snap));
    }
  } catch {
    /* sessionStorage unavailable — auto-reset just won't trigger */
  }
}

export function getDispatchSnapshot(): DispatchSnapshot | null {
  try {
    const raw = sessionStorage.getItem(dispatchSnapshotKey());
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.taskId !== 'string' || typeof obj.signature !== 'string') return null;
    return {
      taskId: obj.taskId,
      signature: obj.signature,
      at: typeof obj.at === 'number' ? obj.at : 0,
    };
  } catch {
    return null;
  }
}

export function clearDispatchSnapshot(): void {
  try {
    sessionStorage.removeItem(dispatchSnapshotKey());
  } catch {
    /* sessionStorage unavailable */
  }
}

// In-flight lock — bridges the gap between POST start and POST response.
// Without it, a refresh between "click 영상생성" and the task_id landing
// would see snapshot=null and fire a *second* /api/generate (the original
// snapshot-based gate only protects after task_id is known). 60s TTL so
// a crashed dispatch doesn't lock the next session permanently.
const dispatchInflightKey = () => storageKey('dispatchInflight');
const INFLIGHT_TTL_MS = 60_000;

export interface DispatchInflight {
  signature: string;
  at: number;
}

export function setDispatchInflight(signature: string): void {
  try {
    const lock: DispatchInflight = { signature, at: Date.now() };
    sessionStorage.setItem(dispatchInflightKey(), JSON.stringify(lock));
  } catch {
    /* sessionStorage unavailable */
  }
}

export function getDispatchInflight(): DispatchInflight | null {
  try {
    const raw = sessionStorage.getItem(dispatchInflightKey());
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.signature !== 'string' || typeof obj.at !== 'number') return null;
    if (Date.now() - obj.at > INFLIGHT_TTL_MS) {
      sessionStorage.removeItem(dispatchInflightKey());
      return null;
    }
    return { signature: obj.signature, at: obj.at };
  } catch {
    return null;
  }
}

export function clearDispatchInflight(): void {
  try {
    sessionStorage.removeItem(dispatchInflightKey());
  } catch {
    /* sessionStorage unavailable */
  }
}

/** If the just-completed task was dispatched by this session, reset
 * the wizard and clear the flag. No-op otherwise. Call from BOTH the
 * SSE-done path and the snapshot-shows-completed path so background
 * tabs and re-attach flows both clean up correctly. */
export function clearDraftIfDispatched(completedTaskId: string): void {
  try {
    if (sessionStorage.getItem(dispatchedKey()) === completedTaskId) {
      useWizardStore.getState().reset();
      sessionStorage.removeItem(dispatchedKey());
      sessionStorage.removeItem(dispatchSnapshotKey());
    }
  } catch {
    /* sessionStorage unavailable */
  }
}

/** Forces a re-render every 60s so callers of `formatDraftAge` don't
 * freeze on "23분 전" while the user keeps the tab open. Pass `false`
 * when there's no draft to display — otherwise the sidebar (mounted
 * on every page) wakes up once a minute for nothing. */
export function useDraftAgeTick(enabled: boolean): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => clearInterval(id);
  }, [enabled]);
  return tick;
}

/** Korean relative-time formatter for draft age. Granularity tuned for
 * "is this still my work?" intuition — minute resolution within an
 * hour, hourly within a day, daily after that. */
export function formatDraftAge(savedAt: number, now: number = Date.now()): string {
  const diffMs = Math.max(0, now - savedAt);
  const min = Math.floor(diffMs / 60_000);
  if (min < 1) return '방금 전';
  if (min < 60) return `${min}분 전`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}시간 전`;
  const day = Math.floor(hr / 24);
  if (day === 1) return '어제';
  if (day < 7) return `${day}일 전`;
  const week = Math.floor(day / 7);
  if (week < 5) return `${week}주 전`;
  const month = Math.floor(day / 30);
  if (month < 12) return `${month}개월 전`;
  return `${Math.floor(day / 365)}년 전`;
}
