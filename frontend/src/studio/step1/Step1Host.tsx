/**
 * Step1Host — wizard Step 1 container.
 *
 * Post-Phase-4a decomposition: this file is the orchestrator. The
 * 4 sub-components handle their own UI; the container handles
 * (a) wiring them to the wizardStore, (b) running the host
 * generation stream via useHostGeneration, (c) selecting a variant
 * on click.
 *
 * Kept byte-compatible with the legacy `{state, update}` prop
 * interface so HostStudio.jsx doesn't need to change this phase —
 * Phase 5 will drop props entirely as steps move to URL-scoped
 * routes and subscribe to the store directly.
 */

import { useRef } from 'react';
import { ImageOff } from 'lucide-react';
import { WizardBadge as Badge } from '@/components/wizard-badge';
import { WizardButton as Button } from '@/components/wizard-button';
import { WizardCard as Card } from '@/components/wizard-card';
import { Segmented } from '@/components/segmented';
import { StepHeading } from '@/routes/StepHeading';
import { useHostGeneration, type HostVariant } from '../../hooks/useHostGeneration';
import { imageIdFromPath, makeRandomSeeds } from '../../api/mapping';
import { selectHost, type HostGenerateInput } from '../../api/host';
import type { UploadResult } from '../../api/upload';
import { HostTextForm } from './HostTextForm';
import { HostReferenceUploader, type RefFile } from './HostReferenceUploader';
import { HostControls } from './HostControls';
import { HostVariantGrid } from './HostVariantGrid';

// Default seeds used for the first press — two users with the same
// input see the same 4 outputs. Retries use fresh randoms.
const DEFAULT_SEEDS = [10, 42, 77, 128];

// Thin update type matching the legacy HostStudio contract.
type UpdateFn = (updater: (state: unknown) => unknown) => void;

export interface Step1HostProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  state: any;
  update: UpdateFn;
}

