/**
 * QueueTrigger — the "작업" pill in the header.
 *
 * Disabled while the queue snapshot hasn't landed yet (instead of
 * hiding, which caused a visible flicker every time the header
 * re-mounted between wizard and render views).
 *
 * Badge turns accent-color when at least one task is running/pending.
 */
import Icon from '../Icon.jsx';

export interface QueueTriggerProps {
  loading: boolean;
  totalActive: number;
  onClick: () => void;
}

export function QueueTrigger({ loading, totalActive, onClick }: QueueTriggerProps) {
  return (
    <button
      type="button"
      onClick={() => {
        if (!loading) onClick();
      }}
      disabled={loading}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '6px 10px',
        background: totalActive > 0 ? 'var(--accent)' : 'var(--bg-elev)',
        color: totalActive > 0 ? '#fff' : 'var(--text-secondary)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--r-sm)',
        fontSize: 12,
        fontWeight: 500,
        cursor: loading ? 'wait' : 'pointer',
        opacity: loading ? 0.6 : 1,
        boxShadow: 'var(--shadow-sm)',
      }}
      title={loading ? '작업 목록 불러오는 중…' : '작업 목록 보기'}
    >
      <Icon name="settings" size={12} />
      작업
      {totalActive > 0 && (
        <span
          style={{
            background: 'rgba(255,255,255,0.25)',
            borderRadius: 99,
            padding: '0 6px',
            fontSize: 10,
            fontWeight: 700,
          }}
        >
          {totalActive}
        </span>
      )}
    </button>
  );
}
