// HostStudio backend adapter — single responsibility: translate UI state
// into backend requests and back. See specs/hoststudio-migration/plan.md §5.
//
// Rules:
// - Shapes match the plan §5 tables verbatim; if UI state changes, the mapping
//   helpers here absorb the change so the backend contract stays stable.
// - Every fetch returns parsed JSON or throws a user-friendly Error.
// - No retries, no toast plumbing — callers (Step components) own UX state.

const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8001';

// ============================================================
// Mapping helpers — pure functions, heavily covered by unit tests.
// ============================================================

// §5.1 host.builder ko→en suffix for text prompt
const BUILDER_KO_EN = {
  성별: { female: 'female', male: 'male' },
  연령대: { '20s': 'in her/his 20s', '30s': 'in her/his 30s', '40s': 'in her/his 40s', '50plus': 'age 50+' },
  분위기: {
    bright: 'bright and energetic',
    calm: 'calm and trustworthy',
    friendly: 'friendly and approachable',
    pro: 'professional and refined',
  },
  옷차림: {
    formal: 'formal attire',
    casual: 'casual outfit',
    chic: 'chic modern style',
    cozy: 'cozy homewear',
  },
};

export function builderToPromptSuffix(builder) {
  if (!builder) return '';
  const parts = [];
  for (const key of ['성별', '연령대', '분위기', '옷차림']) {
    const v = builder[key];
    if (!v) continue;
    const mapped = BUILDER_KO_EN[key]?.[v];
    if (mapped) parts.push(mapped);
  }
  return parts.length ? ', ' + parts.join(', ') : '';
}

// §5.1.1 negativePrompt → system_instruction suffix, no translation
export function negativeToSystemSuffix(negativePrompt) {
  const trimmed = (negativePrompt || '').trim();
  if (!trimmed) return '';
  return `\n\nAvoid the following in the output: ${trimmed}`;
}

// §5.1.2 strength threshold table
export function strengthToClause(strength, kind /* 'face' | 'outfit' */) {
  if (strength == null) return '';
  const noun = kind === 'outfit' ? 'outfit' : 'face';
  // Ranges per spec: [0, 0.3), [0.3, 0.6), [0.6, 0.85), [0.85, 1.0]
  if (strength < 0.3) {
    return `Take only loose inspiration from the reference ${noun}; prioritize the text description.`;
  }
  if (strength < 0.6) {
    return `Use the reference ${noun} as a general style guide.`;
  }
  if (strength < 0.85) {
    return `Preserve the key features of the reference ${noun} closely.`;
  }
  return `Match the reference ${noun} as exactly as possible.`;
}

// §5.3 resolution mapping — backend wants "HxW" per convention, but internal
// convention is messy. Always pass the portrait-encoded "height x width" string.
export function stringifyResolution({ width, height }) {
  if (!width || !height) throw new Error('resolution requires width and height');
  return `${height}x${width}`;
}

export function parseResolution(str) {
  const m = /^(\d+)\s*x\s*(\d+)$/.exec(str || '');
  if (!m) throw new Error(`Cannot parse resolution: ${str}`);
  const h = parseInt(m[1], 10);
  const w = parseInt(m[2], 10);
  return { width: w, height: h };
}

// §5.3 + §5.4 — paragraphs → script_text with [breath] separators for v3
export function paragraphsToScript(paragraphs, { source = 'tts', maxChars = 5000 } = {}) {
  if (!Array.isArray(paragraphs)) throw new Error('paragraphs must be an array');
  const cleaned = paragraphs.map(p => (p ?? '').toString().trim()).filter(Boolean);
  const script = source === 'upload' ? cleaned.join('\n\n') : cleaned.join(' [breath] ');
  if (script.length > maxChars) {
    throw new Error(`대본이 너무 길어요 (${script.length}자 / 최대 ${maxChars}자)`);
  }
  return script;
}

// ============================================================
// HTTP helpers
// ============================================================

async function jsonOrThrow(res, label) {
  if (res.ok) return res.json();
  let detail = '';
  try {
    const body = await res.json();
    detail = body.detail || JSON.stringify(body);
  } catch {
    try { detail = await res.text(); } catch { /* ignore */ }
  }
  const err = new Error(`${label} 실패 (${res.status}): ${detail}`);
  err.status = res.status;
  err.detail = detail;
  throw err;
}

