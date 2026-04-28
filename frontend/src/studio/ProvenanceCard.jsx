// ProvenanceCard — "이렇게 만들었어요" section. Shows the knobs that
// produced a given video task.
//
// Takes a single `result` object matching the shape returned by
// /api/results/{task_id}:
//   {
//     params: {                            ← backend-authoritative payload
//       host_image, audio_source_label,
//       script_text, scene_prompt, seed,
//       resolution_requested,              (raw input, e.g. "1920x1080")
//       resolution_actual,                 (after 16× snap, e.g. "1920x1072")
//       reference_image_paths, ...
//     },
//     meta: {                              ← client snapshot at dispatch time
//       host, composition, products,       (null for pre-af014e1 tasks)
//       background, voice, imageQuality
//     } | null,
//   }
//
// `fallbackMeta` — used only by RenderDashboard's live view when the
// manifest doesn't exist yet (dispatch-in-progress). ResultPage always
// omits this since it fetches the real manifest.

import { outputsPathToUrl } from '../lib/format';

// Only used when we can't find a more specific label (e.g., preset name).
const BG_SOURCE_DEFAULTS = {
  preset: '추천 장소',
  prompt: '직접 만들기',
  upload: '내 사진',
  url: '링크',
};
const VOICE_SOURCE_LABELS = {
  tts: '목소리 고르기',
  clone: '내 목소리 복제',
  upload: '녹음 파일 업로드',
};
// Schema is close|medium|far; UI labels use Korean film-industry
// standards (클로즈업/미디엄샷/풀샷). Legacy manifests may carry
// 'closeup', 'bust', 'medium', 'full' — each gets its own industry
// term so historical data stays distinct (바스트샷 ≠ 미디엄샷). New
// jobs only ever store close/medium/far.
const SHOT_LABELS = {
  closeup: '클로즈업',
  close: '클로즈업',
  bust: '바스트샷',
  medium: '미디엄샷',
  full: '풀샷',
  far: '풀샷',
};
const QUALITY_LABELS = {
  '4K': '초고화질 (4K)',
  '2K': '고화질 (2K)',
  '1K': '표준 (1K)',
};

const tempLabel = (t) => t == null ? '—' : (t <= 0.4 ? '안정적' : t >= 1.0 ? '창의적' : '보통');

// outputsPathToUrl moved to ../lib/format so ResultsListPage can reuse it.

// Backend stores resolution as "HxW" (e.g. "1920x1080" — portrait 9:16);
// display as "W×H" (e.g. "1080×1920") to match how users think about
// video resolutions and to stay consistent with the summary card.
function displayResolution(raw) {
  if (!raw) return null;
  const m = /^(\d+)\s*x\s*(\d+)$/.exec(raw);
  if (!m) return raw;
  return `${m[2]}×${m[1]}`;
}

