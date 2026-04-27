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
import { Field } from '@/components/field';
import { UploadTile } from '@/components/upload-tile';
import {
  uploadFileFromAsset,
  localAssetFromUploadFile,
} from '@/components/upload-tile-bridge';
import { OptionCard } from '@/components/option-card';
import { WizardTabs, WizardTab } from '@/components/wizard-tabs';
import {
  ImageIcon,
  Sparkles,
  Frame,
  Upload,
  Link as LinkIcon,
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

export interface BackgroundPickerProps {
  onPickServerFile: () => void;
}

type PickSubMode = 'preset' | 'upload' | 'url';

function pickSubModeFor(bg: Background): PickSubMode {
  switch (bg.kind) {
    case 'preset':
      return 'preset';
    case 'upload':
      return 'upload';
    case 'url':
      return 'url';
    case 'prompt':
      return 'preset'; // shouldn't render this branch (prompt mode hides tier 2)
  }
}

export function BackgroundPicker({ onPickServerFile }: BackgroundPickerProps) {
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
          desc="추천 장소 · 내 사진 · 링크 중에서 골라요"
          meta="즉시 적용"
          onClick={() => {
            if (background.kind === 'prompt') swap({ kind: 'preset', presetId: null });
          }}
        />
        <OptionCard
          active={isAi}
          icon={<Sparkles className="size-4" />}
          title="AI로 새로 만들기"
          desc="원하는 장소·분위기를 글로 적으면 AI가 만들어줘요"
          meta="합성 시 ~25초 추가"
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
                else if (next === 'upload') swap({ kind: 'upload', asset: null });
                else swap({ kind: 'url', url: '' });
              }}
              className="mb-3"
            >
              <WizardTab value="preset" icon={<Frame className="size-3.5" />}>
                추천 장소
              </WizardTab>
              <WizardTab value="upload" icon={<Upload className="size-3.5" />}>
                내 사진
              </WizardTab>
              <WizardTab value="url" icon={<LinkIcon className="size-3.5" />}>
                링크
              </WizardTab>
            </WizardTabs>

            {background.kind === 'preset' && (
              <div className="preset-grid">
                {BG_PRESETS.map((p) => {
                  const PresetIcon = p.icon;
                  const on = background.presetId === p.id;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      className={`bg-preset-tile${on ? ' bg-preset-tile--on' : ''}`}
                      onClick={() => swap({ kind: 'preset', presetId: p.id })}
                    >
                      <PresetIcon className="bg-preset-tile__icon" strokeWidth={1.6} />
                      <div className="bg-preset-tile__text">
                        <div className="bg-preset-tile__label">{p.label}</div>
                        <div className="bg-preset-tile__desc">{p.desc}</div>
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
                onPickServerFile={onPickServerFile}
              />
            )}

            {background.kind === 'url' && (
              <Field label="이미지 주소">
                <div className="input-group">
                  <span className="prefix">
                    <Icon name="link" size={12} />
                  </span>
                  <input
                    className="input has-prefix"
                    placeholder="예) https://... 로 시작하는 이미지 링크"
                    value={background.url}
                    onChange={(e) => swap({ kind: 'url', url: e.target.value })}
                  />
                </div>
              </Field>
            )}
          </>
        )}

        {isAi && background.kind === 'prompt' && (
          <div className="flex-col gap-3">
            <Field label="어떤 배경이 필요한가요?" hint="장소·분위기를 적어주세요">
              <textarea
                className="textarea"
                placeholder="예) 밝고 깨끗한 모던 주방, 큰 창문으로 자연광이 들어오는 느낌"
                value={background.prompt}
                onChange={(e) => swap({ kind: 'prompt', prompt: e.target.value })}
                style={{ minHeight: 120 }}
              />
            </Field>
            <div className="flex items-center gap-2 text-xs text-tertiary">
              <Sparkles className="size-3.5 text-primary" />
              <span>"합성 이미지 만들기"를 누르면 이 설명으로 배경까지 같이 만들어줘요 · 약 25초 추가</span>
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
  onPickServerFile: () => void;
}

function UploadView({ asset, onChange, onPickServerFile }: UploadViewProps) {
  // Server-asset state shows the picked-file confirmation row (custom
  // markup with rename + delete affordances). Local-file state hands
  // the wrapper shape back to UploadTile via the shared bridge helper.
  if (isServerAsset(asset)) {
    return (
      <div className="flex-col gap-2">
        <div className="upload-tile has-file">
          <div className="file-thumb">
            {asset.url && <img src={asset.url} alt={asset.name ?? ''} />}
          </div>
          <div className="file-meta">
            <span className="truncate">{asset.name || '(서버 파일)'}</span>
            <span className="mono">server</span>
          </div>
          <div className="file-buttons">
            <button className="file-btn" onClick={onPickServerFile}>
              <Icon name="swap" size={12} /> 다른 파일
            </button>
            <button
              className="file-btn file-btn-danger"
              onClick={() => onChange({ kind: 'upload', asset: null })}
            >
              <Icon name="trash" size={12} /> 삭제
            </button>
          </div>
        </div>
        <ServerPickerLink onPick={onPickServerFile} />
      </div>
    );
  }

  return (
    <div className="flex-col gap-2">
      <UploadTile
        file={uploadFileFromAsset(asset)}
        onFile={(f) => {
          const localAsset = localAssetFromUploadFile(f);
          onChange({ kind: 'upload', asset: localAsset });
        }}
        onRemove={() => onChange({ kind: 'upload', asset: null })}
        label="배경 사진 올리기"
        sub="촬영한 매장 사진 등"
      />
      <ServerPickerLink onPick={onPickServerFile} />
    </div>
  );
}

function ServerPickerLink({ onPick }: { onPick: () => void }) {
  return (
    <button
      type="button"
      onClick={onPick}
      className="self-start inline-flex items-center gap-1.5 h-8 px-3 rounded-md text-[12px] font-medium text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
    >
      <Icon name="file" size={12} /> 서버에 있는 파일에서 선택
    </button>
  );
}
