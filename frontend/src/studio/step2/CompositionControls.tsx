/**
 * CompositionControls — direction / shot / angle / temperature /
 * generate button row for Step 2.
 *
 * The direction textarea highlights `1번` / `2번` references
 * inline (mirror-div overlay) — same mechanic as the original
 * Step2Composite. Chip buttons below the textarea insert the
 * N번 token at the caret position.
 */

import { useRef } from 'react';
import Icon from '../Icon.jsx';
import { WizardButton as Button } from '@/components/wizard-button';
import { Chip } from '@/components/chip';
import { Field } from '@/components/field';
import { Segmented } from '@/components/segmented';
import type { Product } from './ProductList';

export interface Composition {
  direction?: string;
  shot?: 'closeup' | 'bust' | 'medium' | 'full';
  angle?: 'eye' | 'low' | 'high';
  temperature?: number;
}

export interface CompositionControlsProps {
  composition: Composition;
  products: Product[];
  generating: boolean;
  errorMsg: string | null;
  canGenerate: boolean;
  missingReason: string | null;
  onCompositionChange: (patch: Partial<Composition>) => void;
  onGenerate: () => void;
}

const SHOT_OPTS = [
  { v: 'closeup' as const, label: '클로즈업' },
  { v: 'bust' as const, label: '상반신' },
  { v: 'medium' as const, label: '미디엄' },
  { v: 'full' as const, label: '풀샷' },
];
const ANGLE_OPTS = [
  { v: 'eye' as const, label: '정면' },
  { v: 'low' as const, label: '살짝 아래에서' },
  { v: 'high' as const, label: '살짝 위에서' },
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
  composition,
  products,
  generating,
  errorMsg,
  canGenerate,
  missingReason,
  onCompositionChange,
  onGenerate,
}: CompositionControlsProps) {
  const directionRef = useRef<HTMLTextAreaElement | null>(null);

  const insertProductRef = (idx: number) => {
    const ref = `${idx + 1}번`;
    const ta = directionRef.current;
    const cur = composition.direction || '';
    if (!ta) {
      onCompositionChange({
        direction: cur + (cur && !cur.endsWith(' ') ? ' ' : '') + ref + ' ',
      });
      return;
    }
    const s = ta.selectionStart ?? cur.length;
    const e = ta.selectionEnd ?? cur.length;
    const insert = ref + ' ';
    const next = cur.slice(0, s) + insert + cur.slice(e);
    onCompositionChange({ direction: next });
    requestAnimationFrame(() => {
      if (!directionRef.current) return;
      const pos = s + insert.length;
      directionRef.current.focus();
      directionRef.current.setSelectionRange(pos, pos);
    });
  };

  return (
    <>
      <Field label="구도 지시" hint="한 문장으로 적어도 되고, 여러 제품을 따로 적어도 돼요">
        <div className="hl-textarea">
          <div className="hl-textarea__mirror" aria-hidden>
            {(() => {
              const text = composition.direction || '';
              if (!text) return ' ';
              const parts = text.split(/(\d+번)/);
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
            ref={directionRef}
            className="textarea hl-textarea__input"
            rows={3}
            placeholder="예) 소파에 앉아 1번은 손에 들고, 2번은 옆 테이블 위에 놓기"
            value={composition.direction || ''}
            onChange={(e) => onCompositionChange({ direction: e.target.value })}
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
                {p.url ? (
                  <img src={p.url} alt="" />
                ) : (
                  <span className="product-ref-thumb__empty" />
                )}
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
          <Chip key={ex} onClick={() => onCompositionChange({ direction: ex })}>
            {ex}
          </Chip>
        ))}
      </div>

      <hr className="hr" />

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        <Field label="샷 크기">
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {SHOT_OPTS.map((o) => (
              <Chip
                key={o.v}
                on={composition.shot === o.v}
                onClick={() => onCompositionChange({ shot: o.v })}
              >
                {o.label}
              </Chip>
            ))}
          </div>
        </Field>
        <Field label="카메라 앵글">
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {ANGLE_OPTS.map((o) => (
              <Chip
                key={o.v}
                on={composition.angle === o.v}
                onClick={() => onCompositionChange({ angle: o.v })}
              >
                {o.label}
              </Chip>
            ))}
          </div>
        </Field>
      </div>

      <hr className="hr" />

      <Field
        label="변동성"
        hint="같은 입력으로도 결과를 얼마나 다양하게 뽑을지 — 안정적이면 4장이 비슷, 창의적이면 제각각"
      >
        <Segmented
          value={composition.temperature ?? 0.7}
          onChange={(v: number) => onCompositionChange({ temperature: v })}
          options={[
            { value: 0.4, label: '안정적' },
            { value: 0.7, label: '보통' },
            { value: 1.0, label: '창의적' },
          ]}
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

      <div className="flex justify-between items-center">
        <div className="text-xs text-tertiary">
          버튼을 누르면 아래에 4장의 합성 후보가 나타나요. 마음에 드는 걸 하나 고르세요.
        </div>
        <Button
          variant="primary"
          icon={generating ? undefined : 'sparkles'}
          onClick={onGenerate}
          disabled={generating || !canGenerate}
        >
          {generating ? (
            <>
              <span className="spinner" /> 합성 중…
            </>
          ) : (
            '합성 이미지 만들기'
          )}
        </Button>
      </div>
      {!canGenerate && missingReason && (
        <div className="text-xs text-tertiary" style={{ marginTop: 6 }}>
          {missingReason}
        </div>
      )}
    </>
  );
}
