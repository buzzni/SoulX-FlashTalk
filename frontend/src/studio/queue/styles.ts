/**
 * Shared inline style constants for the queue panel rows.
 *
 * Note on min-width:0 sprinkled through these: CSS Grid's `1fr` track
 * has an implicit min-width:auto that expands to the longest
 * descendant. Long task labels (queue_label can hit 80 chars) would
 * push each row past the 340px panel width and produce horizontal
 * scroll. min-width:0 + overflow:hidden on grid items lets `truncate`
 * (text-overflow: ellipsis) actually clip.
 */

import type { CSSProperties } from 'react';

export const sectionStyle: CSSProperties = { marginTop: 10 };

export const sectionHeaderStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: 'var(--text-tertiary)',
  textTransform: 'uppercase',
  letterSpacing: 0.04,
  marginBottom: 6,
};

export const itemStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) auto',
  gap: 8,
  padding: '8px 10px',
  background: 'var(--bg-sunken)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--r-sm)',
  fontSize: 12,
  marginBottom: 4,
  minWidth: 0,
  overflow: 'hidden',
};

// Live row layout: clickable body + (optional) cancel button. Using a
// wrapping <div> instead of nesting buttons (HTML doesn't allow
// <button> inside <button>) — the body is a button, the cancel is a
// sibling.
export const liveRowWrapperStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) auto',
  gap: 6,
  alignItems: 'stretch',
  marginBottom: 4,
  minWidth: 0,
};

export const liveItemButtonStyle: CSSProperties = {
  ...itemStyle,
  width: '100%',
  cursor: 'pointer',
  color: 'inherit',
  fontFamily: 'inherit',
  fontSize: 12,
  textAlign: 'left',
  marginBottom: 0,
  minWidth: 0,
};

export function cancelBtnStyle(enabled: boolean): CSSProperties {
  return {
    width: 28,
    background: 'var(--bg-sunken)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--r-sm)',
    cursor: enabled ? 'pointer' : 'not-allowed',
    color: enabled ? 'var(--text-secondary)' : 'var(--text-tertiary)',
    display: 'grid',
    placeItems: 'center',
    padding: 0,
  };
}
