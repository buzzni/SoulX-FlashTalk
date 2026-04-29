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
 *
 * Reads/writes through `useFormContext` — the parent Step3Audio owns
 * the form via `<FormProvider>`. Only renders in tts-mode (parent
 * narrows on `voice.source === 'tts'`), so writing voiceId/voiceName
 * via setValue is safe.
 */

import { useRef, useState } from 'react';
import { useFormContext, useWatch } from 'react-hook-form';
import { Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import Icon from '../Icon.jsx';
import { Field } from '@/components/field';
import { ConfirmModal } from '@/components/confirm-modal';
import { cn } from '@/lib/utils';
import { deleteVoice } from '../../api/voice';
import { humanizeError } from '../../api/http';
import type { Step3FormValues } from '@/wizard/form-mappers';

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
  /** ElevenLabs category — `'cloned'` for user-cloned voices, otherwise
   * `'premade'` / `'professional'` / etc. The picker splits the list on
   * this field so cloned voices live in their own column. */
  category?: string;
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
  /** null = still loading; empty array = fetched but no voices. */
  remoteVoices: RemoteVoiceEntry[] | null;
  loadError: string | null;
  /** Called after a cloned voice is deleted server-side so the parent
   * can re-fetch the list. Optional — if omitted, deletion is hidden. */
  onAfterDelete?: () => void | Promise<void>;
}

export function VoicePicker({ remoteVoices, loadError, onAfterDelete }: VoicePickerProps) {
  const { control, setValue } = useFormContext<Step3FormValues>();
  const selectedVoiceId = useWatch({
    control,
    name: 'voice.voiceId' as const,
  }) as string | null | undefined;

  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const [playingPreview, setPlayingPreview] = useState<string | null>(null);
  // Two-step delete flow. `pendingDelete` carries the row the user
  // clicked the trash icon on; null means no modal open. `deleting`
  // is true while the API call is in flight — the modal disables
  // the confirm button so a double-click can't fire two requests.
  const [pendingDelete, setPendingDelete] = useState<VoiceItem | null>(null);
  const [deleting, setDeleting] = useState(false);

  const handleDeleteCloned = async () => {
    if (!pendingDelete || deleting) return;
    setDeleting(true);
    const voice = pendingDelete;
    try {
      await deleteVoice(voice.id);
      // If the user had this voice selected, drop the selection so
      // Step 3 doesn't look valid with a now-deleted voiceId. The
      // selectedVoiceId fallback in Step3Audio also catches stale
      // ids; this is the immediate-response path for the row the
      // user just acted on.
      if (selectedVoiceId === voice.id) {
        setValue('voice.voiceId' as const, null, {
          shouldDirty: true,
          shouldValidate: true,
        });
        setValue('voice.voiceName' as const, null, {
          shouldDirty: true,
          shouldValidate: true,
        });
      }
      toast.success('보이스를 지웠어요');
      setPendingDelete(null);
      await onAfterDelete?.();
    } catch (e) {
      toast.error(humanizeError(e));
    } finally {
      setDeleting(false);
    }
  };

  const voicesLoading = remoteVoices === null && !loadError;
  const voiceList: VoiceItem[] =
    remoteVoices && remoteVoices.length > 0
      ? remoteVoices.map((v) => ({
          id: v.voice_id,
          name: v.name,
          desc: v.labels?.description || v.labels?.descriptive || v.category || '',
          preview_url: v.preview_url,
          lang: v.labels?.language || '',
          category: v.category,
        }))
      : VOICE_PRESETS;

  // Split on ElevenLabs `category` so user-cloned voices live in their
  // own column. VOICE_PRESETS fallback (no category field at all) all
  // land in the "기본" column — the cloned column shows an empty hint.
  const clonedVoices = voiceList.filter((v) => v.category === 'cloned');
  const stockVoices = voiceList.filter((v) => v.category !== 'cloned');

  const selectVoice = (v: { id: string; name: string }) => {
    setValue('voice.voiceId' as const, v.id, {
      shouldDirty: true,
      shouldValidate: true,
    });
    setValue('voice.voiceName' as const, v.name, {
      shouldDirty: true,
      shouldValidate: true,
    });
  };

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
      <div className="grid grid-cols-2 gap-3 items-start">
        {voicesLoading ? (
          <>
            <VoiceColumn label="기본 목소리">
              {Array.from({ length: VOICE_SKELETON_COUNT - 2 }, (_, i) => (
                <VoiceSkeleton key={`sk-s-${i}`} />
              ))}
            </VoiceColumn>
            <VoiceColumn label="내 클론 목소리">
              {Array.from({ length: 2 }, (_, i) => (
                <VoiceSkeleton key={`sk-c-${i}`} />
              ))}
            </VoiceColumn>
          </>
        ) : (
          <>
            <VoiceColumn label="기본 목소리">
              {stockVoices.map((v) => (
                <VoiceRow
                  key={v.id}
                  voice={v}
                  selected={selectedVoiceId === v.id}
                  isPlaying={playingPreview === v.id}
                  onSelect={() => selectVoice({ id: v.id, name: v.name })}
                  onPlay={() => playPreview(v)}
                />
              ))}
            </VoiceColumn>
            <VoiceColumn label="내 클론 목소리" emptyHint="아직 클론한 목소리가 없어요">
              {clonedVoices.map((v) => (
                <VoiceRow
                  key={v.id}
                  voice={v}
                  selected={selectedVoiceId === v.id}
                  isPlaying={playingPreview === v.id}
                  onSelect={() => selectVoice({ id: v.id, name: v.name })}
                  onPlay={() => playPreview(v)}
                  onDelete={onAfterDelete ? () => setPendingDelete(v) : undefined}
                />
              ))}
            </VoiceColumn>
          </>
        )}
      </div>
      <audio
        ref={previewAudioRef}
        onEnded={() => setPlayingPreview(null)}
        onPause={() => setPlayingPreview(null)}
        className="hidden"
      />
      <ConfirmModal
        open={pendingDelete !== null}
        title="이 보이스를 지울까요?"
        description={
          pendingDelete ? (
            <p className="m-0 leading-relaxed">
              {pendingDelete.name}
              <br />
              <span className="text-muted-foreground">되돌릴 수 없어요.</span>
            </p>
          ) : null
        }
        confirmLabel="지우기"
        cancelLabel="유지"
        variant="danger"
        busy={deleting}
        onConfirm={handleDeleteCloned}
        onCancel={() => { if (!deleting) setPendingDelete(null); }}
      />
    </Field>
  );
}

