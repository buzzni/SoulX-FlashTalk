/**
 * Top-level error fallback — wired in main.jsx via react-error-boundary.
 *
 * Catches render-time crashes that escape every other boundary. Offers a
 * single "재시도" affordance (resets the boundary) and an optional state
 * wipe for users whose persisted blob is incompatible with a new schema
 * version.
 *
 * Per-step boundaries (Lane G) handle softer per-page recoveries; this
 * fallback is the last line before a white screen.
 */

import type { FallbackProps } from 'react-error-boundary';
import { allOwnedStorageKeys } from '../stores/storageKey';

export function TopLevelErrorFallback({ error, resetErrorBoundary }: FallbackProps) {
  const wipeAndReload = () => {
    try {
      for (const key of allOwnedStorageKeys()) {
        localStorage.removeItem(key);
      }
      localStorage.removeItem('showhost_density');
    } catch {
      /* ignore */
    }
    window.location.reload();
  };

  return (
    <div
      role="alert"
      style={{
        padding: 32,
        maxWidth: 720,
        margin: '40px auto',
        fontFamily: 'Pretendard, -apple-system, sans-serif',
        color: '#333',
      }}
    >
      <h1 style={{ fontSize: 20, margin: 0 }}>잠깐, 문제가 발생했어요</h1>
      <p style={{ color: '#666', marginTop: 8 }}>
        화면을 그리는 중에 오류가 났어요. 대부분 일시적인 문제라 재시도하면 복구됩니다.
        계속 같은 오류가 보이면 저장된 상태가 새 버전과 호환되지 않을 수 있으니 초기화 후
        다시 시작해주세요.
      </p>
      <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
        <button
          onClick={resetErrorBoundary}
          style={{
            padding: '10px 14px',
            background: '#222',
            color: '#fff',
            border: 0,
            borderRadius: 8,
            cursor: 'pointer',
            fontSize: 13,
          }}
        >
          재시도
        </button>
        <button
          onClick={wipeAndReload}
          style={{
            padding: '10px 14px',
            background: '#fff',
            color: '#222',
            border: '1px solid #ddd',
            borderRadius: 8,
            cursor: 'pointer',
            fontSize: 13,
          }}
        >
          저장된 상태 지우고 새로고침
        </button>
      </div>
      <details style={{ marginTop: 24 }}>
        <summary style={{ cursor: 'pointer', color: '#666', fontSize: 12 }}>
          기술 상세 보기
        </summary>
        <pre
          style={{
            marginTop: 8,
            padding: 12,
            background: '#f6f6f6',
            border: '1px solid #ddd',
            borderRadius: 6,
            fontSize: 12,
            overflow: 'auto',
            whiteSpace: 'pre-wrap',
          }}
        >
          {String((error as Error)?.stack || (error as Error)?.message || error)}
        </pre>
      </details>
    </div>
  );
}
