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
  // Step 1 is satisfied iff a candidate has been picked
  // (generation.state === 'ready' && selected !== null).
  v[1] =
    state?.host?.generation?.state === 'ready' &&
    state?.host?.generation?.selected != null;
  // Step 2 done iff a composite has been picked.
  v[2] =
    v[1] &&
    state?.composition?.generation?.state === 'ready' &&
    state?.composition?.generation?.selected != null;
  // `isVoiceReady` covers all three source modes — tts/clone need a
  // generated audio + voice_id; upload needs a server-side audio asset.
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
