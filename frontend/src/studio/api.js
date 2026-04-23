// HostStudio backend adapter — single responsibility: translate UI state
// into backend requests and back. See specs/hoststudio-migration/plan.md §5.
//
// Rules:
// - Shapes match the plan §5 tables verbatim; if UI state changes, the mapping
//   helpers here absorb the change so the backend contract stays stable.
// - Every fetch returns parsed JSON or throws a user-friendly Error.
// - No retries, no toast plumbing — callers (Step components) own UX state.

// Empty → fetch uses the page origin → Vite dev-server proxies /api and
// /static to 127.0.0.1:8001 on the server. Works whether the page is loaded
// from localhost or a LAN IP, because the browser never talks to the backend
// directly; the proxy handles it server-side. Override with VITE_API_BASE_URL
// only in production or when you specifically need a different origin.
const API_BASE = import.meta.env.VITE_API_BASE_URL || '';

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
  if (!file || typeof file !== 'object' || !(file instanceof Blob)) {
    const err = new Error('파일이 사라졌어요. 페이지를 새로고침한 뒤 다시 업로드해주세요.');
    err.status = 400;
    throw err;
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    const err = new Error('파일이 너무 커요 (최대 20MB)');
    err.status = 413;
    throw err;
  }
}

// Match legacy VideoGenerator upload pattern verbatim: raw FormData multipart
// to the existing /api/upload/* endpoints. The JSON/base64 detour was
// speculation about an ASTx/DLP multipart block that turned out to be wrong —
// our own legacy frontend running on :5173 does the exact same multipart
// POSTs from the same browser and they succeed.
async function uploadMultipart(file, path, label) {
  assertSize(file);
  const fd = new FormData();
  fd.append('file', file);
  const res = await fetch(`${API_BASE}${path}`, { method: 'POST', body: fd });
  return jsonOrThrow(res, label);
}

export async function uploadHostImage(file) {
  return uploadMultipart(file, '/api/upload/host-image', '호스트 이미지 업로드');
}

export async function uploadBackgroundImage(file) {
  return uploadMultipart(file, '/api/upload/background-image', '배경 이미지 업로드');
}

export async function uploadReferenceImage(file) {
  return uploadMultipart(file, '/api/upload/reference-image', '참조 이미지 업로드');
}

export async function uploadAudio(file) {
  return uploadMultipart(file, '/api/upload/audio', '오디오 업로드');
}

export async function uploadReferenceAudio(file) {
  return uploadMultipart(file, '/api/upload/reference-audio', '참조 오디오 업로드');
}

/**
 * List files already uploaded to the server's uploads/ dir.
 * Workaround for environments where browser file upload is blocked (DLP / VPN).
 * User scp's files onto the server once, then picks from this list in the UI.
 *
 * kind: 'image' | 'audio'. Returns { files: [{filename, path, url, size, modified}, ...] }.
 */
export async function listServerFiles(kind = 'image') {
  const res = await fetch(`${API_BASE}/api/upload/list?kind=${encodeURIComponent(kind)}`);
  return jsonOrThrow(res, '서버 파일 목록 조회');
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
// Generate 4 fresh random seeds for "다시 만들기" — the backend default
// (FIXED_DEFAULT_SEEDS) gives the same 4 outputs every time for the same
// input, which makes "retry" feel broken. Range cap at 2^31-1 so they
// fit comfortably in any int32 path.
export function makeRandomSeeds(n = 4) {
  return Array.from({ length: n }, () => Math.floor(Math.random() * 2_147_483_647));
}

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
  // outfitText: free-text outfit description, used INSTEAD of (or in addition
  // to) outfitRef. Backend interleaves both into the prompt with explicit
  // labels so Gemini knows which is the outfit reference.
  if (host.outfitText && host.outfitText.trim()) {
    body.append('outfitText', host.outfitText.trim());
  }
  // Caller passes `seeds` (array of ints) to override the backend's fixed
  // default set — used by "다시 만들기" so retry produces NEW variants
  // rather than re-running the same 4 deterministic seeds.
  if (Array.isArray(host._seeds) && host._seeds.length > 0) {
    body.append('seeds', JSON.stringify(host._seeds));
  }
  // imageSize "1K" | "2K" — shared with Step 2 via state.imageQuality.
  // Caller pokes host.imageSize before calling.
  if (host.imageSize) body.append('imageSize', host.imageSize);
  body.append('n', '4');
  // Backend accepts temperature ∈ [0.0, 2.0]. UI exposes three preset values
  // (0.4 / 0.7 / 1.0). Pass through only when user actually picked one.
  if (typeof host.temperature === 'number') body.append('temperature', String(host.temperature));

  return body;
}

