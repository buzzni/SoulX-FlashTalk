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
import { Sparkles as SparklesIcon } from 'lucide-react';
import Icon from '../Icon.jsx';
import { Chip } from '@/components/chip';
import { Field } from '@/components/field';
import { Segmented } from '@/components/segmented';
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
    <>
      <Field label="구도 지시" hint="한 문장으로 적어도 되고, 여러 제품을 따로 적어도 돼요">
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
        <div
          style={{
            marginTop: 10,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            flexWrap: 'wrap',
          }}
        >
          <span className="text-xs text-tertiary" style={{ marginRight: 2 }}>
            번호 넣기
          </span>
          {products.map((p, i) => (
            <button
              key={p.id}
              type="button"
              className="product-ref-chip"
              onClick={() => insertProductRef(i)}
              title={`${i + 1}번 상품 입력`}
            >
              <span className="product-ref-thumb">
                {(() => {
                  const url = productPreviewUrl(p);
                  return url ? (
                    <img src={url} alt="" />
                  ) : (
                    <span className="product-ref-thumb__empty" />
                  );
                })()}
              </span>
              <span className="product-ref-text">
                <strong>{i + 1}</strong>번
              </span>
            </button>
          ))}
        </div>
      )}

      <div className="text-xs text-tertiary" style={{ marginTop: 14, marginBottom: 6 }}>
        예시 · 클릭하면 통째로 입력돼요
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
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

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        <Controller
          control={control}
          name="settings.shot"
          render={({ field }) => (
            <Field label="샷 크기">
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {SHOT_OPTS.map((o) => (
                  <Chip
                    key={o.v}
                    on={field.value === o.v}
                    onClick={() => field.onChange(o.v)}
                    title={o.desc}
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
            <Field label="카메라 앵글">
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {ANGLE_OPTS.map((o) => (
                  <Chip
                    key={o.v}
                    on={field.value === o.v}
                    onClick={() => field.onChange(o.v)}
                    title={o.desc}
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
        hint="같은 입력으로도 결과를 얼마나 다양하게 뽑을지 — 안정적이면 4장이 비슷, 창의적이면 제각각"
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

      {errorMsg && (
        <div
          style={{
            padding: '10px 12px',
            marginBottom: 10,
            background: 'var(--danger-soft)',
            border: '1px solid var(--danger)',
            borderRadius: 'var(--r-sm)',
            color: 'var(--danger)',
            fontSize: 12,
          }}
        >
          <Icon name="alert_circle" size={13} style={{ marginRight: 6 }} />
          {errorMsg}
        </div>
      )}

      <div className="flex justify-between items-center gap-3 pt-1">
        <div className="text-[12.5px] text-muted-foreground">
          버튼을 누르면 아래에 4장의 합성 후보가 나타나요. 마음에 드는 걸 하나 고르세요.
        </div>
        <button
          type="button"
          onClick={onGenerate}
          disabled={generating || !canGenerate}
          className="inline-flex items-center gap-2 h-10 px-5 rounded-md bg-primary text-primary-foreground text-[13.5px] font-bold hover:bg-[var(--primary-hover)] disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer transition-colors"
        >
          {generating ? (
            <>
              <span className="spinner" /> 합성 중
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
        <div className="text-xs text-tertiary" style={{ marginTop: 6 }}>
          {missingReason}
        </div>
      )}
    </>
  );
}
