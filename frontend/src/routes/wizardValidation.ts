/**
 * Wizard validation — which steps have their prerequisites satisfied.
 *
 * Three independent bits:
 *   v[1] — step 1 produced a host image (generated OR selected)
 *   v[2] — v[1] AND a composite variant was picked
 *   v[3] — v[2] AND voice + script + resolution are all set
 *
 * A step N is *reachable* when `v[N-1]` is true (or N === 1, which is
 * always reachable). A step N is *satisfied* when `v[N]` is true.
 *
 * `deepestReachableStep(v)` returns the highest step the user can
 * legitimately land on given current state — used by route guards to
 * redirect deep-links that would otherwise show empty/broken UIs.
 */

import { isVoiceReady } from '../wizard/schema';
import type { Voice } from '../wizard/schema';

export interface WizardValidity {
  1: boolean;
  2: boolean;
  3: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function computeValidity(state: any): WizardValidity {
  const v: WizardValidity = { 1: false, 2: false, 3: false };
  // v9 (streaming-resume Phase B): host.generation collapsed to
  // {idle | attached(jobId)}. The "ready + selected" predicate that
  // gated step progression in v8 now lives behind the jobCacheStore
  // snapshot (step 14) and a yet-to-be-introduced 'selected' field
  // tracked separately on the host slice. Until step 17 wires those,
  // validation is intentionally false so route guards keep users on
  // step 1 — better than letting them advance past stale data.
  v[1] = false;
  v[2] = false;
  // Voice/resolution don't depend on generation state — keep their
  // checks honest so step 3 can still verify its own prerequisites
  // once steps 1 and 2 are unlocked.
  const voice = state?.voice as Voice | undefined;
  v[3] =
    v[2] &&
    !!voice &&
    isVoiceReady(voice) &&
    typeof state?.resolution === 'string';
  return v;
}

export function deepestReachableStep(v: WizardValidity): 1 | 2 | 3 {
  if (v[2]) return 3;
  if (v[1]) return 2;
  return 1;
}

export function isAllValid(v: WizardValidity): boolean {
  return v[1] && v[2] && v[3];
}
