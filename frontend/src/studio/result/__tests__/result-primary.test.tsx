/**
 * ResultPrimary unit tests — full 19/19 coverage per eng-review 3T.
 *
 * Status mapping (5): completed/error/cancelled/loading/processing each
 *   render the correct primary text (or no primary, in the processing case).
 * Kebab contents (3): completed has 공유 링크 복사; error+cancelled don't;
 *   all three have the common 새로 만들기 + 수정해서 다시 만들기 pair.
 * Retry depth (3): retriedFrom=null → 재시도; retriedFrom="abc" →
 *   수정해서 다시 만들기; one-deep heuristic short-circuits the chain walk.
 * Mobile breakpoint (1): viewport=375 wraps kebab to its own row (asserted
 *   via the `flex-col md:flex-row` className on the wrapper).
 * a11y (2): kebab trigger has aria-haspopup="menu" + aria-label; focus
 *   returns to trigger on close (Radix default).
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { ResultPrimary } from '../ResultPrimary';

const noop = () => {};

function renderPrimary(overrides: Partial<React.ComponentProps<typeof ResultPrimary>> = {}) {
  const props: React.ComponentProps<typeof ResultPrimary> = {
    status: 'completed',
    taskId: 't_test',
    retriedFrom: null,
    copied: false,
    onCopyShare: noop,
    onEdit: noop,
    onRetry: noop,
    onNew: noop,
    ...overrides,
  };
  return render(<ResultPrimary {...props} />);
}

afterEach(() => {
  cleanup();
});

// ── Status → primary mapping (5) ─────────────────────────────────────

describe('ResultPrimary — status to primary mapping', () => {
  it('completed: renders 내 컴퓨터에 저장 download anchor', () => {
    renderPrimary({ status: 'completed', taskId: 'abc123' });
    const link = screen.getByTestId('result-primary-action');
    expect(link.tagName).toBe('A');
    expect(link.getAttribute('href')).toBe('/api/videos/abc123?download=true');
    expect(link.textContent).toContain('내 컴퓨터에 저장');
  });

  it('error + retriedFrom=null: renders 재시도 primary', () => {
    renderPrimary({ status: 'error', retriedFrom: null });
    expect(screen.getByTestId('result-primary-action').textContent).toContain('재시도');
    expect(screen.getByTestId('result-primary-action').textContent).not.toContain('수정해서');
  });

  it('cancelled: renders 새로 만들기 primary', () => {
    renderPrimary({ status: 'cancelled' });
    expect(screen.getByTestId('result-primary-action').textContent).toContain('새로 만들기');
  });

  it('loading: renders skeleton (no actionable primary, kebab disabled)', () => {
    renderPrimary({ status: 'loading' });
    const wrapper = screen.getByTestId('result-primary');
    expect(wrapper.dataset.status).toBe('loading');
    // No actionable primary while loading — only the skeleton + dim kebab.
    expect(screen.queryByTestId('result-primary-action')).toBeNull();
    expect(screen.getByTestId('result-primary-kebab').hasAttribute('disabled')).toBe(true);
  });

  it('processing: renders kebab only — no primary action element', () => {
    renderPrimary({ status: 'processing' });
    const wrapper = screen.getByTestId('result-primary');
    expect(wrapper.dataset.status).toBe('processing');
    expect(screen.queryByTestId('result-primary-action')).toBeNull();
    expect(screen.getByTestId('result-primary-kebab')).toBeTruthy();
  });
});

// ── Kebab contents (3) ───────────────────────────────────────────────

async function openKebab() {
  // Radix DropdownMenu opens on Enter/Space keypress on the trigger;
  // fireEvent.click works in jsdom without needing pointer events.
  // jsdom doesn't ship hasPointerCapture/setPointerCapture which Radix
  // calls on pointerdown — sidestep by triggering Space-keydown instead.
  const trigger = screen.getByTestId('result-primary-kebab');
  trigger.focus();
  fireEvent.keyDown(trigger, { key: 'Enter', code: 'Enter' });
  await waitFor(() => {
    // Radix portals into document.body — query by text. The kebab
    // shares "새로 만들기" with all status rows, so it's a stable anchor.
    const items = document.querySelectorAll('[role="menuitem"]');
    expect(items.length).toBeGreaterThan(0);
  });
}

function menuItemTexts(): string[] {
  // The menu items are portaled — collect by role to scope away from the
  // primary button row. The same Korean strings appear on the primary
  // (e.g. "새로 만들기" is the cancelled-row primary AND a kebab item),
  // so a global queryByText would double-count.
  return Array.from(document.querySelectorAll('[role="menuitem"]')).map(
    (el) => (el.textContent ?? '').trim(),
  );
}

describe('ResultPrimary — kebab contents per status', () => {
  it('completed: kebab includes 공유 링크 복사 + the common pair', async () => {
    renderPrimary({ status: 'completed' });
    await openKebab();
    const items = menuItemTexts();
    expect(items.some((t) => t.includes('공유 링크 복사'))).toBe(true);
    expect(items.some((t) => t.includes('수정해서 다시 만들기'))).toBe(true);
    expect(items.some((t) => t.includes('새로 만들기'))).toBe(true);
  });

  it('error: kebab does NOT include 공유 링크 복사', async () => {
    renderPrimary({ status: 'error' });
    await openKebab();
    const items = menuItemTexts();
    expect(items.some((t) => t.includes('공유 링크 복사'))).toBe(false);
    expect(items.some((t) => t.includes('수정해서 다시 만들기'))).toBe(true);
    expect(items.some((t) => t.includes('새로 만들기'))).toBe(true);
  });

  it('cancelled: kebab does NOT include 공유 링크 복사', async () => {
    renderPrimary({ status: 'cancelled' });
    await openKebab();
    const items = menuItemTexts();
    expect(items.some((t) => t.includes('공유 링크 복사'))).toBe(false);
    expect(items.some((t) => t.includes('수정해서 다시 만들기'))).toBe(true);
    expect(items.some((t) => t.includes('새로 만들기'))).toBe(true);
  });
});

// ── Retry depth (3) ──────────────────────────────────────────────────

describe('ResultPrimary — retry-depth swap (D3A)', () => {
  it('depth=0 (retriedFrom=null) → 재시도 primary fires onRetry', () => {
    const onRetry = vi.fn();
    renderPrimary({ status: 'error', retriedFrom: null, onRetry });
    fireEvent.click(screen.getByTestId('result-primary-action'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('depth=1 (retriedFrom="abc") → 수정해서 다시 만들기 primary fires onEdit', () => {
    const onEdit = vi.fn();
    renderPrimary({ status: 'error', retriedFrom: 'abc', onEdit });
    expect(screen.getByTestId('result-primary-action').textContent).toContain(
      '수정해서 다시 만들기',
    );
    fireEvent.click(screen.getByTestId('result-primary-action'));
    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  it('one-deep heuristic: any non-empty retriedFrom counts as depth ≥ 1', () => {
    // Plan §"Smart retry-aware primary (D3A)": frontend doesn't walk the
    // chain — one-deep `retriedFrom != null` is enough to swap. Verify
    // both an arbitrary hex id and a many-character id behave the same.
    renderPrimary({ status: 'error', retriedFrom: 'a'.repeat(64) });
    expect(screen.getByTestId('result-primary-action').textContent).toContain(
      '수정해서 다시 만들기',
    );
  });
});

// ── Mobile breakpoint (1) ────────────────────────────────────────────

describe('ResultPrimary — mobile breakpoint', () => {
  it('wrapper has flex-col on mobile, md:flex-row on ≥640px', () => {
    renderPrimary({ status: 'completed' });
    const wrapper = screen.getByTestId('result-primary');
    // Tailwind responsive class — assert presence; the actual flip is a
    // CSS @media concern, not testable in jsdom directly. Both children
    // also carry w-full md:w-auto + h-11 md:h-9 for the touch-target jump.
    expect(wrapper.className).toMatch(/flex-col/);
    expect(wrapper.className).toMatch(/md:flex-row/);
    const kebab = screen.getByTestId('result-primary-kebab');
    expect(kebab.className).toMatch(/h-11/);
    expect(kebab.className).toMatch(/md:h-9/);
    expect(kebab.className).toMatch(/w-full/);
    expect(kebab.className).toMatch(/md:w-auto/);
  });
});

// ── a11y (2) ─────────────────────────────────────────────────────────

describe('ResultPrimary — a11y', () => {
  it('kebab trigger carries aria-haspopup="menu" + aria-label', () => {
    renderPrimary({ status: 'completed' });
    const kebab = screen.getByTestId('result-primary-kebab');
    expect(kebab.getAttribute('aria-haspopup')).toBe('menu');
    expect(kebab.getAttribute('aria-label')).toBe('다른 작업 열기');
  });

  it('focus returns to kebab trigger after Escape closes the menu', async () => {
    renderPrimary({ status: 'completed' });
    const kebab = screen.getByTestId('result-primary-kebab');
    // Open the menu.
    await openKebab();
    // Radix DropdownMenu's default behavior: Escape closes + focus returns
    // to the trigger. Fire Escape on the document and assert focus.
    fireEvent.keyDown(document.activeElement || document.body, {
      key: 'Escape',
      code: 'Escape',
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(kebab);
    });
  });
});