// §6.5 error-copy mapping (applied by callers when they see these codes).
export function humanizeError(err) {
  if (!err) return '알 수 없는 오류가 발생했어요';
  if (err.status === 429) return '지금은 많이 붐벼요. 잠시 후 다시 시도해주세요.';
  if (err.status === 401) return '서비스 연결이 잘못됐어요. 관리자에게 문의해주세요.';
  if (err.status === 413) return '파일이 너무 커요 (최대 20MB).';
  if (err.status === 503) return '생성 결과가 부족해요. 다시 시도해주세요.';
  if (err.name === 'TypeError' || /fetch/i.test(err.message)) return '네트워크 연결을 확인해주세요.';
  return err.message || '오류가 발생했어요';
}

// ============================================================
// Upload choreography — File → server path
// ============================================================

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

function assertSize(file) {
  if (file && file.size > MAX_UPLOAD_BYTES) {
    const err = new Error('파일이 너무 커요 (최대 20MB)');
    err.status = 413;
    throw err;
  }
}

export async function uploadHostImage(file) {
  assertSize(file);
  const fd = new FormData();
  fd.append('file', file);
  const res = await fetch(`${API_BASE}/api/upload/host-image`, { method: 'POST', body: fd });
  return jsonOrThrow(res, '호스트 이미지 업로드');
}

export async function uploadBackgroundImage(file) {
  assertSize(file);
  const fd = new FormData();
  fd.append('file', file);
  const res = await fetch(`${API_BASE}/api/upload/background-image`, { method: 'POST', body: fd });
  return jsonOrThrow(res, '배경 이미지 업로드');
}

export async function uploadReferenceImage(file) {
  assertSize(file);
  const fd = new FormData();
  fd.append('file', file);
  const res = await fetch(`${API_BASE}/api/upload/reference-image`, { method: 'POST', body: fd });
  return jsonOrThrow(res, '참조 이미지 업로드');
}

export async function uploadAudio(file) {
  assertSize(file);
  const fd = new FormData();
  fd.append('file', file);
  const res = await fetch(`${API_BASE}/api/upload/audio`, { method: 'POST', body: fd });
  return jsonOrThrow(res, '오디오 업로드');
}

export async function uploadReferenceAudio(file) {
  assertSize(file);
  const fd = new FormData();
  fd.append('file', file);
  const res = await fetch(`${API_BASE}/api/upload/reference-audio`, { method: 'POST', body: fd });
  return jsonOrThrow(res, '참조 오디오 업로드');
}

// ============================================================
// Step 1 — POST /api/host/generate
// ============================================================

/**
 * Build the FormData body for /api/host/generate from UI host state.
 * Returns { body, systemSuffix } — the Step component passes both;
 * the systemSuffix is currently folded into extraPrompt since the
 * backend doesn't accept a separate system_instruction override yet.
 */
export function buildHostGenerateBody(host) {
  const mode = host.mode === 'text' ? 'text'
    : host.faceRef && host.outfitRef ? 'face-outfit'
    : host.faceRef ? 'style-ref'
    : 'text';

  const promptSuffix = host.mode === 'text' ? builderToPromptSuffix(host.builder) : '';

  // Per §5.1.2 + §5.1.1 — strength + negative prompt collapse into extraPrompt
  // until backend exposes a first-class system_instruction override.
  const extraBits = [];
  if (host.faceRef && typeof host.faceStrength === 'number') {
    extraBits.push(strengthToClause(host.faceStrength, 'face'));
  }
  if (host.outfitRef && typeof host.outfitStrength === 'number') {
    extraBits.push(strengthToClause(host.outfitStrength, 'outfit'));
  }
  const negSuffix = negativeToSystemSuffix(host.negativePrompt).trim();
  if (negSuffix) extraBits.push(negSuffix);
  const extraPrompt = [host.extraPrompt, ...extraBits].filter(Boolean).join(' ').trim();

  const body = new FormData();
  body.append('mode', mode);
  if (host.prompt) body.append('prompt', (host.prompt || '') + promptSuffix);
  if (extraPrompt) body.append('extraPrompt', extraPrompt);
  if (host.negativePrompt) body.append('negativePrompt', host.negativePrompt);
  if (host.builder && Object.keys(host.builder).length) {
    body.append('builder', JSON.stringify(host.builder));
  }
  if (host.faceRefPath) body.append('faceRefPath', host.faceRefPath);
  if (host.outfitRefPath) body.append('outfitRefPath', host.outfitRefPath);
  if (host.styleRefPath) body.append('styleRefPath', host.styleRefPath);
  if (typeof host.faceStrength === 'number') body.append('faceStrength', String(host.faceStrength));
  if (typeof host.outfitStrength === 'number') body.append('outfitStrength', String(host.outfitStrength));
  body.append('n', '4');

  return body;
}

export async function generateHost(host) {
  // If face-outfit or style-ref mode, uploads must already have happened
  // (caller stores path strings on host object). Text mode skips uploads.
  const body = buildHostGenerateBody(host);
  const res = await fetch(`${API_BASE}/api/host/generate`, { method: 'POST', body });
  return jsonOrThrow(res, '호스트 생성');
}