export async function generateHost(host) {
  // If face-outfit or style-ref mode, uploads must already have happened
  // (caller stores path strings on host object). Text mode skips uploads.
  const body = buildHostGenerateBody(host);
  const res = await fetch(`${API_BASE}/api/host/generate`, { method: 'POST', body });
  return jsonOrThrow(res, '호스트 생성');
}

/**
 * Async generator variant — yields one event per completed candidate.
 * Use for "하나씩 페이드인" UX (plan §6 state matrix "streaming").
 *
 * Usage:
 *   for await (const evt of streamHost(host)) {
 *     if (evt.type === 'candidate') setVariants(v => [...v, evt]);
 *     else if (evt.type === 'done')   break; // or handle partial
 *     else if (evt.type === 'error')  log(evt);
 *     else if (evt.type === 'fatal')  throw new Error(evt.error);
 *   }
 *
 * EventSource only supports GET, so we use fetch + manual SSE frame parsing.
 */
export async function* streamHost(host) {
  const body = buildHostGenerateBody(host);
  const res = await fetch(`${API_BASE}/api/host/generate/stream`, { method: 'POST', body });
  if (!res.ok) {
    // Server rejected before stream started (400 / 503 etc.)
    const err = new Error(`호스트 생성 시작 실패 (${res.status})`);
    err.status = res.status;
    try { err.detail = (await res.json()).detail; } catch { /* ignore */ }
    throw err;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // SSE frames are separated by a blank line (\n\n).
    let sep;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      for (const line of frame.split('\n')) {
        if (line.startsWith('data: ')) {
          try { yield JSON.parse(line.slice(6)); }
          catch { /* malformed frame — skip */ }
        }
      }
    }
  }
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
  if (typeof composition?.temperature === 'number') {
    body.append('temperature', String(composition.temperature));
  }
  // Same retry-seed contract as the host endpoint — see buildHostGenerateBody.
  if (Array.isArray(composition?._seeds) && composition._seeds.length > 0) {
    body.append('seeds', JSON.stringify(composition._seeds));
  }
  if (composition?.imageSize) body.append('imageSize', composition.imageSize);
  return body;
}

export async function generateComposite({ host, products, background, composition, rembg = true }) {
  const body = buildCompositeBody({ host, products, background, composition });
  const url = `${API_BASE}/api/composite/generate${rembg ? '' : '?rembg=false'}`;
  const res = await fetch(url, { method: 'POST', body });
  return jsonOrThrow(res, '합성 이미지 생성');
}

// Streaming twin — same fetch + SSE parse pattern as streamHost.
export async function* streamComposite({ host, products, background, composition, rembg = true }) {
  const body = buildCompositeBody({ host, products, background, composition });
  const url = `${API_BASE}/api/composite/generate/stream${rembg ? '' : '?rembg=false'}`;
  const res = await fetch(url, { method: 'POST', body });
  if (!res.ok) {
    const err = new Error(`합성 생성 시작 실패 (${res.status})`);
    err.status = res.status;
    try { err.detail = (await res.json()).detail; } catch { /* ignore */ }
    throw err;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      for (const line of frame.split('\n')) {
        if (line.startsWith('data: ')) {
          try { yield JSON.parse(line.slice(6)); }
          catch { /* malformed frame — skip */ }
        }
      }
    }
  }
}

// ============================================================
// Step 3 — POST /api/elevenlabs/generate (voice) + final /api/generate
// ============================================================

