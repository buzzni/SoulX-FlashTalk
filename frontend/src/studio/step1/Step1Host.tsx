/**
 * Step1Host — wizard Step 1 container.
 *
 * Phase 2b: schema-typed. The host slice in the store is now
 *   { input: HostInput (text | image union), temperature, generation }
 *
 * This file orchestrates the typed input editors (HostTextForm /
 * HostReferenceUploader) and the streaming hook. It wires user edits
 * back to the store via replace-style `setHost`. Selection of a
 * candidate is also a store write — moves `generation.selected`.
 *
 * Kept on the legacy `{state, update}` prop interface for now —
 * Phase 3 introduces per-slice selectors (useHostSlice +
 * useWizardActions) and drops the shared `update` callback.
 */

import { useRef } from 'react';
import { ImageOff } from 'lucide-react';
import { WizardBadge as Badge } from '@/components/wizard-badge';
import { WizardButton as Button } from '@/components/wizard-button';
import { WizardCard as Card } from '@/components/wizard-card';
import { Segmented } from '@/components/segmented';
import { StepHeading } from '@/routes/StepHeading';
import { useHostGeneration, type HostVariant } from '../../hooks/useHostGeneration';
import { makeRandomSeeds } from '../../api/mapping';
import { selectHost, type HostGenerateInput } from '../../api/host';
import type { UploadResult } from '../../api/upload';
import { useWizardStore } from '../../stores/wizardStore';
import type { Host, HostInput, ServerAsset, LocalAsset } from '@/wizard/schema';
import { isServerAsset } from '@/wizard/normalizers';
import { HostTextForm } from './HostTextForm';
import { HostReferenceUploader, type RefFile } from './HostReferenceUploader';
import { HostControls } from './HostControls';
import { HostVariantGrid } from './HostVariantGrid';

const DEFAULT_SEEDS = [10, 42, 77, 128];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type UpdateFn = (updater: (state: any) => any) => void;

export interface Step1HostProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  state: any;
  update: UpdateFn;
}

/** Convert schema asset to the legacy RefFile shape for sub-components
 * still on the legacy prop API. Sub-components migrate one at a time. */
function assetToRefFile(asset: ServerAsset | LocalAsset | null): RefFile | null {
  if (!asset) return null;
  if (isServerAsset(asset)) {
    return { name: asset.name, url: asset.url, size: undefined, type: undefined };
  }
  // LocalAsset
  return { name: asset.name, url: asset.previewUrl, size: asset.file.size, type: asset.file.type };
}