export default function Step1Host({ state, update }: Step1HostProps) {
  const host = state.host as {
    mode: 'text' | 'image';
    prompt?: string;
    negativePrompt?: string;
    builder?: Record<string, string>;
    faceRef?: RefFile | null;
    outfitRef?: RefFile | null;
    faceRefPath?: string | null;
    outfitRefPath?: string | null;
    outfitText?: string;
    extraPrompt?: string;
    faceStrength?: number;
    outfitStrength?: number;
    temperature?: number;
    generated?: boolean;
    selectedSeed?: number | null;
    variants?: HostVariant[];
  };

  const gen = useHostGeneration();

  // Counts every "쇼호스트 만들기" press (incl. 다시 만들기). Attempt 0
  // uses DEFAULT_SEEDS; attempt 1+ uses fresh randoms. Persisted
  // variants from a previous session start at 1.
  const attemptsRef = useRef<number>((host.variants ?? []).length > 0 ? 1 : 0);

  const setField = <K extends keyof typeof host>(k: K, v: (typeof host)[K]) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    update((s: any) => ({ ...s, host: { ...s.host, [k]: v } }));

  const faceReady = !!host.faceRef;
  const promptReady = host.mode === 'text' ? (host.prompt?.length ?? 0) >= 15 : faceReady;

  const handleGenerate = async () => {
    const attempt = attemptsRef.current;
    const seeds = attempt === 0 ? DEFAULT_SEEDS : makeRandomSeeds(4);
    attemptsRef.current = attempt + 1;

    const input: HostGenerateInput & { imageSize?: '1K' | '2K' | '4K' } = {
      ...(host as HostGenerateInput),
      imageSize: (state.imageQuality as '1K' | '2K' | '4K') || '1K',
    };
    // Seeds param on retry only — first call lets the backend's
    // deterministic default win ("two users see the same set").
    await gen.regenerate(input, attempt === 0 ? undefined : seeds);
    // If the backend used its default, the hook's `regenerate` will
    // pass seeds=undefined which falls back to evt.seeds from the
    // init frame — we don't need to wire it locally.
    void seeds;
  };

  const handleSelectVariant = (v: HostVariant) => {
    const imageId = v.imageId ?? imageIdFromPath(v.path);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    update((s: any) => ({
      ...s,
      host: {
        ...s.host,
        generated: true,
        imageUrl: v.url ?? null,
        selectedPath: v.path ?? null,
        selectedSeed: v.seed,
        selectedImageId: imageId,
        _gradient: v._gradient ?? null,
      },
    }));
    if (imageId) {
      selectHost(imageId).catch((e) => {
        // eslint-disable-next-line no-console
        console.warn('host select sync failed (non-fatal):', e);
      });
    }
  };

  const handleFaceSelected = (ref: RefFile | null, uploaded?: UploadResult) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    update((s: any) => ({
      ...s,
      host: {
        ...s.host,
        faceRef: uploaded
          ? { name: ref?.name, size: ref?.size, type: ref?.type, url: uploaded.url }
          : ref,
        faceRefPath: uploaded?.path ?? (ref == null ? null : s.host.faceRefPath),
      },
    }));
  };
  const handleOutfitSelected = (ref: RefFile | null, uploaded?: UploadResult) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    update((s: any) => ({
      ...s,
      host: {
        ...s.host,
        outfitRef: uploaded
          ? { name: ref?.name, size: ref?.size, type: ref?.type, url: uploaded.url }
          : ref,
        outfitRefPath: uploaded?.path ?? (ref == null ? null : s.host.outfitRefPath),
      },
    }));
  };

  const variants = gen.variants;
  const prevSelected = gen.prevSelected;
  const selectedImageId =
    (host as { selectedImageId?: string | null }).selectedImageId ??
    imageIdFromPath((host as { selectedPath?: string | null }).selectedPath);

  return (
    <div className="step-page-split step-page-split--40-60">
      {/* LEFT — casting brief: form for prompt/builder OR reference uploads.
       * Step heading sits at the top of the left column so the
       * audition gallery on the right starts flush at the top edge. */}
      <div className="step-page-form">
        <StepHeading
          step={1}
          title="쇼호스트 만들기"
          description="영상에 등장할 사람을 만들어요. 설명을 적거나 사진을 올려주세요."
          eyebrow="영상 위저드"
        />

        <Card>
          <div className="flex justify-between items-center">
            <Segmented
              value={host.mode}
              onChange={(v: 'text' | 'image') => {
                // Mode switch must clear the OTHER mode's inputs so the
                // backend doesn't get a stale faceRef/outfitRef/etc when
                // the user picked "설명으로 만들기" — see backend defense
                // in modules/host_generator.py _sanitize_refs_by_mode.
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                update((s: any) => ({
                  ...s,
                  host:
                    v === 'text'
                      ? {
                          ...s.host,
                          mode: 'text',
                          faceRef: null,
                          faceRefPath: null,
                          outfitRef: null,
                          outfitRefPath: null,
                          outfitText: '',
                          extraPrompt: '',
                        }
                      : {
                          ...s.host,
                          mode: 'image',
                          prompt: '',
                          negativePrompt: '',
                          builder: {},
                        },
                }));
              }}
              options={[
                { value: 'text', label: '설명으로 만들기', icon: 'wand' },
                { value: 'image', label: '사진으로 만들기', icon: 'image' },
              ]}
            />
            <Badge variant="neutral" icon="info">
              4장을 비교해서 골라요
            </Badge>
          </div>

          {host.mode === 'text' ? (
            <HostTextForm
              prompt={host.prompt ?? ''}
              negativePrompt={host.negativePrompt ?? ''}
              builder={host.builder ?? {}}
              onPromptChange={(s) => setField('prompt', s)}
              onNegativePromptChange={(s) => setField('negativePrompt', s)}
              onBuilderChange={(b) => setField('builder', b)}
            />
          ) : (
            <HostReferenceUploader
              faceRef={host.faceRef ?? null}
              outfitRef={host.outfitRef ?? null}
              outfitText={host.outfitText ?? ''}
              extraPrompt={host.extraPrompt ?? ''}
              faceStrength={host.faceStrength ?? 0.7}
              outfitStrength={host.outfitStrength ?? 0.5}
              onFaceSelected={handleFaceSelected}
              onOutfitSelected={handleOutfitSelected}
              onOutfitTextChange={(s) => setField('outfitText', s)}
              onExtraPromptChange={(s) => setField('extraPrompt', s)}
              onFaceStrengthChange={(v) => setField('faceStrength', v)}
              onOutfitStrengthChange={(v) => setField('outfitStrength', v)}
            />
          )}

          <HostControls
            temperature={host.temperature ?? 0.7}
            imageQuality={(state.imageQuality as '1K' | '2K' | '4K') || '1K'}
            errorMsg={gen.error}
            generating={gen.isLoading}
            canGenerate={promptReady}
            onTemperatureChange={(v) => setField('temperature', v)}
            onImageQualityChange={(v) =>
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              update((s: any) => ({ ...s, imageQuality: v }))
            }
            onGenerate={handleGenerate}
          />
        </Card>
      </div>

      {/* RIGHT — audition gallery. Codex framing: candidates feel
       * "auditioned, not generated". Empty / loading / picked states
       * live in AuditionGallery. */}
      <div className="step-page-canvas">
        <AuditionGallery
          mode={host.mode}
          variants={variants}
          prevSelected={prevSelected}
          selectedImageId={selectedImageId}
          isLoading={gen.isLoading}
          generated={!!host.generated}
          onSelect={handleSelectVariant}
          onRegenerate={handleGenerate}
        />
      </div>
    </div>
  );
}

