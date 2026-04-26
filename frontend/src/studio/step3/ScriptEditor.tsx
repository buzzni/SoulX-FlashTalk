/**
 * ScriptEditor — multi-paragraph script input with [breath] tag
 * separation.
 *
 * Each paragraph is a separate textarea. Between paragraphs a
 * "breath divider" stub renders (visual hint that ElevenLabs v3
 * will insert a ` [breath] ` tag there during generation). The
 * first paragraph can't be deleted; others each show a trash
 * button.
 *
 * Character counting subtracts the BREATH_TAG overhead (9 chars
 * each × N-1 paragraphs) so users can type up to the real 5000-
 * char API limit rather than the padded one.
 */

import { Fragment } from 'react';
import Icon from '../Icon.jsx';
import { Field } from '@/components/field';
const BREATH_TAG = ' [breath] ';
export const SCRIPT_LIMIT = 5000;

/** Joins non-empty paragraphs with the breath separator for the
 * backend payload. Exported so the parent container's
 * "combined script" helper stays in sync. */
export function buildScript(paragraphs: string[]): string {
  return (paragraphs || [])
    .map((p) => (p || '').trim())
    .filter((p) => p.length > 0)
    .join(BREATH_TAG);
}

export interface ScriptEditorProps {
  paragraphs: string[];
  onParagraphsChange: (next: string[]) => void;
}

export function ScriptEditor({ paragraphs, onParagraphsChange }: ScriptEditorProps) {
  const combined = buildScript(paragraphs);
  const totalLen = combined.length;
  const remaining = SCRIPT_LIMIT - totalLen;
  const canAddParagraph = remaining >= BREATH_TAG.length + 1;

  const updateParagraph = (idx: number, value: string) => {
    // Compute what the new combined length would be; if exceeds, clip the input.
    const next = paragraphs.slice();
    const others = next
      .filter((_, i) => i !== idx)
      .map((p) => (p || '').trim())
      .filter((p) => p.length > 0);
    const baseLen = others.join(BREATH_TAG).length + (others.length > 0 ? BREATH_TAG.length : 0);
    const available = SCRIPT_LIMIT - baseLen;
    const trimmedValue = value.length > available ? value.slice(0, Math.max(0, available)) : value;
    next[idx] = trimmedValue;
    onParagraphsChange(next);
  };

  const addParagraph = () => {
    if (!canAddParagraph) return;
    onParagraphsChange([...paragraphs, '']);
  };

  const removeParagraph = (idx: number) => {
    if (idx === 0) return; // first paragraph is required
    const next = paragraphs.filter((_, i) => i !== idx);
    onParagraphsChange(next.length > 0 ? next : ['']);
  };

  return (
    <Field
      label="읽을 대본"
      hint={
        <span>
          문단과 문단 사이에는 짧은 텀을 두고 자연스럽게 이어 읽어요 · 전체{' '}
          <strong
            style={{ color: remaining < 200 ? 'var(--danger)' : 'var(--text-secondary)' }}
          >
            {totalLen.toLocaleString()}
          </strong>{' '}
          / {SCRIPT_LIMIT.toLocaleString()}자
        </span>
      }
    >
      <div className="script-paragraphs">
        {paragraphs.map((p, idx) => (
          <Fragment key={idx}>
            {idx > 0 && (
              <div className="breath-divider" aria-hidden>
                <span className="breath-dot" />
              </div>
            )}
            <div className="script-paragraph">
              <div className="script-paragraph__header">
                <span className="script-paragraph__label">문단 {idx + 1}</span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                  <span
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 10.5,
                      color:
                        (p || '').length > 800
                          ? 'var(--danger)'
                          : (p || '').length > 500
                            ? 'var(--warn)'
                            : 'var(--text-tertiary)',
                      letterSpacing: '0.02em',
                      fontVariantNumeric: 'tabular-nums',
                    }}
                    title="문단별 글자수"
                  >
                    {(p || '').length.toLocaleString()}자
                  </span>
                  {idx !== 0 && (
                    <button
                      type="button"
                      className="paragraph-delete-btn inline-flex items-center gap-1 h-7 px-2.5 rounded-md text-[12px] font-medium text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
                      onClick={() => removeParagraph(idx)}
                    >
                      <Icon name="trash" size={11} />
                      삭제
                    </button>
                  )}
                </span>
              </div>
              <textarea
                className="textarea"
                style={{ minHeight: 90 }}
                placeholder={
                  idx === 0
                    ? '예) 안녕하세요 여러분! 오늘 소개해드릴 제품은 정말 특별한데요, 한 번 써보시면 왜 다들 칭찬하는지 바로 아실 거예요.'
                    : '다음 문단을 적어주세요. 앞 문단을 읽고 짧게 텀을 둔 뒤 이어서 읽어요.'
                }
                value={p}
                onChange={(e) => updateParagraph(idx, e.target.value)}
              />
            </div>
          </Fragment>
        ))}
      </div>
      <div className="mt-2.5 flex justify-center">
        <button
          type="button"
          className="add-paragraph-btn inline-flex items-center gap-1.5 h-8 px-3 rounded-md text-[12px] font-medium border border-input bg-card text-foreground hover:bg-secondary disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          onClick={addParagraph}
          disabled={!canAddParagraph}
          title={canAddParagraph ? '문단 추가' : '5000자 한도에 도달했어요'}
        >
          <Icon name="plus" size={12} />
          문단 추가
        </button>
      </div>
    </Field>
  );
}
