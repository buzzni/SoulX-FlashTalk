/**
 * HostTextForm — text-mode inputs for Step 1.
 *
 * Single-flow design: preset cards seed the textarea, user edits freely
 * from there. Cards are one-way inserts (no toggle, no sync) — prompt
 * is the only source of truth that reaches the backend.
 *
 * Reads/writes through `useFormContext` — Step1Host owns the form via
 * `<FormProvider>`.
 */

import { useFormContext } from 'react-hook-form';
import { cn } from '@/lib/utils';
import type { HostFormValues } from '@/wizard/form-mappers';

interface Preset {
  title: string;
  prompt: string;
}

const PRESETS: Preset[] = [
  {
    title: '30대 친근한 여성',
    prompt: '30대 여성, 밝게 웃고 있음, 베이지 니트, 따뜻하고 친근한 분위기',
  },
  {
    title: '20대 활기찬 여성',
    prompt: '20대 여성, 활기찬 표정, 화이트 블라우스, 깔끔한 스튜디오',
  },
  {
    title: '40대 신뢰감 남성',
    prompt: '40대 남성, 차분하고 신뢰감 있는 표정, 네이비 셔츠',
  },
  {
    title: '30대 세련 여성',
    prompt: '30대 여성, 세련된 모던 스타일, 블랙 재킷, 전문적인 분위기',
  },
  {
    title: '50대 따뜻한 남성',
    prompt: '50대 남성, 따뜻한 미소, 그레이 카디건, 편안한 분위기',
  },
  {
    title: '20대 캐주얼 남성',
    prompt: '20대 남성, 자연스러운 미소, 캐주얼 셔츠, 밝은 톤',
  },
];

export function HostTextForm() {
  const { register, setValue, watch } = useFormContext<HostFormValues>();

  // `watch('input.prompt')` re-renders this component on every keystroke
  // so the live-validity hint can light up at 15 chars without waiting
  // for a debounce flush. The textarea itself is uncontrolled (RHF
  // `register`) so typing stays cheap.
  const prompt = watch('input.prompt') ?? '';

  const applyPreset = (p: Preset) => {
    setValue('input.prompt', p.prompt, { shouldDirty: true, shouldTouch: true });
  };

  return (
    <div className="flex-col gap-4">
      <div>
        <div className="text-sm font-semibold text-foreground mb-2">예시로 시작하기</div>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {PRESETS.map((p) => (
            <button
              key={p.title}
              type="button"
              onClick={() => applyPreset(p)}
              className="text-left p-2.5 rounded-md border border-border bg-card hover:border-primary hover:bg-accent-soft transition-colors text-xs leading-snug"
            >
              <div className="font-semibold text-foreground">{p.title}</div>
              <div className="mt-1 text-tertiary line-clamp-2">{p.prompt}</div>
            </button>
          ))}
        </div>
      </div>

      <div>
        <div className="text-sm font-semibold text-foreground mb-1.5">쇼호스트 설명</div>
        <textarea
          className={cn('textarea', prompt && prompt.length < 15 && 'invalid')}
          placeholder="예) 30대 여성, 밝게 웃고 있음, 베이지 니트, 따뜻한 분위기"
          {...register('input.prompt')}
        />
      </div>

      <details className="text-xs text-tertiary">
        <summary className="cursor-pointer select-none">피하고 싶은 표현</summary>
        <input
          className="input mt-2"
          placeholder="예) 과한 화장, 어두운 표정"
          {...register('input.negativePrompt')}
        />
      </details>
    </div>
  );
}
