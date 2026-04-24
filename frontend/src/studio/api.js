// api.js — legacy re-export shim for the domain-split API layer.
//
// Phase 1 moved the real implementations into /src/api/*.ts. This file
// preserves the single-entry import surface that existing components
// and tests were written against (e.g., `import { fetchQueue } from
// './api.js'`) so Phase 1 could ship without touching every callsite.
//
// Phase 4 component decomposition will migrate individual imports to
// their natural domain module (e.g., `from '../api/queue'`), after
// which this shim can be deleted. Don't add anything new here — put it
// in the appropriate domain module from day one.

export {
  API_BASE,
  ApiError,
  fetchJSON,
  humanizeError,
  jsonOrThrow,
  parseResponse,
  setAuthProvider,
} from '../api/http';

export {
  builderToPromptSuffix,
  makeRandomSeeds,
  negativeToSystemSuffix,
  paragraphsToScript,
  parseResolution,
  strengthToClause,
  stringifyResolution,
} from '../api/mapping';

export {
  MAX_UPLOAD_BYTES,
  assertSize,
  uploadAudio,
  uploadBackgroundImage,
  uploadHostImage,
  uploadReferenceAudio,
  uploadReferenceImage,
} from '../api/upload';

export {
  buildHostGenerateBody,
  generateHost,
  streamHost,
} from '../api/host';

export {
  buildCompositeBody,
  generateComposite,
  streamComposite,
} from '../api/composite';

export { cloneVoice, generateVoice, listVoices } from '../api/voice';
export { generateVideo } from '../api/video';
export { cancelQueuedTask, fetchQueue } from '../api/queue';
export { fetchHistory } from '../api/history';
export { fetchResult } from '../api/result';
export { getVideoMeta, listServerFiles } from '../api/file';
export { subscribeProgress } from '../api/progress';