export async function listVoices() {
  const res = await fetch(`${API_BASE}/api/elevenlabs/voices`);
  return jsonOrThrow(res, '보이스 목록 조회');
}

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
  // /api/generate accepts: audio_source, host_image_path, audio_path, script_text,
  // voice_id, stability/similarity_boost/style, prompt, seed, cpu_offload, resolution,
  // scene_prompt, reference_image_paths. Anything else is silently dropped by the
  // endpoint — we used to send background_image_path / subtitles / pitch_semitones
  // and none of those exist on the backend, so they've been removed.
  //
  // host_image_path here is the FINAL composite frame (Step 2 selection) — that's
  // the single frame FlashTalk animates. The Step 1 host-only image is not sent.
  const body = new FormData();
  const composite = state.composition?.selectedPath || state.host?.selectedPath;
  if (composite) body.append('host_image_path', composite);
  body.append('audio_path', audio.audio_path);
  body.append('audio_source', 'upload');
  body.append('resolution', stringifyResolution(state.resolution));

  // Snapshot of provenance at generate time — stored verbatim in the task
  // queue params so the render dashboard can show "어떤 쇼호스트/배경/제품/
  // 파라미터를 썼는지" *from the actual task*, not from whatever the wizard
  // state happens to be when someone attaches later. Image URLs use the
  // persistent /api/files/ paths that survive a refresh.
  const meta = {
    host: {
      mode: state.host?.mode ?? 'text',
      selectedSeed: state.host?.selectedSeed ?? null,
      selectedPath: state.host?.selectedPath ?? null,
      imageUrl: state.host?.imageUrl ?? null,
      prompt: state.host?.prompt ?? '',
      negativePrompt: state.host?.negativePrompt ?? '',
      faceRefPath: state.host?.faceRefPath ?? null,
      outfitRefPath: state.host?.outfitRefPath ?? null,
      outfitText: state.host?.outfitText ?? '',
      faceStrength: state.host?.faceStrength ?? null,
      outfitStrength: state.host?.outfitStrength ?? null,
      temperature: state.host?.temperature ?? null,
    },
    composition: {
      selectedSeed: state.composition?.selectedSeed ?? null,
      selectedPath: state.composition?.selectedPath ?? null,
      selectedUrl: state.composition?.selectedUrl ?? null,
      direction: state.composition?.direction ?? '',
      shot: state.composition?.shot ?? null,
      angle: state.composition?.angle ?? null,
      temperature: state.composition?.temperature ?? null,
    },
    products: (state.products || []).map(p => ({
      name: p.name || '',
      path: p.path || '',
      url: p.url || '',
    })),
    background: {
      source: state.background?.source || null,
      presetId: state.background?.preset?.id || (typeof state.background?.preset === 'string' ? state.background.preset : null),
      presetLabel: state.background?.preset?.label || null,
      prompt: state.background?.prompt || '',
      uploadPath: state.background?.uploadPath || null,
      imageUrl: state.background?.imageUrl || null,
    },
    voice: {
      source: state.voice?.source || null,
      voiceId: state.voice?.voiceId || null,
      voiceName: state.voice?.voiceName || null,
      script: state.voice?.script || '',
      stability: state.voice?.stability ?? null,
      style: state.voice?.style ?? null,
      similarity: state.voice?.similarity ?? null,
      speed: state.voice?.speed ?? null,
    },
    imageQuality: state.imageQuality || '1K',
  };
  body.append('meta', JSON.stringify(meta));

  // Queue label — what the user sees in the QueueStatus panel. Priority:
  // explicit script preview > voice id > generic. Without this, every job
  // landed as "Video generation" in the queue with no way to tell them apart.
  const scriptPreview = (state.voice?.script || '').replace(/\[breath\]/g, ' ').replace(/\s+/g, ' ').trim();
  const labelParts = [];
  if (scriptPreview) {
    labelParts.push(scriptPreview.slice(0, 60));
  } else if (state.voice?.voiceName) {
    labelParts.push(`목소리: ${state.voice.voiceName}`);
  }
  if (state.resolution?.label) labelParts.push(state.resolution.label);
  if (labelParts.length) body.append('queue_label', labelParts.join(' · '));

  const res = await fetch(`${API_BASE}/api/generate`, { method: 'POST', body });
  return jsonOrThrow(res, '영상 생성');
}

// Queue polling — returns { running, pending, recent, total_running, total_pending }.
export async function fetchQueue() {
  const res = await fetch(`${API_BASE}/api/queue`);
  return jsonOrThrow(res, '작업 목록 조회');
}

// Video history — returns { total, videos }. Used by RenderHistory while the
// user waits for the current job (so they have something to do besides watch
// a spinner).
export async function fetchHistory(limit = 10) {
  const res = await fetch(`${API_BASE}/api/history?limit=${limit}`);
  return jsonOrThrow(res, '히스토리 조회');
}

// Cancel a pending queued task. Backend (DELETE /api/queue/{id}) only allows
// cancelling pending tasks — running ones can't be killed mid-inference
// without leaking GPU memory. Returns 404 for running/finished.
export async function cancelQueuedTask(taskId) {
  const res = await fetch(`${API_BASE}/api/queue/${taskId}`, { method: 'DELETE' });
  return jsonOrThrow(res, '작업 취소');
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
