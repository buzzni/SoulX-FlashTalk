/**
 * Lane D — AutoSaveIndicator unit tests.
 *
 * Verifies:
 *  - renders nothing when lastSavedAt is null (fresh wizard)
 *  - reads from the wizard store and formats relative time
 *  - updates the displayed string on store updates without remount
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import { AutoSaveIndicator } from '../auto-save-indicator';
import { useWizardStore, INITIAL_WIZARD_STATE } from '../../stores/wizardStore';

beforeEach(() => {
  useWizardStore.setState(INITIAL_WIZARD_STATE, false);
});

afterEach(() => {
  cleanup();
});

describe('AutoSaveIndicator', () => {
  it('renders nothing when lastSavedAt is null', () => {
    render(<AutoSaveIndicator />);
    expect(screen.queryByTestId('auto-save-indicator')).toBeNull();
  });

  it('shows "방금 전 저장됨" right after a slice write', () => {
    render(<AutoSaveIndicator />);
    act(() => {
      useWizardStore.getState().touchLastSavedAt();
    });
    expect(screen.getByTestId('auto-save-indicator')).toBeTruthy();
    expect(screen.getByTestId('auto-save-indicator').textContent).toContain('방금 전 저장됨');
  });

  it('shows "30초 전 저장됨" when stamped 30s ago', () => {
    useWizardStore.setState(
      { ...INITIAL_WIZARD_STATE, lastSavedAt: Date.now() - 30_000 },
      false,
    );
    render(<AutoSaveIndicator />);
    expect(screen.getByTestId('auto-save-indicator').textContent).toContain('30초 전 저장됨');
  });

  it('shows "5분 전 저장됨" at 5 minutes', () => {
    useWizardStore.setState(
      { ...INITIAL_WIZARD_STATE, lastSavedAt: Date.now() - 5 * 60_000 },
      false,
    );
    render(<AutoSaveIndicator />);
    expect(screen.getByTestId('auto-save-indicator').textContent).toContain('5분 전 저장됨');
  });
});
