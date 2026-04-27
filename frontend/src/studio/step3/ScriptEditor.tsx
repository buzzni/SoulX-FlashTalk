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
 *
 * Reads/writes through `useFormContext` — paragraphs live at
 * `voice.script.paragraphs`. Per-paragraph edits use setValue on the
 * indexed path; add/remove rewrite the whole array via setValue.
 * useFieldArray would require objects (RHF can't bind primitive
 * arrays through it), so direct setValue keeps the schema as-is.
 */

import { Fragment } from 'react';
import { useFormContext, useWatch } from 'react-hook-form';
import Icon from '../Icon.jsx';
import { Field } from '@/components/field';
import { cn } from '@/lib/utils';
import type { Step3FormValues } from '@/wizard/form-mappers';

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

/** Clamp a paragraphs array so buildScript(...).length <= SCRIPT_LIMIT.
 * Truncates from the END of the over-budget paragraph so earlier
 * content stays intact. Used when carrying script across mode swaps
 * (upload subtitle → TTS) and on hydration from stale localStorage
 * blobs that predate the cap. Runs on every AudioUploader keystroke,
 * so the loop is O(N) — track `hasNonEmpty` and `used` instead of
 * re-scanning `out` per iteration. */
export function clampParagraphs(paragraphs: string[]): string[] {
  const out: string[] = [];
  let used = 0;
  let hasNonEmpty = false;
  for (let i = 0; i < paragraphs.length; i++) {
    const p = paragraphs[i] ?? '';
    const trimmed = p.trim();
    const sepCost = trimmed.length > 0 && hasNonEmpty ? BREATH_TAG.length : 0;
    const available = SCRIPT_LIMIT - used - sepCost;
    if (available <= 0) {
      out.push('');
      continue;
    }
    if (p.length > available) {
      const sliced = p.slice(0, available);
      out.push(sliced);
      const slicedTrimmedLen = sliced.trim().length;
      used += sepCost + slicedTrimmedLen;
      if (slicedTrimmedLen > 0) hasNonEmpty = true;
    } else {
      out.push(p);
      used += sepCost + trimmed.length;
      if (trimmed.length > 0) hasNonEmpty = true;
    }
  }
  return out;
}

export interface ScriptEditorProps {
  disabled?: boolean;
}

export function ScriptEditor({ disabled = false }: ScriptEditorProps) {
  const { control, setValue, getValues } = useFormContext<Step3FormValues>();
  const watched = useWatch({
    control,
    name: 'voice.script.paragraphs' as const,
  }) as string[] | undefined;
  const paragraphs =
    watched && watched.length > 0 ? watched : [''];
  const combined = buildScript(paragraphs);
  const totalLen = combined.length;
  const remaining = SCRIPT_LIMIT - totalLen;
  const canAddParagraph = remaining >= BREATH_TAG.length + 1;

  const writeAll = (next: string[]) =>
    setValue(
      'voice.script' as const,
      { paragraphs: next },
      { shouldDirty: true, shouldValidate: true },
    );

  const updateParagraph = (idx: number, value: string) => {
    // Compute what the new combined length would be; if exceeds, clip the input.
    const all = (getValues('voice.script.paragraphs' as const) as string[]) ?? [''];
    const others = all
      .filter((_, i) => i !== idx)
      .map((p) => (p || '').trim())
      .filter((p) => p.length > 0);
    const baseLen = others.join(BREATH_TAG).length + (others.length > 0 ? BREATH_TAG.length : 0);
    const available = SCRIPT_LIMIT - baseLen;
    const trimmedValue = value.length > available ? value.slice(0, Math.max(0, available)) : value;
    const next = all.slice();
    next[idx] = trimmedValue;
    writeAll(next);
  };

  const addParagraph = () => {
    if (!canAddParagraph) return;
    const all = (getValues('voice.script.paragraphs' as const) as string[]) ?? [''];
    writeAll([...all, '']);
  };

  const removeParagraph = (idx: number) => {
    if (idx === 0) return;
    const all = (getValues('voice.script.paragraphs' as const) as string[]) ?? [''];
    const next = all.filter((_, i) => i !== idx);
    writeAll(next.length > 0 ? next : ['']);
  };

  return (
    <Field
      label="읽을 대본"
      hint={
        <span>
          문단과 문단 사이에는 짧은 텀을 두고 자연스럽게 이어 읽어요 · 전체{' '}
          <strong className={remaining < 200 ? 'text-destructive' : 'text-ink-2'}>
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
                <span className="inline-flex items-center gap-2">
                  <span
                    className={cn(
                      'font-mono text-2xs tabular-nums tracking-wider',
                      (p || '').length > 800
                        ? 'text-destructive'
                        : (p || '').length > 500
                          ? 'text-amber'
                          : 'text-ink-3',
                    )}
                    title="문단별 글자수"
                  >
                    {(p || '').length.toLocaleString()}자
                  </span>
                  {idx !== 0 && (
                    <button
                      type="button"
                      className="paragraph-delete-btn inline-flex items-center gap-1 h-7 px-2.5 rounded-md text-xs font-medium text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      onClick={() => removeParagraph(idx)}
                      disabled={disabled}
                    >
                      <Icon name="trash" size={11} />
                      삭제
                    </button>
                  )}
                </span>
              </div>
              <textarea
                className="textarea min-h-[90px]"
                placeholder={
                  idx === 0
                    ? '예) 안녕하세요 여러분! 오늘 소개해드릴 제품은 정말 특별한데요, 한 번 써보시면 왜 다들 칭찬하는지 바로 아실 거예요.'
                    : '다음 문단을 적어주세요. 앞 문단을 읽고 짧게 텀을 둔 뒤 이어서 읽어요.'
                }
                value={p}
                onChange={(e) => updateParagraph(idx, e.target.value)}
                disabled={disabled}
              />
            </div>
          </Fragment>
        ))}
      </div>
      <div className="mt-2.5 flex justify-center">
        <button
          type="button"
          className="add-paragraph-btn inline-flex items-center gap-1.5 h-8 px-3 rounded-md text-xs font-medium border border-input bg-card text-foreground hover:bg-secondary disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          onClick={addParagraph}
          disabled={disabled || !canAddParagraph}
          title={canAddParagraph ? '문단 추가' : '5000자 한도에 도달했어요'}
        >
          <Icon name="plus" size={12} />
          문단 추가
        </button>
      </div>
    </Field>
  );
}
