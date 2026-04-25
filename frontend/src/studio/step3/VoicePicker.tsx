/**
 * VoicePicker — list-of-voices browser for Step 3 (TTS mode).
 *
 * Three states:
 *   - loading (useVoiceList is fetching)     → skeleton rows
 *   - loaded + backend had voices             → real list
 *   - loaded but empty / fetch failed         → VOICE_PRESETS fallback
 *
 * Preview playback is self-contained — one hidden `<audio>` tag
 * inside this component plays whichever voice the user clicked
 * 재생 on. Clicking another voice or hitting 재생 again pauses.
 */

import { useRef, useState } from 'react';
import Icon from '../Icon.jsx';
import { Field } from '@/components/field';
const VOICE_PRESETS: VoiceItem[] = [
  { id: 'v_minji', name: '민지', desc: '밝고 경쾌한 느낌의 20대 여성' },
  { id: 'v_sora', name: '소라', desc: '차분하고 부드러운 30대 여성' },
  { id: 'v_jiho', name: '지호', desc: '친근하고 밝은 30대 남성' },
  { id: 'v_hayoon', name: '하윤', desc: '활기차고 귀여운 20대 여성' },
  { id: 'v_dohyun', name: '도현', desc: '안정적이고 신뢰감 있는 40대 남성' },
  { id: 'v_sena', name: '세나', desc: '따뜻하고 자연스러운 30대 여성' },
];

const VOICE_SKELETON_COUNT = 6;

export interface VoiceItem {
  id: string;
  name: string;
  desc?: string;
  preview_url?: string;
  lang?: string;
}

// Shape the ElevenLabs backend returns; we map into VoiceItem.
export interface RemoteVoiceEntry {
  voice_id: string;
  name: string;
  category?: string;
  preview_url?: string;
  labels?: {
    description?: string;
    descriptive?: string;
    language?: string;
  };
}

export interface VoicePickerProps {
  selectedVoiceId: string | null;
  /** null = still loading; empty array = fetched but no voices. */
  remoteVoices: RemoteVoiceEntry[] | null;
  loadError: string | null;
  onVoiceSelected: (voice: { id: string; name: string }) => void;
}

export function VoicePicker({
  selectedVoiceId,
  remoteVoices,
  loadError,
  onVoiceSelected,
}: VoicePickerProps) {
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const [playingPreview, setPlayingPreview] = useState<string | null>(null);

  const voicesLoading = remoteVoices === null && !loadError;
  const voiceList: VoiceItem[] =
    remoteVoices && remoteVoices.length > 0
      ? remoteVoices.map((v) => ({
          id: v.voice_id,
          name: v.name,
          desc: v.labels?.description || v.labels?.descriptive || v.category || '',
          preview_url: v.preview_url,
          lang: v.labels?.language || '',
        }))
      : VOICE_PRESETS;

  const playPreview = (voiceItem: VoiceItem) => {
    if (!voiceItem.preview_url) return;
    const el = previewAudioRef.current;
    if (!el) return;
    if (playingPreview === voiceItem.id) {
      el.pause();
      setPlayingPreview(null);
      return;
    }
    el.src = voiceItem.preview_url;
    el
      .play()
      .then(() => setPlayingPreview(voiceItem.id))
      .catch(() => setPlayingPreview(null));
  };

  return (
    <Field
      label="목소리 선택"
      hint={
        voicesLoading
          ? '목소리 목록을 불러오는 중…'
          : loadError
            ? '백엔드 연결 실패 — 예시 목록을 표시하고 있어요'
            : '재생 버튼으로 미리 들어보세요'
      }
    >
      <div className="voice-list">
        {voicesLoading
          ? Array.from({ length: VOICE_SKELETON_COUNT }, (_, i) => (
              <div
                key={`sk-${i}`}
                className="voice-item voice-item--skeleton"
                aria-hidden
              >
                <div
                  className="voice-avatar skeleton-shimmer"
                  style={{ background: 'var(--bg-sunken)' }}
                />
                <div className="voice-info">
                  <div
                    className="skeleton-shimmer"
                    style={{ height: 11, width: '40%', borderRadius: 4, marginBottom: 4 }}
                  />
                  <div
                    className="skeleton-shimmer"
                    style={{ height: 10, width: '70%', borderRadius: 4 }}
                  />
                </div>
                <div
                  className="skeleton-shimmer"
                  style={{ width: 22, height: 22, borderRadius: 6, flexShrink: 0 }}
                />
              </div>
            ))
          : voiceList.map((v) => (
              <div
                key={v.id}
                className={`voice-item ${selectedVoiceId === v.id ? 'on' : ''}`}
                onClick={() => onVoiceSelected({ id: v.id, name: v.name })}
              >
                <div className="voice-avatar">{v.name[0]}</div>
                <div className="voice-info">
                  <div className="voice-name">{v.name}</div>
                  <div className="voice-meta">{v.desc || v.lang || ''}</div>
                </div>
                <button
                  type="button"
                  className="voice-play inline-flex items-center justify-center size-8 rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  title={v.preview_url ? '미리 듣기' : '미리듣기 샘플이 없어요'}
                  disabled={!v.preview_url}
                  onClick={(e) => {
                    e.stopPropagation();
                    playPreview(v);
                  }}
                >
                  <Icon name={playingPreview === v.id ? 'pause' : 'play'} size={10} />
                </button>
              </div>
            ))}
      </div>
      <audio
        ref={previewAudioRef}
        onEnded={() => setPlayingPreview(null)}
        onPause={() => setPlayingPreview(null)}
        style={{ display: 'none' }}
      />
    </Field>
  );
}