export default function Step1Host({ state, update }: Step1HostProps) {
  const host = state.host as Host;
  const setHost = useWizardStore((s) => s.setHost);

  const gen = useHostGeneration();

  // Counts every "쇼호스트 만들기" press (incl. 다시 만들기). Attempt 0
  // uses DEFAULT_SEEDS; attempt 1+ uses fresh randoms.
  const attemptsRef = useRef<number>(host.generation.state === 'ready' ? 1 : 0);

  const setInput = (next: HostInput | ((prev: HostInput) => HostInput)) =>
    setHost((prev) => ({
      ...prev,
      input: typeof next === 'function' ? next(prev.input) : next,
    }));

  const setTemperature = (t: number) => setHost((prev) => ({ ...prev, temperature: t }));

  const switchMode = (mode: 'text' | 'image') => {
    if (host.input.kind === mode) return;
    if (mode === 'text') {
      setInput({
        kind: 'text',
        prompt: '',
        builder: {},
        negativePrompt: '',
        extraPrompt: '',
      });
    } else {
      setInput({
        kind: 'image',
        faceRef: null,
        outfitRef: null,
        outfitText: '',
        extraPrompt: '',
        faceStrength: 0.7,
        outfitStrength: 0.5,
      });
    }
  };

  // Readiness — text mode: 15+ char prompt. Image mode: face ref present.
  const promptReady =
    host.input.kind === 'text'
      ? host.input.prompt.length >= 15
      : host.input.faceRef !== null;

  const handleGenerate = async () => {
    const attempt = attemptsRef.current;
    const seeds = attempt === 0 ? DEFAULT_SEEDS : makeRandomSeeds(4);
    attemptsRef.current = attempt + 1;

    // Schema → backend HostGenerateInput. Inline mapper (will move to
    // wizard/api-mappers when more slices migrate).
    const apiInput: HostGenerateInput & { imageSize?: '1K' | '2K' | '4K' } = (() => {
      const base = {
        temperature: host.temperature,
        imageSize: (state.imageQuality as '1K' | '2K' | '4K') || '1K',
      } as HostGenerateInput & { imageSize: '1K' | '2K' | '4K' };
      if (host.input.kind === 'text') {
        return {
          ...base,
          mode: 'text',
          prompt: host.input.prompt,
          builder: Object.keys(host.input.builder).length > 0 ? host.input.builder : null,
          negativePrompt: host.input.negativePrompt,
          extraPrompt: host.input.extraPrompt,
        };
      }
      // image mode — pass server paths only
      const facePath = isServerAsset(host.input.faceRef) ? host.input.faceRef.path : null;
      const outfitPath = isServerAsset(host.input.outfitRef) ? host.input.outfitRef.path : null;
      const mode: HostGenerateInput['mode'] =
        facePath && outfitPath ? 'face-outfit' : facePath ? 'style-ref' : 'text';
      return {
        ...base,
        mode,
        faceRefPath: facePath,
        outfitRefPath: outfitPath,
        faceRef: host.input.faceRef ? {} : undefined,
        outfitRef: host.input.outfitRef ? {} : undefined,
        faceStrength: host.input.faceStrength,
        outfitStrength: host.input.outfitStrength,
        outfitText: host.input.outfitText,
        extraPrompt: host.input.extraPrompt,
      };
    })();

    await gen.regenerate(apiInput, attempt === 0 ? undefined : seeds);
  };

  const handleSelectVariant = (v: HostVariant) => {
    if (!v.url || !v.path || !v.imageId) return;
    setHost((prev) => {
      if (prev.generation.state !== 'ready' && prev.generation.state !== 'streaming') return prev;
      const variants = prev.generation.state === 'ready' ? prev.generation.variants : [];
      const prevSelected = prev.generation.state === 'ready' ? prev.generation.prevSelected : null;
      return {
        ...prev,
        generation: {
          state: 'ready',
          batchId: prev.generation.state === 'ready' ? prev.generation.batchId : null,
          variants,
          selected: { seed: v.seed, imageId: v.imageId as string, url: v.url as string, path: v.path as string },
          prevSelected,
        },
      };
    });
    selectHost(v.imageId).catch((e) => {
      // eslint-disable-next-line no-console
      console.warn('host select sync failed (non-fatal):', e);
    });
  };

  const handleFaceSelected = (ref: RefFile | null, uploaded?: UploadResult) => {
    setInput((prev) => {
      if (prev.kind !== 'image') return prev;
      // Server upload completed — store as ServerAsset.
      if (uploaded?.path) {
        return {
          ...prev,
          faceRef: { path: uploaded.path, url: uploaded.url, name: ref?.name },
        };
      }
      // No upload result — clear ref or leave as-is depending on ref.
      return { ...prev, faceRef: ref ? prev.faceRef : null };
    });
  };

  const handleOutfitSelected = (ref: RefFile | null, uploaded?: UploadResult) => {
    setInput((prev) => {
      if (prev.kind !== 'image') return prev;
      if (uploaded?.path) {
        return {
          ...prev,
          outfitRef: { path: uploaded.path, url: uploaded.url, name: ref?.name },
        };
      }
      return { ...prev, outfitRef: ref ? prev.outfitRef : null };
    });
  };

  const variants = gen.variants;
  const prevSelected = gen.prevSelected;
  const selectedImageId =
    host.generation.state === 'ready' && host.generation.selected
      ? host.generation.selected.imageId
      : null;
  const generated = host.generation.state === 'ready' && host.generation.selected !== null;

  return (
    <div className="step-page-split step-page-split--40-60">
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
              value={host.input.kind}
              onChange={switchMode}
              options={[
                { value: 'text', label: '설명으로 만들기', icon: 'wand' },
                { value: 'image', label: '사진으로 만들기', icon: 'image' },
              ]}
            />
            <Badge variant="neutral" icon="info">
              4장을 비교해서 골라요
            </Badge>
          </div>

          {host.input.kind === 'text' ? (
            <HostTextForm
              prompt={host.input.prompt}
              negativePrompt={host.input.negativePrompt}
              builder={host.input.builder}
              onPromptChange={(s) =>
                setInput((prev) => (prev.kind === 'text' ? { ...prev, prompt: s } : prev))
              }
              onNegativePromptChange={(s) =>
                setInput((prev) =>
                  prev.kind === 'text' ? { ...prev, negativePrompt: s } : prev,
                )
              }
              onBuilderChange={(b) =>
                setInput((prev) => (prev.kind === 'text' ? { ...prev, builder: b } : prev))
              }
            />
          ) : (
            <HostReferenceUploader
              faceRef={assetToRefFile(host.input.faceRef)}
              outfitRef={assetToRefFile(host.input.outfitRef)}
              outfitText={host.input.outfitText}
              extraPrompt={host.input.extraPrompt}
              faceStrength={host.input.faceStrength}
              outfitStrength={host.input.outfitStrength}
              onFaceSelected={handleFaceSelected}
              onOutfitSelected={handleOutfitSelected}
              onOutfitTextChange={(s) =>
                setInput((prev) => (prev.kind === 'image' ? { ...prev, outfitText: s } : prev))
              }
              onExtraPromptChange={(s) =>
                setInput((prev) => (prev.kind === 'image' ? { ...prev, extraPrompt: s } : prev))
              }
              onFaceStrengthChange={(v) =>
                setInput((prev) => (prev.kind === 'image' ? { ...prev, faceStrength: v } : prev))
              }
              onOutfitStrengthChange={(v) =>
                setInput((prev) =>
                  prev.kind === 'image' ? { ...prev, outfitStrength: v } : prev,
                )
              }
            />
          )}

          <HostControls
            temperature={host.temperature}
            imageQuality={(state.imageQuality as '1K' | '2K' | '4K') || '1K'}
            errorMsg={gen.error}
            generating={gen.isLoading}
            canGenerate={promptReady}
            onTemperatureChange={setTemperature}
            onImageQualityChange={(v) =>
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              update((s: any) => ({ ...s, imageQuality: v }))
            }
            onGenerate={handleGenerate}
          />
        </Card>
      </div>

      <div className="step-page-canvas">
        <AuditionGallery
          mode={host.input.kind}
          variants={variants}
          prevSelected={prevSelected}
          selectedImageId={selectedImageId}
          isLoading={gen.isLoading}
          generated={generated}
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