// ============================================================
// Step 2 — POST /api/composite/generate
// ============================================================

export function buildCompositeBody({ host, products, background, composition }) {
  const body = new FormData();
  if (!host?.selectedPath) throw new Error('1단계에서 선택한 쇼호스트가 필요해요');
  body.append('hostImagePath', host.selectedPath);

  const productPaths = (products || [])
    .map(p => p.path)
    .filter(Boolean);
  body.append('productImagePaths', JSON.stringify(productPaths));

  const bgType = background?.source || 'prompt';
  body.append('backgroundType', bgType);
  if (bgType === 'preset') {
    if (!background.preset) throw new Error('배경 프리셋을 선택해주세요');
    body.append('backgroundPresetId', background.preset.id || background.preset);
    if (background.preset.label) body.append('backgroundPresetLabel', background.preset.label);
  } else if (bgType === 'upload') {
    if (!background.uploadPath) throw new Error('배경 이미지 업로드가 필요해요');
    body.append('backgroundUploadPath', background.uploadPath);
  } else if (bgType === 'prompt') {
    if (!background.prompt?.trim()) throw new Error('배경 설명을 입력해주세요');
    body.append('backgroundPrompt', background.prompt.trim());
  }

  body.append('direction', composition?.direction || '');
  body.append('shot', composition?.shot || 'bust');
  body.append('angle', composition?.angle || 'eye');
  body.append('n', '4');
  return body;
}

export async function generateComposite({ host, products, background, composition, rembg = true }) {
  const body = buildCompositeBody({ host, products, background, composition });
  const url = `${API_BASE}/api/composite/generate${rembg ? '' : '?rembg=false'}`;
  const res = await fetch(url, { method: 'POST', body });
  return jsonOrThrow(res, '합성 이미지 생성');
}

// ============================================================
// Step 3 — POST /api/elevenlabs/generate (voice) + final /api/generate
// ============================================================

export async function cloneVoice(sampleFile, name = 'HostStudio 클론') {
  assertSize(sampleFile);
  const fd = new FormData();
  fd.append('file', sampleFile);
  fd.append('name', name);
  const res = await fetch(`${API_BASE}/api/elevenlabs/clone-voice`, { method: 'POST', body: fd });
  return jsonOrThrow(res, '보이스 클론');
}

export async function generateVoice({ voice }) {
  if (voice.source === 'upload') {
    // Nothing to generate — the uploaded file IS the audio
    return { audio_path: voice.uploadedAudio?.path, source: 'upload' };
  }
  const script = paragraphsToScript(voice.paragraphs || [voice.script || ''], { source: voice.source });
  const body = new FormData();
  body.append('voice_id', voice.voiceId);
  body.append('text', script);
  body.append('model_id', 'eleven_v3');
  body.append('stability', String(voice.stability ?? 0.5));
  body.append('style', String(voice.style ?? 0.3));
  body.append('similarity_boost', String(voice.similarity ?? 0.75));
  if (voice.speed && voice.speed !== 1) body.append('speed', String(voice.speed));
  const res = await fetch(`${API_BASE}/api/elevenlabs/generate`, { method: 'POST', body });
  return jsonOrThrow(res, '음성 생성');
}

export async function generateVideo({ state, audio }) {
  const body = new FormData();
  body.append('host_image_path', state.host.selectedPath);
  body.append('background_image_path', state.composition.selectedPath || '');
  body.append('audio_path', audio.audio_path);
  body.append('resolution', stringifyResolution(state.resolution));
  body.append('subtitles', state.subtitles || 'on');
  if (typeof state.voice?.pitch === 'number' && state.voice.pitch !== 0) {
    body.append('pitch_semitones', String(state.voice.pitch));
  }
  const res = await fetch(`${API_BASE}/api/generate`, { method: 'POST', body });
  return jsonOrThrow(res, '영상 생성');
}

// Queue polling — returns { running, pending, recent, total_running, total_pending }.
export async function fetchQueue() {
  const res = await fetch(`${API_BASE}/api/queue`);
  return jsonOrThrow(res, '큐 상태 조회');
}

// SSE subscription. Returns unsubscribe fn.
export function subscribeProgress(taskId, onUpdate) {
  const es = new EventSource(`${API_BASE}/api/progress/${taskId}`);
  es.onmessage = (e) => {
    try { onUpdate(JSON.parse(e.data)); } catch { onUpdate({ raw: e.data }); }
  };
  es.onerror = () => {
    onUpdate({ error: true });
    es.close();
  };
  return () => es.close();
}