interface AuditionGalleryProps {
  mode: 'text' | 'image';
  variants: HostVariant[];
  prevSelected: HostVariant | null;
  selectedImageId: string | null;
  isLoading: boolean;
  generated: boolean;
  onSelect: (v: HostVariant) => void;
  onRegenerate: () => void;
}

function AuditionGallery({
  mode,
  variants,
  prevSelected,
  selectedImageId,
  isLoading,
  generated,
  onSelect,
  onRegenerate,
}: AuditionGalleryProps) {
  const empty = !isLoading && variants.length === 0;
  return (
    <section className="audition">
      <header className="audition__header">
        <span className="audition__eyebrow">오디션 결과</span>
        <h2 className="audition__title">
          {empty
            ? '쇼호스트 후보가 여기 나와요'
            : isLoading && variants.length === 0
              ? '후보를 만드는 중이에요'
              : `후보 ${variants.length}장 · 마음에 드는 한 명을 골라주세요`}
        </h2>
      </header>

      {empty ? (
        <div className="audition__empty">
          <ImageOff className="size-6" strokeWidth={1.4} />
          <p className="audition__empty-line">
            {mode === 'text'
              ? '왼쪽에 어떤 모습인지 적고\n쇼호스트 만들기를 눌러주세요'
              : '왼쪽에 얼굴·옷차림 사진을 올리고\n쇼호스트 만들기를 눌러주세요'}
          </p>
        </div>
      ) : (
        <>
          {variants.length > 0 && (
            <HostVariantGrid
              variants={variants}
              prevSelected={prevSelected}
              selectedImageId={selectedImageId}
              onSelect={onSelect}
            />
          )}
          {generated && (
            <footer className="audition__footer">
              <Badge variant="success" icon="check_circle">
                선택 완료 · 다음 단계로 넘어가세요
              </Badge>
              <Button size="sm" icon="refresh" onClick={onRegenerate}>
                다시 만들기
              </Button>
            </footer>
          )}
        </>
      )}
    </section>
  );
}
