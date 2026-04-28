/**
 * CompositionControls — direction / shot / angle / temperature /
 * generate button row for Step 2.
 *
 * Reads/writes through `useFormContext` — the parent Step2Composite
 * owns the form via `<FormProvider>`. The direction textarea uses an
 * uncontrolled `register` pattern, but the live value is also
 * `useWatch`'d so the inline `1번` highlight overlay stays in sync
 * on every keystroke. The N번 chip insert mutates direction at the
 * caret via `setValue`.
 */

import { useRef } from 'react';
import { Controller, useFormContext, useWatch } from 'react-hook-form';
import { Sparkles as SparklesIcon, Info as InfoIcon } from 'lucide-react';
import { Chip } from '@/components/chip';
import { Field } from '@/components/field';
import { Segmented } from '@/components/segmented';
import { Spinner } from '@/components/spinner';
import { WizardErrorBanner } from '@/components/wizard-error-banner';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import type { CompositionAngle, CompositionShot, Product } from '@/wizard/schema';
import type { Step2FormValues } from '@/wizard/form-mappers';
import { productPreviewUrl } from './ProductList';

export interface CompositionControlsProps {
  generating: boolean;
  errorMsg: string | null;
  canGenerate: boolean;
  missingReason: string | null;
  onGenerate: () => void;
}

const SHOT_OPTS: { v: CompositionShot; label: string; desc: string }[] = [
  { v: 'closeup', label: '클로즈업', desc: '얼굴 중심 (Close-Up)' },
  { v: 'bust', label: '바스트샷', desc: '가슴~머리 (Bust Shot)' },
  { v: 'medium', label: '미디엄샷', desc: '머리~허리 (Medium Shot)' },
  { v: 'full', label: '풀샷', desc: '전신 (Full Shot)' },
];
const ANGLE_OPTS: { v: CompositionAngle; label: string; desc: string }[] = [
  { v: 'eye', label: '정면', desc: '아이레벨 — 같은 눈높이' },
  { v: 'low', label: '살짝 아래에서', desc: '로우앵글 — 인물이 더 커 보임' },
  { v: 'high', label: '살짝 위에서', desc: '하이앵글 — 인물이 더 작아 보임' },
];

const DIRECTION_EXAMPLES = [
  '소파에 편하게 앉아 1번 상품을 손에 들고 카메라를 바라봄',
  '주방 아일랜드 앞에 서서 1번을 앞으로 내밀어 보여줌',
  '테이블 옆에 서고 1번과 2번 상품을 테이블 위에 나란히 놓음',
  '바닥에 앉아 1번을 무릎 위에 올려놓고 설명하는 자세',
  '선반에 기대 서서 한 손에 1번을 들고 다른 손으로 가리킴',
  '걷다가 잠시 멈춘 듯한 자세로 1번을 양손으로 감싸 쥠',
];

