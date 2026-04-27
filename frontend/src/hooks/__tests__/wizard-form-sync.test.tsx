/**
 * Lane D — useFormZustandSync + useDebouncedFormSync tests.
 *
 * Verifies the bidirectional bridge between RHF and a zustand slice.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useForm, type FieldValues } from 'react-hook-form';
import { useFormZustandSync } from '../wizard/useFormZustandSync';
import { useDebouncedFormSync } from '../wizard/useDebouncedFormSync';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

interface Slice {
  prompt: string;
  count: number;
}
interface FormValues {
  prompt: string;
  count: number;
}
const sliceToForm = (s: Slice): FormValues => ({ prompt: s.prompt, count: s.count });

describe('useFormZustandSync', () => {
  it('calls form.reset when the slice reference changes', () => {
    const { result, rerender } = renderHook(
      ({ slice }: { slice: Slice }) => {
        const form = useForm<FormValues>({ defaultValues: sliceToForm(slice) });
        useFormZustandSync(form, slice, sliceToForm);
        return form;
      },
      { initialProps: { slice: { prompt: 'a', count: 1 } } },
    );

    rerender({ slice: { prompt: 'b', count: 2 } });

    expect(result.current.getValues('prompt')).toBe('b');
    expect(result.current.getValues('count')).toBe(2);
  });

  it('does not call reset when the same slice reference is passed', () => {
    const slice = { prompt: 'stable', count: 99 };
    const { result, rerender } = renderHook(
      ({ s }: { s: Slice }) => {
        const form = useForm<FormValues>({ defaultValues: sliceToForm(s) });
        useFormZustandSync(form, s, sliceToForm);
        return form;
      },
      { initialProps: { s: slice } },
    );

    // User edits the prompt locally — reset would blow this away.
    act(() => result.current.setValue('prompt', 'user-edit'));

    rerender({ s: slice });

    expect(result.current.getValues('prompt')).toBe('user-edit');
  });
});

describe('useDebouncedFormSync', () => {
  it('fires onChange after the debounce window', () => {
    const onChange = vi.fn();
    const { result } = renderHook(() => {
      const form = useForm<FormValues>({ defaultValues: { prompt: '', count: 0 } });
      useDebouncedFormSync(form, onChange, 300);
      return form;
    });

    act(() => {
      result.current.setValue('prompt', 'hello');
    });

    expect(onChange).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]![0]).toMatchObject({ prompt: 'hello' });
  });

  it('debounces multiple writes into a single onChange', () => {
    const onChange = vi.fn();
    const { result } = renderHook(() => {
      const form = useForm<FormValues>({ defaultValues: { prompt: '', count: 0 } });
      useDebouncedFormSync(form, onChange, 300);
      return form;
    });

    act(() => result.current.setValue('prompt', 'a'));
    act(() => vi.advanceTimersByTime(100));
    act(() => result.current.setValue('prompt', 'ab'));
    act(() => vi.advanceTimersByTime(100));
    act(() => result.current.setValue('prompt', 'abc'));
    act(() => vi.advanceTimersByTime(300));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]![0]).toMatchObject({ prompt: 'abc' });
  });

  it('suppresses no-op flush when serialized values match the last emit', () => {
    const onChange = vi.fn();
    const { result } = renderHook(() => {
      const form = useForm<FormValues>({ defaultValues: { prompt: '', count: 0 } });
      useDebouncedFormSync(form, onChange, 300);
      return form;
    });

    // First real change → fires once.
    act(() => result.current.setValue('prompt', 'hello'));
    act(() => vi.advanceTimersByTime(300));
    expect(onChange).toHaveBeenCalledTimes(1);

    // Re-typing the same characters (or a form.reset round-trip with
    // identical values) must not re-emit. Without change-detection
    // this would feed into useFormZustandSync and create a loop.
    act(() => result.current.setValue('prompt', 'hello'));
    act(() => vi.advanceTimersByTime(300));
    expect(onChange).toHaveBeenCalledTimes(1);

    // A genuinely different value still flushes.
    act(() => result.current.setValue('prompt', 'world'));
    act(() => vi.advanceTimersByTime(300));
    expect(onChange).toHaveBeenCalledTimes(2);
  });
});

describe('useFormZustandSync (hard reset semantics)', () => {
  it('replaces the entire shape on a tagged-union swap (mode switch) even with dirty fields', () => {
    // Simulates Step1Host's text→image mode swap while the user has
    // typed a dirty prompt. Reproduction of the "does keepDirtyValues
    // preserve stale fields across discriminator change?" worry.
    interface TaggedSlice {
      input:
        | { kind: 'text'; prompt: string }
        | { kind: 'image'; faceRef: string | null };
    }
    interface TaggedForm extends FieldValues {
      input:
        | { kind: 'text'; prompt: string }
        | { kind: 'image'; faceRef: string | null };
    }
    const sliceToFormTagged = (s: TaggedSlice): TaggedForm => ({ input: s.input });

    let slice: TaggedSlice = { input: { kind: 'text', prompt: '' } };
    const { result, rerender } = renderHook(
      ({ s }: { s: TaggedSlice }) => {
        const form = useForm<TaggedForm>({ defaultValues: sliceToFormTagged(s) });
        useFormZustandSync(form, s, sliceToFormTagged);
        return form;
      },
      { initialProps: { s: slice } },
    );

    // User typed a prompt — dirty.
    act(() => result.current.setValue('input.prompt', '30대 여성', { shouldDirty: true }));

    // switchMode equivalent: store now holds image-mode input.
    slice = { input: { kind: 'image', faceRef: null } };
    rerender({ s: slice });

    // Discriminator MUST flip. If keepDirtyValues left input.kind on
    // 'text', the Segmented control would snap back and the persisted
    // shape would be schema-invalid.
    const next = result.current.getValues('input');
    expect(next.kind).toBe('image');
    expect((next as { prompt?: string }).prompt).toBeUndefined();
  });
});
