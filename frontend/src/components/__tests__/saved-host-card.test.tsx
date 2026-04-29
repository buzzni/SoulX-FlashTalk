/**
 * SavedHostCard unit tests — eng-review T14.
 *
 * Covers basic render, selected ring, showActions menu (rename/delete
 * trigger handlers), keyboard activation, and broken-image fallback.
 *
 * @vitest-environment jsdom
 */

import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SavedHostCard } from '../saved-host-card';
import type { SavedHost } from '../../api/queries/use-saved-hosts';

const HOST: SavedHost = {
  id: 'host-1',
  name: '민지',
  key: 'outputs/hosts/saved/host-1.png',
  url: '/api/files/outputs/hosts/saved/host-1.png',
  created_at: '2026-04-29T12:00:00+00:00',
  updated_at: null,
  deleted_at: null,
  meta: null,
  face_ref_for_variation: 'outputs/hosts/saved/host-1.png',
};

describe('SavedHostCard', () => {
  it('renders name + image', () => {
    render(<SavedHostCard host={HOST} />);
    expect(screen.getByText('민지')).toBeTruthy();
    const img = screen.getByAltText('민지') as HTMLImageElement;
    expect(img.src).toContain('host-1.png');
  });

  it('fires onClick when card clicked', () => {
    const onClick = vi.fn();
    render(<SavedHostCard host={HOST} onClick={onClick} />);
    fireEvent.click(screen.getByTestId('saved-host-card'));
    expect(onClick).toHaveBeenCalledWith(HOST);
  });

  it('keyboard Enter activates card when clickable', () => {
    const onClick = vi.fn();
    render(<SavedHostCard host={HOST} onClick={onClick} />);
    fireEvent.keyDown(screen.getByTestId('saved-host-card'), { key: 'Enter' });
    expect(onClick).toHaveBeenCalled();
  });

  it('hides ⋯ menu when showActions=false', () => {
    render(<SavedHostCard host={HOST} />);
    expect(screen.queryByTestId('saved-host-card-menu')).toBeNull();
  });

  it('renders ⋯ menu when showActions=true and either handler given', () => {
    render(<SavedHostCard host={HOST} showActions onRename={vi.fn()} onDelete={vi.fn()} />);
    expect(screen.getByTestId('saved-host-card-menu')).toBeTruthy();
  });

  // Radix DropdownMenu opens via PointerEvent sequence which jsdom
  // doesn't fully support — skip the open-then-click-item assertion
  // here and verify menu wiring at the integration/E2E layer (PR2).
  // The trigger's existence (covered above) is enough for the unit
  // contract: SavedHostCard exposes the menu when handlers are given.

  it('menu click does not bubble to card onClick', () => {
    const onClick = vi.fn();
    const onRename = vi.fn();
    render(
      <SavedHostCard
        host={HOST}
        showActions
        onClick={onClick}
        onRename={onRename}
        onDelete={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('saved-host-card-menu'));
    expect(onClick).not.toHaveBeenCalled();
  });

  it('falls back to placeholder icon when image fails', () => {
    render(<SavedHostCard host={HOST} />);
    const img = screen.getByAltText('민지');
    fireEvent.error(img);
    // After error, the <img> is unmounted in favor of the placeholder grid.
    expect(screen.queryByAltText('민지')).toBeNull();
  });

  it('renders selected ring class', () => {
    const { container } = render(<SavedHostCard host={HOST} selected />);
    const card = container.querySelector('[data-testid="saved-host-card"]');
    expect(card?.className).toMatch(/border-primary/);
  });
});
