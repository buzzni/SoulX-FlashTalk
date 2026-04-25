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

import { useEffect, useRef } from 'react';
import { Badge, Button, Card, Segmented } from '../primitives.jsx';
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
  const variants = gen.variants;
  const resultsRef = useRef<HTMLDivElement | null>(null);

  // Counts every "쇼호스트 만들기" press (incl. 다시 만들기). Attempt 0
  // uses DEFAULT_SEEDS; attempt 1+ uses fresh randoms. Persisted
  // variants from a previous session start at 1.
  const attemptsRef = useRef<number>((host.variants ?? []).length > 0 ? 1 : 0);

  const setField = <K extends keyof typeof host>(k: K, v: (typeof host)[K]) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    update((s: any) => ({ ...s, host: { ...s.host, [k]: v } }));

  // Auto-scroll to results when a stream starts or variants exist.
  useEffect(() => {
    if (!(gen.isLoading || variants.length > 0) || !resultsRef.current) return;
    const scroller =
      resultsRef.current.closest('.left-col') ||
      document.scrollingElement ||
      document.documentElement;
    if (scroller && 'scrollTo' in scroller) {
      const top = resultsRef.current.offsetTop - 80;
      scroller.scrollTo({ top, behavior: 'smooth' });
    }
  }, [gen.isLoading, variants.length]);

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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    update((s: any) => ({
      ...s,
      host: {
        ...s.host,
        generated: true,
        imageUrl: v.url ?? null,
        selectedPath: v.path ?? null,
        selectedSeed: v.seed,
        selectedImageId: v.imageId ?? null,
        _gradient: v._gradient ?? null,
      },
    }));
    // Sync the server-side lifecycle slot. Fire-and-forget — the local
    // store is already updated; a transient network blip just means
    // the cleanup sweep at the next generate misses one previously-
    // selected image (worst case: a few extra files on disk).
    if (v.imageId) {
      selectHost(v.imageId).catch((e) => {
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

  return (
    <div className="step-page">
      <div className="step-heading">
        <h1>1단계 · 쇼호스트 만들기</h1>
        <p>영상에 등장할 사람을 만들어요. 설명을 적거나 사진을 올려주세요.</p>
      </div>

      <Card>
        <div className="flex justify-between items-center" style={{ marginBottom: 14 }}>
          <Segmented
            value={host.mode}
            onChange={(v: 'text' | 'image') => {
              // Mode switch must clear the OTHER mode's inputs so the
              // backend doesn't get a stale faceRef/outfitRef/etc when the
              // user picked "설명으로 만들기" — see backend defense in
              // modules/host_generator.py _sanitize_refs_by_mode.
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

      {(gen.isLoading || variants.length > 0 || host.generated) && (
        <div ref={resultsRef}>
          <Card
            title="↓ 이 중에서 골라주세요"
            subtitle={
              gen.isLoading
                ? '후보를 만드는 중이에요. 잠시면 나타나요.'
                : '마음에 드는 후보를 클릭하면 선택돼요.'
            }
          >
            <HostVariantGrid
              variants={variants}
              prevSelected={gen.prevSelected}
              selectedImageId={
                (host as { selectedImageId?: string | null }).selectedImageId ??
                imageIdFromPath((host as { selectedPath?: string | null }).selectedPath)
              }
              onSelect={handleSelectVariant}
            />
            {host.generated && (
              <div className="mt-3 flex justify-between items-center">
                <Badge variant="success" icon="check_circle">
                  선택 완료 · 다음 단계로 진행하세요
                </Badge>
                <Button size="sm" icon="refresh" onClick={handleGenerate}>
                  다시 만들기
                </Button>
              </div>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
