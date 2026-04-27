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
    <div role="alert" className="p-8 max-w-[720px] mx-auto my-10 font-sans text-foreground">
      <h1 className="text-xl m-0 font-bold tracking-tight">잠깐, 문제가 발생했어요</h1>
      <p className="text-muted-foreground mt-2">
        화면을 그리는 중에 오류가 났어요. 대부분 일시적인 문제라 재시도하면 복구됩니다.
        계속 같은 오류가 보이면 저장된 상태가 새 버전과 호환되지 않을 수 있으니 초기화 후
        다시 시작해주세요.
      </p>
      <div className="flex gap-2 mt-4">
        <button
          onClick={resetErrorBoundary}
          className="px-3.5 py-2.5 bg-foreground text-background rounded-lg cursor-pointer text-sm-tight font-semibold border-0 hover:bg-foreground/90"
        >
          재시도
        </button>
        <button
          onClick={wipeAndReload}
          className="px-3.5 py-2.5 bg-card text-foreground border border-border rounded-lg cursor-pointer text-sm-tight font-medium hover:bg-muted"
        >
          저장된 상태 지우고 새로고침
        </button>
      </div>
      <details className="mt-6">
        <summary className="cursor-pointer text-muted-foreground text-xs">기술 상세 보기</summary>
        <pre className="mt-2 p-3 bg-muted border border-border rounded-md text-xs overflow-auto whitespace-pre-wrap">
          {String((error as Error)?.stack || (error as Error)?.message || error)}
        </pre>
      </details>
    </div>
  );
}