export function CompositionControls({
  generating,
  errorMsg,
  canGenerate,
  missingReason,
  onGenerate,
}: CompositionControlsProps) {
  const { control, register, setValue } = useFormContext<Step2FormValues>();
  const directionRef = useRef<HTMLTextAreaElement | null>(null);

  // Watch what the highlight overlay needs. Direction triggers the
  // mirror-div re-render on every keystroke; products is only used
  // for the N번 chip thumbnails and validity color (so the highlight
  // dims a 3번 reference when only 2 products exist).
  const direction = useWatch({ control, name: 'settings.direction' }) ?? '';
  const products = (useWatch({ control, name: 'products' }) ?? []) as Product[];

  const insertProductRef = (idx: number) => {
    const ref = `${idx + 1}번`;
    const ta = directionRef.current;
    const cur = direction;
    if (!ta) {
      const next = cur + (cur && !cur.endsWith(' ') ? ' ' : '') + ref + ' ';
      setValue('settings.direction', next, { shouldDirty: true });
      return;
    }
    const s = ta.selectionStart ?? cur.length;
    const e = ta.selectionEnd ?? cur.length;
    const insert = ref + ' ';
    const next = cur.slice(0, s) + insert + cur.slice(e);
    setValue('settings.direction', next, { shouldDirty: true });
    requestAnimationFrame(() => {
      if (!directionRef.current) return;
      const pos = s + insert.length;
      directionRef.current.focus();
      directionRef.current.setSelectionRange(pos, pos);
    });
  };

  const directionRegister = register('settings.direction');

  return (
    <TooltipProvider>
      <Field label="구도 지시">
        <div className="hl-textarea">
          <div className="hl-textarea__mirror" aria-hidden>
            {(() => {
              if (!direction) return ' ';
              const parts = direction.split(/(\d+번)/);
              return parts.map((chunk, i) => {
                const match = chunk.match(/^(\d+)번$/);
                if (match) {
                  const n = parseInt(match[1]!, 10);
                  if (n >= 1 && products[n - 1]) {
                    return (
                      <mark key={i} className="hl-mark">
                        {chunk}
                      </mark>
                    );
                  }
                }
                return <span key={i}>{chunk}</span>;
              });
            })()}
            <span>{'​'}</span>
          </div>
          <textarea
            {...directionRegister}
            ref={(el) => {
              directionRegister.ref(el);
              directionRef.current = el;
            }}
            className="textarea hl-textarea__input"
            rows={3}
            placeholder="예) 소파에 앉아 1번은 손에 들고, 2번은 옆 테이블 위에 놓기"
            onScroll={(e) => {
              const mirror = (e.target as HTMLTextAreaElement)
                .previousSibling as HTMLElement | null;
              if (mirror) mirror.scrollTop = (e.target as HTMLTextAreaElement).scrollTop;
            }}
          />
        </div>
      </Field>

      {products.length > 0 && (
        <div className="flex items-center flex-wrap gap-1.5 mt-2.5">
          <span className="text-xs text-muted-foreground mr-0.5">번호 넣기</span>
          {products.map((p, i) => {
            const url = productPreviewUrl(p);
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => insertProductRef(i)}
                title={`${i + 1}번 상품 입력`}
                className="inline-flex items-center gap-1.5 py-1 pr-2.5 pl-1 bg-card border border-border rounded text-xs font-medium text-foreground leading-none transition-colors hover:border-rule-strong hover:bg-secondary"
              >
                <span className="block relative w-[22px] h-[22px] rounded-[4px] overflow-hidden bg-secondary shrink-0">
                  {url ? (
                    <img src={url} alt="" className="w-full h-full object-cover block" />
                  ) : (
                    <span
                      className="block w-full h-full"
                      style={{
                        backgroundImage:
                          'repeating-linear-gradient(45deg, var(--surface-2) 0 4px, var(--rule) 4px 5px)',
                      }}
                    />
                  )}
                </span>
                <span className="inline-flex items-baseline gap-px text-ink-2">
                  <strong className="text-primary text-[13px] font-bold">{i + 1}</strong>번
                </span>
              </button>
            );
          })}
        </div>
      )}

      <div className="text-xs text-muted-foreground mt-3.5 mb-1.5">예시</div>
      <div className="flex flex-wrap gap-1.5">
        {DIRECTION_EXAMPLES.map((ex) => (
          <Chip
            key={ex}
            onClick={() => setValue('settings.direction', ex, { shouldDirty: true })}
          >
            {ex}
          </Chip>
        ))}
      </div>

      <hr className="hr" />

      <div className="grid grid-cols-2 gap-3.5">
        <Controller
          control={control}
          name="settings.shot"
          render={({ field }) => (
            <Field
              label={
                <span className="inline-flex items-center gap-1">
                  샷 크기
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        className="inline-flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
                        aria-label="샷 크기 옵션 설명"
                      >
                        <InfoIcon className="size-3.5" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="top" align="start" className="max-w-[260px]">
                      <ul className="flex-col gap-0.5">
                        {SHOT_OPTS.map((o) => (
                          <li key={o.v}>
                            <strong>{o.label}</strong> · {o.desc}
                          </li>
                        ))}
                      </ul>
                    </TooltipContent>
                  </Tooltip>
                </span>
              }
            >
              <div className="flex flex-wrap gap-1.5">
                {SHOT_OPTS.map((o) => (
                  <Chip
                    key={o.v}
                    on={field.value === o.v}
                    onClick={() => field.onChange(o.v)}
                  >
                    {o.label}
                  </Chip>
                ))}
              </div>
            </Field>
          )}
        />
        <Controller
          control={control}
          name="settings.angle"
          render={({ field }) => (
            <Field
              label={
                <span className="inline-flex items-center gap-1">
                  카메라 앵글
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        className="inline-flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
                        aria-label="카메라 앵글 옵션 설명"
                      >
                        <InfoIcon className="size-3.5" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="top" align="start" className="max-w-[260px]">
                      <ul className="flex-col gap-0.5">
                        {ANGLE_OPTS.map((o) => (
                          <li key={o.v}>
                            <strong>{o.label}</strong> · {o.desc}
                          </li>
                        ))}
                      </ul>
                    </TooltipContent>
                  </Tooltip>
                </span>
              }
            >
              <div className="flex flex-wrap gap-1.5">
                {ANGLE_OPTS.map((o) => (
                  <Chip
                    key={o.v}
                    on={field.value === o.v}
                    onClick={() => field.onChange(o.v)}
                  >
                    {o.label}
                  </Chip>
                ))}
              </div>
            </Field>
          )}
        />
      </div>

      <hr className="hr" />

      <Field
        label="변동성"
        hint="안정적이면 4장이 비슷, 창의적이면 제각각"
      >
        <Controller
          control={control}
          name="settings.temperature"
          render={({ field }) => (
            <Segmented
              value={(field.value as number | undefined) ?? 0.7}
              onChange={field.onChange}
              options={[
                { value: 0.4, label: '안정적' },
                { value: 0.7, label: '보통' },
                { value: 1.0, label: '창의적' },
              ]}
            />
          )}
        />
      </Field>

      {errorMsg && <WizardErrorBanner message={errorMsg} className="mb-2.5" />}

      <div className="flex justify-between items-center gap-3 pt-1">
        <div className="text-xs text-muted-foreground">
          4장의 후보 중 하나를 골라요
        </div>
        <button
          type="button"
          onClick={onGenerate}
          disabled={generating || !canGenerate}
          className="inline-flex items-center gap-2 h-10 px-5 rounded-md bg-primary text-primary-foreground text-sm-tight font-bold hover:bg-[var(--primary-hover)] disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer transition-colors"
        >
          {generating ? (
            <>
              <Spinner size="sm" /> 합성 중
            </>
          ) : (
            <>
              <SparklesIcon className="size-4" />
              <span>합성 이미지 만들기</span>
            </>
          )}
        </button>
      </div>
      {!canGenerate && missingReason && (
        <div className="text-xs text-muted-foreground mt-1.5">{missingReason}</div>
      )}
    </TooltipProvider>
  );
}
