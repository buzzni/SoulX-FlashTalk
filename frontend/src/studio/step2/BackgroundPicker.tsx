/**
 * BackgroundPicker — 2-tier background source switch for Step 2.
 *
 * Tier 1 (pipeline decision):  "이미 있는 이미지 쓰기" (preset / upload /
 *   url) vs "AI로 새로 만들기" (prompt — generation happens during
 *   composite stream).
 *
 * Tier 2 (sub-mode within "이미 있는"): preset gallery / upload tile /
 *   external URL input.
 *
 * Schema-typed (Phase 2a). Reads/writes through `useFormContext` —
 * the parent Step2Composite owns the form via `<FormProvider>`.
 * Tagged-union shape swaps go through `setValue('background', newBg,
 * {shouldDirty:true})`; inline scalar edits (url, prompt) use
 * `register` / `setValue` to keep typing cheap.
 */

import { useFormContext } from 'react-hook-form';
import Icon from '../Icon.jsx';
import {
  UploadTile,
  UPLOAD_TILE_HAS_FILE_CLASS,
  UPLOAD_TILE_THUMB_CLASS,
  UPLOAD_TILE_FILE_BTN_CLASS,
  UPLOAD_TILE_FILE_BTN_DANGER_CLASS,
} from '@/components/upload-tile';
import {
  uploadFileFromAsset,
  localAssetFromUploadFile,
  revokeLocalAssetIfBlob,
} from '@/components/upload-tile-bridge';
import { isLocalAsset as isLocalAssetGuard } from '@/wizard/normalizers';
import { OptionCard } from '@/components/option-card';
import { WizardTabs, WizardTab } from '@/components/wizard-tabs';
import { cn } from '@/lib/utils';
import {
  ImageIcon,
  Sparkles,
  Frame,
  Upload,
  Sun,
  Sofa,
  ChefHat,
  Trees,
  Moon,
  Store,
  Square,
  Palette,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { Background, LocalAsset, ServerAsset } from '@/wizard/schema';
import { isServerAsset } from '@/wizard/normalizers';
import type { Step2FormValues } from '@/wizard/form-mappers';

const BG_PRESETS: { id: string; label: string; desc: string; icon: LucideIcon }[] = [
  { id: 'studio_white', label: '깔끔한 화이트', desc: '어떤 제품이든 무난', icon: Square },
  { id: 'studio_warm', label: '따뜻한 스튜디오', desc: '뷰티·패션', icon: Sun },
  { id: 'living_cozy', label: '아늑한 거실', desc: '리빙·생활용품', icon: Sofa },
  { id: 'kitchen', label: '모던 주방', desc: '식품·주방용품', icon: ChefHat },
  { id: 'outdoor_park', label: '햇살 좋은 야외', desc: '운동·레저', icon: Trees },
  { id: 'night_neon', label: '네온 야경', desc: '트렌디·젊은 타겟', icon: Moon },
  { id: 'retail', label: '매장 쇼룸', desc: '패션·가전', icon: Store },
  { id: 'solid_blue', label: '블루 단색', desc: '깔끔 강조', icon: Palette },
];

type PickSubMode = 'preset' | 'upload';

function pickSubModeFor(bg: Background): PickSubMode {
  switch (bg.kind) {
    case 'preset':
      return 'preset';
    case 'upload':
      return 'upload';
    case 'url':
      // URL source kind retired from the UI; legacy state still parses
      // and falls back to the upload tab.
      return 'upload';
    case 'prompt':
      return 'preset'; // shouldn't render this branch (prompt mode hides tier 2)
  }
}

export function BackgroundPicker() {
  const { setValue, watch } = useFormContext<Step2FormValues>();
  const background = watch('background');
  const isAi = background.kind === 'prompt';
  const pickSubMode: PickSubMode = pickSubModeFor(background);

  const swap = (next: Background) =>
    setValue('background', next, { shouldDirty: true, shouldValidate: true });

  return (
    <>
      {/* Tier 1 — pipeline decision */}
      <div className="grid grid-cols-2 gap-3 mb-4">
        <OptionCard
          active={!isAi}
          icon={<ImageIcon className="size-4" />}
          title="이미 있는 이미지 쓰기"
          desc="추천 장소나 내 사진에서 골라요"
          onClick={() => {
            if (background.kind === 'prompt') swap({ kind: 'preset', presetId: null });
          }}
        />
        <OptionCard
          active={isAi}
          icon={<Sparkles className="size-4" />}
          title="AI로 새로 만들기"
          desc="원하는 장소·분위기를 글로 적으면 AI가 만들어줘요"
          onClick={() => {
            if (background.kind !== 'prompt') swap({ kind: 'prompt', prompt: '' });
          }}
        />
      </div>

      {/* Tier 2 — body per chosen pipeline */}
      <div className="min-h-[280px]">
        {!isAi && (
          <>
            <WizardTabs
              value={pickSubMode}
              onValueChange={(v) => {
                const next = v as PickSubMode;
                if (next === 'preset') swap({ kind: 'preset', presetId: null });
                else swap({ kind: 'upload', asset: null });
              }}
              className="mb-3"
            >
              <WizardTab value="preset" icon={<Frame className="size-3.5" />}>
                추천 장소
              </WizardTab>
              <WizardTab value="upload" icon={<Upload className="size-3.5" />}>
                내 사진
              </WizardTab>
            </WizardTabs>

            {(background.kind === 'preset' || background.kind === 'url') && (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(130px,1fr))] gap-2.5">
                {BG_PRESETS.map((p) => {
                  const PresetIcon = p.icon;
                  const on = background.kind === 'preset' && background.presetId === p.id;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => swap({ kind: 'preset', presetId: p.id })}
                      className={cn(
                        'relative flex flex-col items-start gap-2 p-3 rounded-md border text-left transition-colors',
                        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2',
                        on
                          ? 'border-primary bg-accent-soft text-accent-text shadow-[0_0_0_3px_color-mix(in_oklch,var(--primary)_14%,transparent)] z-[1]'
                          : 'border-border bg-card hover:border-foreground/30',
                      )}
                    >
                      <PresetIcon
                        className={cn(
                          'size-[18px] shrink-0',
                          on ? 'text-primary' : 'text-muted-foreground',
                        )}
                        strokeWidth={1.6}
                      />
                      <div className="flex flex-col gap-0.5">
                        <div
                          className={cn(
                            'text-[12.5px] font-bold leading-tight tracking-tight',
                            on ? 'text-accent-text' : 'text-foreground',
                          )}
                        >
                          {p.label}
                        </div>
                        <div
                          className={cn(
                            'text-[11px] font-medium leading-snug',
                            on ? 'text-accent-text/75' : 'text-muted-foreground',
                          )}
                        >
                          {p.desc}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}

            {background.kind === 'upload' && (
              <UploadView
                asset={background.asset}
                onChange={swap}
              />
            )}
          </>
        )}

        {isAi && background.kind === 'prompt' && (
          <div className="flex-col gap-3">
            <textarea
              className="textarea min-h-[120px]"
              placeholder="예) 밝고 깨끗한 모던 주방, 큰 창문으로 자연광이 들어오는 느낌"
              value={background.prompt}
              onChange={(e) => swap({ kind: 'prompt', prompt: e.target.value })}
            />
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Sparkles className="size-3.5 text-primary" />
              <span>"합성 이미지 만들기"를 누르면 이 설명으로 배경까지 같이 만들어줘요</span>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

interface UploadViewProps {
  asset: ServerAsset | LocalAsset | null;
  onChange: (next: Background) => void;
}

function UploadView({ asset, onChange }: UploadViewProps) {
  // Server-asset state shows the post-upload confirmation row (thumb +
  // filename + delete). Reached after the user uploads a local file
  // and the parent swaps the slot to a ServerAsset.
  if (isServerAsset(asset)) {
    return (
      <div className={UPLOAD_TILE_HAS_FILE_CLASS}>
        <div className={UPLOAD_TILE_THUMB_CLASS}>
          {asset.url && (
            <img
              src={asset.url}
              alt={asset.name ?? ''}
              className="w-full h-full object-cover block"
            />
          )}
        </div>
        <div className="flex flex-col gap-0.5 min-w-0 text-[13px] text-foreground">
          <span className="truncate font-semibold tracking-tight">
            {asset.name || ''}
          </span>
          <span className="font-mono text-[11px] text-muted-foreground">server</span>
        </div>
        <div className="flex gap-1 shrink-0">
          <button
            className={cn(UPLOAD_TILE_FILE_BTN_CLASS, UPLOAD_TILE_FILE_BTN_DANGER_CLASS)}
            onClick={() => onChange({ kind: 'upload', asset: null })}
          >
            <Icon name="trash" size={12} /> 삭제
          </button>
        </div>
      </div>
    );
  }

  return (
    <UploadTile
      file={uploadFileFromAsset(asset)}
      onFile={(f) => {
        // Revoke the prior blob: previewUrl on replace so the slot
        // doesn't accumulate dead object URLs across pick/replace.
        if (asset && isLocalAssetGuard(asset)) revokeLocalAssetIfBlob(asset);
        const localAsset = localAssetFromUploadFile(f);
        onChange({ kind: 'upload', asset: localAsset });
      }}
      onRemove={() => {
        if (asset && isLocalAssetGuard(asset)) revokeLocalAssetIfBlob(asset);
        onChange({ kind: 'upload', asset: null });
      }}
      label="배경 사진 올리기"
      sub="촬영한 매장 사진 등"
    />
  );
}