export default function ProvenanceCard({ result, fallbackMeta = null }) {
  const params = result?.params || {};
  const meta = result?.meta || fallbackMeta || null;

  const h = meta?.host || {};
  const c = meta?.composition || {};
  const bg = meta?.background || {};
  const products = meta?.products || [];
  const voice = meta?.voice || {};
  const imageQuality = meta?.imageQuality || null;

  // Prefer backend-authoritative payload for fields both sides have.
  const resolutionActual = params.resolution_actual || null;
  const resolutionRequested = params.resolution_requested || null;
  const scriptText = params.script_text || voice.script || '';
  const sceneDirection = params.scene_prompt || c.direction || '';
  const voiceSourceRaw = params.audio_source_label || voice.source || null;
  const compositeUrl = outputsPathToUrl(params.host_image) || c.selectedUrl || null;

  // For preset backgrounds prefer the human-readable preset name ("아늑한
  // 거실") over the generic source label ("추천 장소"), since users picked a
  // specific preset and want to see which one.
  const bgLabel = (() => {
    if (bg.source === 'preset') return bg.presetLabel || bg.preset?.label || BG_SOURCE_DEFAULTS.preset;
    return BG_SOURCE_DEFAULTS[bg.source] || '—';
  })();
  const voiceSource = VOICE_SOURCE_LABELS[voiceSourceRaw] || '—';
  const shotLabel = SHOT_LABELS[c.shot] || '—';
  const qualityLabel = QUALITY_LABELS[imageQuality] || '—';

  return (
    <div className="surface-base p-5">
      <div className="text-2xs uppercase tracking-widest font-semibold text-muted-foreground">이렇게 만들었어요</div>

      {/* Thumbnails — host (Step 1) + composite (Step 2). What actually
          fed into FlashTalk. Host image comes from meta; composite from
          the backend payload (params.host_image). Fixed 120px width so
          they read as thumbnails, not centerpieces. */}
      {(h.imageUrl || compositeUrl) && (
        <div className="flex gap-3 mt-3 mb-1">
          {h.imageUrl && (
            <figure className="m-0 w-[120px] flex-none">
              <div className="aspect-[9/16] rounded-lg overflow-hidden bg-[#0b0d12] border border-border">
                <img src={h.imageUrl} alt="쇼호스트" className="w-full h-full object-cover" />
              </div>
              <figcaption className="text-xs text-tertiary mt-1.5">1단계 · 쇼호스트</figcaption>
            </figure>
          )}
          {compositeUrl && (
            <figure className="m-0 w-[120px] flex-none">
              <div className="aspect-[9/16] rounded-lg overflow-hidden bg-[#0b0d12] border border-border">
                <img src={compositeUrl} alt="합성" className="w-full h-full object-cover" />
              </div>
              <figcaption className="text-xs text-tertiary mt-1.5">2단계 · 합성 스틸</figcaption>
            </figure>
          )}
        </div>
      )}

      <div className="grid grid-cols-4 gap-5 mt-4">
        <div>
          <div className="text-xs text-tertiary">쇼호스트</div>
          <div className="font-medium mt-0.5">
            {h.mode === 'text' ? '설명으로 만들기' : h.mode === 'image' ? '사진으로 만들기' : '—'}
          </div>
          {h.prompt && (
            <div className="text-xs text-tertiary truncate" title={h.prompt}>{h.prompt}</div>
          )}
        </div>
        <div>
          <div className="text-xs text-tertiary">소개할 제품</div>
          <div className="font-medium mt-0.5 num">{products.length}개</div>
          <div className="text-xs text-tertiary truncate">
            {products.map(p => p.name).filter(Boolean).join(', ') || '—'}
          </div>
        </div>
        <div>
          <div className="text-xs text-tertiary">배경</div>
          <div className="font-medium mt-0.5">{bgLabel}</div>
          <div className="text-xs text-tertiary truncate">
            {bg.source === 'prompt' ? (bg.prompt || '—')
              : bg.source === 'preset' ? (bg.presetId || '')
              : bg.source === 'upload' ? '업로드 이미지' : ''}
          </div>
        </div>
        <div>
          <div className="text-xs text-tertiary">목소리</div>
          <div className="font-medium mt-0.5">
            {voice.voiceName || (voiceSourceRaw === 'upload' ? '녹음 파일' : '—')}
          </div>
          <div className="text-xs text-tertiary">{voiceSource}</div>
        </div>
      </div>

      <div className="grid grid-cols-4 gap-5 mt-4 pt-3.5 border-t border-border">
        <div>
          <div className="text-xs text-tertiary">해상도</div>
          <div className="font-medium mt-0.5 num mono">
            {displayResolution(resolutionActual) || displayResolution(resolutionRequested) || '—'}
          </div>
          {resolutionActual && resolutionRequested && resolutionActual !== resolutionRequested && (
            <div className="text-xs text-tertiary">요청 {displayResolution(resolutionRequested)}</div>
          )}
        </div>
        <div>
          <div className="text-xs text-tertiary">이미지 품질</div>
          <div className="font-medium mt-0.5">{qualityLabel}</div>
        </div>
        <div>
          <div className="text-xs text-tertiary">샷</div>
          <div className="font-medium mt-0.5">{shotLabel}</div>
        </div>
        <div>
          <div className="text-xs text-tertiary">변동성 (쇼호스트 · 합성)</div>
          <div className="font-medium mt-0.5">
            {tempLabel(h.temperature)} · {tempLabel(c.temperature)}
          </div>
        </div>
      </div>

      {sceneDirection && (
        <div className="mt-4 pt-3.5 border-t border-border">
          <div className="text-xs text-tertiary">합성 지시사항</div>
          <div className="text-sm-tight mt-1 whitespace-pre-wrap">{sceneDirection}</div>
        </div>
      )}

      {scriptText && (
        <div className="mt-4 pt-3.5 border-t border-border">
          <div className="text-xs text-tertiary">대본</div>
          <div className="text-sm-tight mt-1 whitespace-pre-wrap max-h-[120px] overflow-y-auto">
            {scriptText.replace(/\[breath\]/g, ' · ')}
          </div>
        </div>
      )}
    </div>
  );
}