interface VoiceColumnProps {
  label: string;
  emptyHint?: string;
  children: React.ReactNode;
}

function VoiceColumn({ label, emptyHint, children }: VoiceColumnProps) {
  const rows = Array.isArray(children) ? children.flat() : [children];
  const hasRows = rows.some((c) => c !== null && c !== false && c !== undefined);
  return (
    <div className="flex flex-col gap-1.5 min-w-0">
      <div className="text-2xs font-semibold tracking-wider uppercase text-muted-foreground px-1">
        {label}
      </div>
      {/* Independent scroll container per column. Each side scrolls on
       * its own once it overflows 360px; the columns never share a
       * scrollbar. `pr-1` leaves space so the scrollbar doesn't crowd
       * the row content. */}
      <div className="flex flex-col gap-1.5 max-h-[360px] overflow-y-auto pr-1">
        {hasRows ? (
          rows
        ) : emptyHint ? (
          <div className="px-3 py-2.5 rounded-md border border-dashed border-rule-strong text-xs text-muted-foreground">
            {emptyHint}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function VoiceSkeleton() {
  return (
    <div
      data-testid="voice-row"
      aria-hidden
      className="flex items-center gap-2.5 px-3 py-2.5 rounded-md border border-border bg-card pointer-events-none"
    >
      <div className="skeleton-shimmer bg-secondary w-8 h-8 rounded-full shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="skeleton-shimmer h-[11px] w-2/5 rounded mb-1" />
        <div className="skeleton-shimmer h-2.5 w-[70%] rounded" />
      </div>
      <div className="skeleton-shimmer w-[22px] h-[22px] rounded-md shrink-0" />
    </div>
  );
}

interface VoiceRowProps {
  voice: VoiceItem;
  selected: boolean;
  isPlaying: boolean;
  onSelect: () => void;
  onPlay: () => void;
  /** When provided, renders a trash button that fires this callback.
   * The cloned column passes it; stock voices leave it undefined so
   * users can't try to delete a shared workspace asset (the backend
   * 403s those anyway, but hiding the button is the saner UX). */
  onDelete?: () => void;
}

function VoiceRow({ voice, selected, isPlaying, onSelect, onPlay, onDelete }: VoiceRowProps) {
  return (
    <div
      data-testid="voice-row"
      data-selected={selected || undefined}
      onClick={onSelect}
      className={cn(
        'group flex items-center gap-2.5 px-3 py-2.5 rounded-md border cursor-pointer transition-[border-color,background-color,box-shadow] duration-150',
        selected
          ? 'border-primary bg-primary-soft shadow-[0_0_0_3px_color-mix(in_oklch,var(--primary)_14%,transparent)]'
          : 'border-border bg-card hover:border-rule-strong hover:bg-secondary',
      )}
    >
      <div
        className={cn(
          'w-8 h-8 rounded-full shrink-0 grid place-items-center text-xs font-bold tracking-tight transition-all border',
          selected
            ? 'bg-primary border-primary text-white'
            : 'bg-secondary border-border text-foreground group-hover:border-rule-strong',
        )}
      >
        {voice.name[0]}
      </div>
      <div className="flex-1 min-w-0">
        <div
          className={cn(
            'text-[13px] font-semibold leading-snug tracking-tight truncate',
            selected && 'text-primary-on-soft',
          )}
        >
          {voice.name}
        </div>
        <div className="text-[11.5px] text-muted-foreground leading-snug mt-px truncate">
          {voice.desc || voice.lang || ''}
        </div>
      </div>
      <button
        type="button"
        className="shrink-0 inline-flex items-center justify-center size-8 rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        title={voice.preview_url ? '미리 듣기' : '미리듣기 샘플이 없어요'}
        disabled={!voice.preview_url}
        onClick={(e) => {
          e.stopPropagation();
          onPlay();
        }}
      >
        <Icon name={isPlaying ? 'pause' : 'play'} size={10} />
      </button>
      {onDelete && (
        <button
          type="button"
          aria-label={`${voice.name} 보이스 지우기`}
          title="보이스 지우기"
          className="shrink-0 inline-flex items-center justify-center size-8 rounded-md text-muted-foreground hover:bg-destructive-soft hover:text-destructive transition-colors"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
        >
          <Trash2 className="size-3.5" />
        </button>
      )}
    </div>
  );
}
